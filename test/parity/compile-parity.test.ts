import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

const SCENARIOS = ["pure-python", "markers", "transitive", "universal"] as const;

const available = SCENARIOS.filter((name) => existsSync(resolve(fixtures, name, "snapshot.json")));
const canCompare =
  existsSync(wasmPath) && existsSync(jsPath) && existsSync(nativePath) && available.length > 0;

const PROGRAM = basename(nativePath);

interface EngineInstance {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  fsMkdirp(path: string): void;
  fsWrite(path: string, contents: Uint8Array): void;
}

interface EngineModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  Engine: new () => EngineInstance;
}

interface Snapshot {
  requirements: string[];
  args: string[];
}

interface NativeRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runNative(args: string[]): Promise<NativeRun> {
  return new Promise((done, fail) => {
    const child = spawn(nativePath, args);
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

  for (const name of available) {
    it(`resolves \`${name}\` to the same output as native uv`, async () => {
      const dir = resolve(fixtures, name);
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

        writeFileSync(join(workspace, "requirements.in"), requirements);
        const nativeRun = await runNative(args(workspace));
        expect(nativeRun.status, `native uv failed: ${nativeRun.stderr}`).toBe(0);

        engine.fsMkdirp(`/${name}`);
        engine.fsWrite(`/${name}/requirements.in`, new TextEncoder().encode(requirements));
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
          server.misses,
          "one of the two sides asked for something the snapshot does not hold; re-record it",
        ).toEqual([]);
        expect(browserOut).toBe(nativeRun.stdout);
      } finally {
        await server?.close();
      }
    }, 180_000);
  }

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
