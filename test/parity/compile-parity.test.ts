import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { normalizeReport } from "./normalize-report.js";
import { type ReplayServer, startReplayServer } from "./replay-server.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const assets = resolve(root, "packages/core/assets");
const wasmPath = resolve(assets, "engine_bg.wasm");
const jsPath = resolve(assets, "engine.js");
const nativePath = resolve(
  root,
  "vendor/uv/target/debug",
  process.platform === "win32" ? "uv.exe" : "uv",
);
const fixtures = resolve(root, "test/fixtures");

const SCENARIOS = [
  "pure-python",
  "markers",
  "transitive",
  "universal",
  "pyodide-wheel",
  "stdin",
  "extras",
  "hashes",
] as const;

const available = SCENARIOS.filter((name) => existsSync(resolve(fixtures, name, "snapshot.json")));
const hasEngine = existsSync(wasmPath) && existsSync(jsPath);
const hasNative = existsSync(nativePath);
const canCompare = hasEngine && available.length > 0;

if (process.env.CI && !canCompare) {
  throw new Error(
    "the compile matrix cannot run: the engine artifact or the recorded fixtures are missing. " +
      "Skipping here would report a gate that never ran.",
  );
}

const PROGRAM = basename(nativePath);

interface EngineInstance {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  fsMkdirp(path: string): void;
  fsWrite(path: string, contents: Uint8Array): void;
  setStdin(bytes: Uint8Array): void;
  clearStdin(): void;
  envReplace(entries: string[]): void;
}

interface EngineModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  Engine: new () => EngineInstance;
}

interface Variant {
  name: string;
  args: string[];
  expected: string;
  expectedReport?: string;
}

interface Snapshot {
  requirements: string[];
  args: string[];
  expected?: string;
  expectedReport?: string;
  variants?: Variant[];
  recordedFrom?: string;
  failing?: boolean;
}

interface Case {
  scenario: string;
  label: string;
  extra: string[];
  expected: string | undefined;
  report: string | undefined;
}

const read = (name: string): Snapshot =>
  JSON.parse(readFileSync(resolve(fixtures, name, "snapshot.json"), "utf8")) as Snapshot;

const snapshots = new Map<string, Snapshot>(available.map((name) => [name, read(name)]));

const cases: Case[] = available.flatMap((name): Case[] => {
  const snapshot = snapshots.get(name) as Snapshot;
  return [
    {
      scenario: name,
      label: name,
      extra: [],
      expected: snapshot.expected,
      report: snapshot.expectedReport,
    },
    ...(snapshot.variants ?? []).map((variant) => ({
      scenario: name,
      label: `${name} ${variant.name}`,
      extra: variant.args,
      expected: variant.expected,
      report: variant.expectedReport,
    })),
  ];
});

