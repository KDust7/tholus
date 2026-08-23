import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { jsPath, PROGRAM, root, wasmPath } from "./cli-goldens.js";
import { normalizeReport } from "./normalize-report.js";
import { type ReplayServer, startReplayServer } from "./replay-server.js";

interface Scenario {
  name: string;
  distribution: string;
  distInfo: string;
  contains?: string;
  requirementsFile?: string;
  intoTarget: boolean;
  reinstallIsNoop: boolean;
  hasFollowUps: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "install",
    distribution: "idna",
    distInfo: "idna-3.11.dist-info",
    intoTarget: false,
    reinstallIsNoop: true,
    hasFollowUps: true,
  },
  {
    name: "sync",
    distribution: "idna",
    distInfo: "idna-3.11.dist-info",
    requirementsFile: "idna==3.11\n",
    intoTarget: false,
    reinstallIsNoop: false,
    hasFollowUps: false,
  },
  {
    name: "install-transitive",
    distribution: "requests",
    distInfo: "requests-2.32.3.dist-info",
    intoTarget: false,
    reinstallIsNoop: true,
    hasFollowUps: true,
  },
  {
    name: "install-pyodide",
    distribution: "msgpack",
    distInfo: "msgpack-1.1.2.dist-info",
    contains: "_cmsgpack.cpython-314-wasm32-emscripten.so",
    intoTarget: true,
    reinstallIsNoop: false,
    hasFollowUps: false,
  },
];

const hasEngine = existsSync(wasmPath) && existsSync(jsPath);
const fixtureOf = (name: string): string => resolve(root, "test/fixtures", name);
const available = SCENARIOS.filter((scenario) =>
  existsSync(resolve(fixtureOf(scenario.name), "snapshot.json")),
);
const canCompare = hasEngine && available.length === SCENARIOS.length;

if (process.env.CI && !canCompare) {
  throw new Error(
    "the install gate cannot run: the engine artifact or an install fixture is missing. " +
      "Skipping here would report a gate that never ran.",
  );
}

interface EngineInstance {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  fsRead(path: string): Uint8Array;
  fsReadDir(path: string): string[];
  fsMkdirp(path: string): void;
  fsWrite(path: string, contents: Uint8Array): void;
  fsExists(path: string): boolean;
  clearStdin(): void;
}

interface EngineModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  Engine: new () => EngineInstance;
}

interface FollowUp {
  args: string[];
  status: number;
  stdout: string;
  stderr: string;
}

interface Snapshot {
  args: string[];
  expectedReport?: string;
  followUps?: FollowUp[];
}

const normalize = normalizeReport;

interface RecordEntry {
  path: string;
  hash: string;
  size: string;
}

function parseRecord(text: string): RecordEntry[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [path, hash, size] = line.split(",");
      return { path: path ?? "", hash: hash ?? "", size: size ?? "" };
    });
}

let enginePromise: Promise<EngineInstance> | undefined;

async function sharedEngine(): Promise<EngineInstance> {
  enginePromise ??= (async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as EngineModule;
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    return new mod.Engine();
  })();
  return enginePromise;
}

