import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { jsPath, PROGRAM, root, wasmPath } from "./cli-goldens.js";
import { type ReplayServer, startReplayServer } from "./replay-server.js";

const fixture = resolve(root, "test/fixtures/install");
const snapshotPath = resolve(fixture, "snapshot.json");

const hasEngine = existsSync(wasmPath) && existsSync(jsPath);
const hasFixture = existsSync(snapshotPath);
const canCompare = hasEngine && hasFixture;

if (process.env.CI && !canCompare) {
  throw new Error(
    "the install gate cannot run: the engine artifact or the install fixture is missing. " +
      "Skipping here would report a gate that never ran.",
  );
}

interface EngineInstance {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  fsRead(path: string): Uint8Array;
  fsReadDir(path: string): string[];
  fsMkdirp(path: string): void;
  fsExists(path: string): boolean;
  clearStdin(): void;
}

interface EngineModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  Engine: new () => EngineInstance;
}

interface Snapshot {
  requirements: string[];
  args: string[];
  command?: string;
  expectedReport?: string;
}

const DURATION = /\bin \d+(?:\.\d+)?(?:ms|s)\b/g;
const ENVIRONMENT = /^Using Python .*$/gm;

function normalize(text: string): string {
  return text.replace(DURATION, "in <DURATION>").replace(ENVIRONMENT, "Using Python <ENVIRONMENT>");
}

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

describe.skipIf(!canCompare)("uv pip install lands a wheel in the virtual filesystem", () => {
  let engine: EngineInstance;
  let snapshot: Snapshot;
  const venv = "/install/.venv";
  const sitePackages = `${venv}/lib/python3.14/site-packages`;

  let installed: { code: number; stderr: string };
  let server: ReplayServer | undefined;

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as EngineModule;
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    engine = new mod.Engine();
    snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as Snapshot;

    server = await startReplayServer(fixture);
    engine.clearStdin();
    engine.fsMkdirp("/install");

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

    const created = await run(["venv", venv, "--python", "/bin/python3"]);
    expect(created.code, `the engine could not create a venv: ${created.stderr}`).toBe(0);

    installed = await run([
      ...snapshot.args,
      "--index-url",
      `${server.origin}/simple`,
      "--python",
      venv,
    ]);
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
    expect(golden, "the install fixture carries no golden; re-record it").toBeDefined();
    expect(golden).toContain("+ idna==3.11");
    expect(normalize(installed.stderr)).toBe(normalize(golden as string));
  });

  it("unpacks the distribution into site-packages", () => {
    const entries = engine.fsReadDir(sitePackages);
    expect(entries).toContain("idna");
    expect(entries).toContain("idna-3.11.dist-info");
  });

  it("writes a RECORD every entry of which is in the filesystem at the recorded hash", () => {
    const record = new TextDecoder().decode(
      engine.fsRead(`${sitePackages}/idna-3.11.dist-info/RECORD`),
    );
    const entries = parseRecord(record);
    expect(entries.length, "RECORD is empty, so this check would pass on nothing").toBeGreaterThan(
      3,
    );

    const checked: string[] = [];
    for (const entry of entries) {
      if (entry.hash === "") {
        continue;
      }
      const path = `${sitePackages}/${entry.path}`;
      expect(engine.fsExists(path), `RECORD names ${entry.path}, which is not installed`).toBe(
        true,
      );

      const bytes = engine.fsRead(path);
      const digest = createHash("sha256").update(bytes).digest("base64url").replace(/=+$/, "");
      expect(entry.hash, `RECORD's hash for ${entry.path} is not sha256`).toBe(`sha256=${digest}`);
      expect(String(bytes.byteLength), `RECORD's size for ${entry.path} is wrong`).toBe(entry.size);
      checked.push(entry.path);
    }

    expect(
      checked.length,
      "no RECORD entry carried a hash, so nothing was verified",
    ).toBeGreaterThan(3);
  });

  it("records itself as installed, so a second install is a no-op", async () => {
    let stderr = "";
    const decoder = new TextDecoder();
    const again = await startReplayServer(fixture);
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
  }, 300_000);
});