interface NativeRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runNative(args: string[], stdin?: string): Promise<NativeRun> {
  return new Promise((done, fail) => {
    const child = spawn(nativePath, args);
    if (stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(stdin);
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", fail);
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

describe.skipIf(!canCompare)("uv pip compile matches native against one frozen index", () => {
  let engine: EngineInstance;
  let workspace: string;

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as EngineModule;
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    engine = new mod.Engine();
    workspace = mkdtempSync(join(tmpdir(), "uv-wasm-compile-"));
  }, 180_000);

  afterAll(() => {
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  for (const entry of cases) {
    it(`resolves \`${entry.label}\` to the same output as native uv`, async () => {
      const name = entry.scenario;
      const dir = resolve(fixtures, name);
      const snapshot = snapshots.get(name) as Snapshot;
      const requirements = `${snapshot.requirements.join("\n")}\n`;

      let server: ReplayServer | undefined;
      try {
        server = await startReplayServer(dir);
        const args = (directory: string): string[] => [
          ...snapshot.args,
          "--index-url",
          `${server?.origin}/simple`,
          ...entry.extra,
          "--directory",
          directory,
        ];

        const piped = snapshot.args.includes("-") ? requirements : undefined;

        let live: NativeRun | undefined;
        if (hasNative) {
          writeFileSync(join(workspace, "requirements.in"), requirements);
          live = await runNative(args(workspace), piped);
          expect(live.status, `native uv failed: ${live.stderr}`).toBe(0);
        }

        engine.fsMkdirp(`/${name}`);
        engine.fsWrite(`/${name}/requirements.in`, new TextEncoder().encode(requirements));
        if (piped === undefined) {
          engine.clearStdin();
        } else {
          engine.setStdin(new TextEncoder().encode(piped));
        }
        let browserOut = "";
        let browserErr = "";
        const decoder = new TextDecoder();
        const code = await engine.invoke([PROGRAM, ...args(`/${name}`)], (stream, data) => {
          if (stream === "stdout") {
            browserOut += decoder.decode(data);
          } else {
            browserErr += decoder.decode(data);
          }
        });
        expect(code, `the engine failed: ${browserErr}`).toBe(0);

        expect(
          server.requested.length,
          "neither side reached the index, so this comparison proves nothing",
        ).toBeGreaterThan(0);
        expect(
          server.misses,
          "one of the two sides asked for something the snapshot does not hold; re-record it",
        ).toEqual([]);

        const golden = entry.expected;
        expect(
          golden,
          `${entry.label} was recorded before goldens existed; re-record it`,
        ).toBeDefined();
        expect(
          golden?.length,
          "the recorded golden is empty, so it would agree with anything",
        ).toBeGreaterThan(0);
        expect(browserOut).toBe(golden);
        if (live) {
          expect(live.stdout, "the live binary disagrees with the golden; re-record").toBe(golden);
        }

        if (entry.report !== undefined) {
          expect(normalizeReport(browserErr)).toBe(normalizeReport(entry.report));
          if (live) {
            expect(
              normalizeReport(live.stderr),
              "the live binary reports differently from the golden; re-record",
            ).toBe(normalizeReport(entry.report));
          }
        }
      } finally {
        await server?.close();
      }
    }, 180_000);
  }

  it.skipIf(!existsSync(resolve(fixtures, "conflicts", "snapshot.json")))(
    "reports an unsatisfiable resolution in native uv's exact words",
    async () => {
      const dir = resolve(fixtures, "conflicts");
      const snapshot = JSON.parse(
        await readFile(resolve(dir, "snapshot.json"), "utf8"),
      ) as Snapshot;
      const requirements = `${snapshot.requirements.join("\n")}\n`;

      let server: ReplayServer | undefined;
      try {
        server = await startReplayServer(dir);
        const args = (directory: string): string[] => [
          ...snapshot.args,
          "--index-url",
          `${server?.origin}/simple`,
          "--directory",
          directory,
        ];

        let live: NativeRun | undefined;
        if (hasNative) {
          writeFileSync(join(workspace, "requirements.in"), requirements);
          live = await runNative(args(workspace));
          expect(live.status, "the conflict fixture should not resolve").not.toBe(0);
        }

        engine.fsMkdirp("/conflicts");
        engine.fsWrite("/conflicts/requirements.in", new TextEncoder().encode(requirements));
        let browserErr = "";
        const decoder = new TextDecoder();
        const code = await engine.invoke([PROGRAM, ...args("/conflicts")], (stream, data) => {
          if (stream !== "stdout") {
            browserErr += decoder.decode(data);
          }
        });

        expect(server.misses, "the hand-authored snapshot is missing a response").toEqual([]);
        expect(
          server.requested.length,
          "neither side reached the index, so this comparison proves nothing",
        ).toBeGreaterThan(0);

        const golden = snapshot.expected;
        expect(golden, "the conflict fixture carries no golden; regenerate it").toBeDefined();
        expect(golden).toContain("No solution found");
        expect(code).not.toBe(0);
        expect(browserErr).toBe(golden);
        if (live) {
          expect(live.stderr, "the live binary disagrees with the golden; regenerate").toBe(golden);
          expect(code).toBe(live.status);
        }
      } finally {
        await server?.close();
      }
    },
    180_000,
  );

  it("refuses to read standard input the host never supplied", async () => {
    const name = available[0] as string;
    const dir = resolve(fixtures, name);
    const snapshot = JSON.parse(await readFile(resolve(dir, "snapshot.json"), "utf8")) as Snapshot;

    engine.clearStdin();
    engine.fsMkdirp("/no-stdin");
    let browserErr = "";
    const decoder = new TextDecoder();
    const code = await engine.invoke(
      [
        PROGRAM,
        ...snapshot.args.map((arg) => (arg === "requirements.in" ? "-" : arg)),
        "--directory",
        "/no-stdin",
      ],
      (stream, data) => {
        if (stream !== "stdout") {
          browserErr += decoder.decode(data);
        }
      },
    );

    expect(code).not.toBe(0);
    expect(browserErr).toContain("standard input");
  }, 180_000);

  it("resolves against an index named only by the environment", async () => {
    const name = available[0] as string;
    const dir = resolve(fixtures, name);
    const snapshot = JSON.parse(await readFile(resolve(dir, "snapshot.json"), "utf8")) as Snapshot;
    const requirements = `${snapshot.requirements.join("\n")}\n`;

    let server: ReplayServer | undefined;
    try {
      server = await startReplayServer(dir);
      engine.envReplace(["UV_DEFAULT_INDEX", `${server.origin}/simple`]);
      engine.clearStdin();
      engine.fsMkdirp("/env-index");
      engine.fsWrite("/env-index/requirements.in", new TextEncoder().encode(requirements));

      let browserOut = "";
      let browserErr = "";
      const decoder = new TextDecoder();
      const args = [...snapshot.args, "--directory", "/env-index"];
      const code = await engine.invoke([PROGRAM, ...args], (stream, data) => {
        if (stream === "stdout") {
          browserOut += decoder.decode(data);
        } else {
          browserErr += decoder.decode(data);
        }
      });

      expect(code, `the engine failed: ${browserErr}`).toBe(0);
      expect(
        server.requested.length,
        "nothing reached the index, so the environment was not what uv resolved against",
      ).toBeGreaterThan(0);
      expect(server.misses, "the environment reached an index the snapshot does not hold").toEqual(
        [],
      );
      expect(browserOut).toBe(snapshot.expected);
    } finally {
      engine.envReplace([]);
      await server?.close();
    }
  }, 180_000);

  it("retries a failing index request rather than aborting the worker", async () => {
    const name = available[0] as string;
    const dir = resolve(fixtures, name);
    const snapshot = JSON.parse(await readFile(resolve(dir, "snapshot.json"), "utf8")) as Snapshot;

    let server: ReplayServer | undefined;
    try {
      server = await startReplayServer(dir, { failFirst: 1 });
      engine.fsMkdirp("/retry");
      engine.fsWrite(
        "/retry/requirements.in",
        new TextEncoder().encode(`${snapshot.requirements.join("\n")}\n`),
      );

      let browserErr = "";
      const decoder = new TextDecoder();
      const code = await engine.invoke(
        [
          PROGRAM,
          ...snapshot.args,
          "--index-url",
          `${server.origin}/simple`,
          "--directory",
          "/retry",
        ],
        (stream, data) => {
          if (stream !== "stdout") {
            browserErr += decoder.decode(data);
          }
        },
      );

      expect(
        server.rejected.length,
        "the server should have refused at least once",
      ).toBeGreaterThan(0);
      expect(code, `the engine failed instead of retrying: ${browserErr}`).toBe(0);
    } finally {
      await server?.close();
    }
  }, 180_000);
});