for (const scenario of SCENARIOS) {
  describe.skipIf(!canCompare)(`uv pip install lands \`${scenario.name}\` in the vfs`, () => {
    let engine: EngineInstance;
    let snapshot: Snapshot;
    let installed: { code: number; stderr: string };
    let server: ReplayServer | undefined;
    let siteDir: string;

    const home = `/${scenario.name}`;
    const venv = `${home}/.venv`;

    beforeAll(async () => {
      engine = await sharedEngine();
      snapshot = JSON.parse(
        await readFile(resolve(fixtureOf(scenario.name), "snapshot.json"), "utf8"),
      ) as Snapshot;

      server = await startReplayServer(fixtureOf(scenario.name));
      engine.clearStdin();
      engine.fsMkdirp(home);

      const run = async (args: string[]): Promise<{ code: number; stderr: string }> => {
        let stderr = "";
        const decoder = new TextDecoder();
        const code = await engine.invoke([PROGRAM, ...args], (stream, data) => {
          if (stream !== "stdout") {
            stderr += decoder.decode(data);
          }
        });
        return { code, stderr };
      };

      if (scenario.requirementsFile !== undefined) {
        engine.fsWrite(
          `${home}/requirements.in`,
          new TextEncoder().encode(scenario.requirementsFile),
        );
      }

      const where: string[] = [];
      if (scenario.intoTarget) {
        siteDir = `${home}/target`;
        where.push("--target", siteDir);
      } else {
        const created = await run(["venv", venv, "--python", "/bin/python3"]);
        expect(created.code, `the engine could not create a venv: ${created.stderr}`).toBe(0);
        siteDir = `${venv}/lib/python3.14/site-packages`;
        where.push("--python", venv);
        if (scenario.requirementsFile !== undefined) {
          where.push("--directory", home);
        }
      }

      installed = await run([...snapshot.args, "--index-url", `${server.origin}/simple`, ...where]);
      await server.close();
    }, 300_000);

    it("installs the package", () => {
      expect(installed.code, `the install failed: ${installed.stderr}`).toBe(0);
    });

    it("reaches the index rather than resolving from nothing", () => {
      expect(server?.requested.length ?? 0).toBeGreaterThan(0);
      expect(server?.misses, "the install asked for something the snapshot does not hold").toEqual(
        [],
      );
    });

    it("reports the install in native uv's words", () => {
      const golden = snapshot.expectedReport;
      expect(golden, "the fixture carries no golden; re-record it").toBeDefined();
      expect(golden).toContain(`+ ${scenario.distribution}==`);
      expect(normalize(installed.stderr)).toBe(normalize(golden as string));
    });

    it("unpacks the distribution", () => {
      const entries = engine.fsReadDir(siteDir);
      expect(entries).toContain(scenario.distribution);
      expect(entries).toContain(scenario.distInfo);
    });

    it.skipIf(scenario.contains === undefined)("keeps the compiled extension module", () => {
      expect(engine.fsReadDir(`${siteDir}/${scenario.distribution}`)).toContain(
        scenario.contains as string,
      );
    });

    it("writes a RECORD every entry of which is installed at the recorded hash", () => {
      const record = new TextDecoder().decode(
        engine.fsRead(`${siteDir}/${scenario.distInfo}/RECORD`),
      );
      const entries = parseRecord(record);
      expect(
        entries.length,
        "RECORD is empty, so this check would pass on nothing",
      ).toBeGreaterThan(3);

      const checked: string[] = [];
      for (const entry of entries) {
        if (entry.hash === "") {
          continue;
        }
        const path = `${siteDir}/${entry.path}`;
        expect(engine.fsExists(path), `RECORD names ${entry.path}, which is not installed`).toBe(
          true,
        );

        const bytes = engine.fsRead(path);
        const digest = createHash("sha256").update(bytes).digest("base64url").replace(/=+$/, "");
        expect(entry.hash, `RECORD's hash for ${entry.path} is wrong`).toBe(`sha256=${digest}`);
        expect(String(bytes.byteLength), `RECORD's size for ${entry.path} is wrong`).toBe(
          entry.size,
        );
        checked.push(entry.path);
      }

      expect(
        checked.length,
        "no RECORD entry carried a hash, so nothing was verified",
      ).toBeGreaterThan(3);
    });

    it.skipIf(!scenario.reinstallIsNoop)(
      "records itself installed, so a second install is a no-op",
      async () => {
        let stderr = "";
        const decoder = new TextDecoder();
        const again = await startReplayServer(fixtureOf(scenario.name));
        try {
          const code = await engine.invoke(
            [PROGRAM, ...snapshot.args, "--index-url", `${again.origin}/simple`, "--python", venv],
            (stream, data) => {
              if (stream !== "stdout") {
                stderr += decoder.decode(data);
              }
            },
          );
          expect(code, `the second install failed: ${stderr}`).toBe(0);
          expect(stderr).toContain("Checked 1 package");
          expect(stderr, "the second install unpacked the wheel again").not.toContain("Installed");
        } finally {
          await again.close();
        }
      },
      300_000,
    );

    it.skipIf(!scenario.hasFollowUps)(
      "answers the rest of the pip command matrix as native uv does",
      async () => {
        const recorded = snapshot.followUps ?? [];
        expect(
          recorded.length,
          "the fixture recorded no follow-up commands; re-record it",
        ).toBeGreaterThan(3);

        for (const followUp of recorded) {
          let stdout = "";
          let stderr = "";
          const decoder = new TextDecoder();
          const code = await engine.invoke(
            [PROGRAM, ...followUp.args, "--python", venv],
            (stream, data) => {
              if (stream === "stdout") {
                stdout += decoder.decode(data);
              } else {
                stderr += decoder.decode(data);
              }
            },
          );
          const where = `uv ${followUp.args.join(" ")}`;
          expect(code, `${where} exited differently: ${stderr}`).toBe(followUp.status);
          expect(normalize(stdout), `${where} printed something else`).toBe(
            normalize(followUp.stdout),
          );
          expect(normalize(stderr), `${where} reported something else`).toBe(
            normalize(followUp.stderr),
          );
        }
      },
      300_000,
    );
  });
}
