import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineEndpoint } from "../../packages/core/src/endpoint.js";
import { createEngine, type Engine } from "../../packages/core/src/engine.js";
import { createEngineWorker, type EngineExports } from "../../packages/core/src/engine-worker.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const assets = resolve(root, "packages/core/assets");
const jsPath = resolve(assets, "engine.js");
const wasmPath = resolve(assets, "engine_bg.wasm");
const isBuilt = existsSync(wasmPath) && existsSync(jsPath);
const nativePath = resolve(
  root,
  "vendor/uv/target/debug",
  process.platform === "win32" ? "uv.exe" : "uv",
);
const PROGRAM = basename(nativePath);

function inProcessEndpoint(): EngineEndpoint {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const worker = createEngineWorker({
    load: async (): Promise<EngineExports> =>
      (await import(pathToFileURL(jsPath).href)) as EngineExports,
    wasm: () => readFile(wasmPath),
    emit: (message) => {
      for (const listener of [...listeners]) {
        listener({ data: message });
      }
    },
  });

  return {
    postMessage(message: unknown): void {
      worker.receive(message);
    },
    addEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
      listeners.add(listener);
    },
    removeEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
      listeners.delete(listener);
    },
    terminate(): void {
      listeners.clear();
    },
  };
}

interface Captured {
  code: number;
  cancelled: boolean;
  stdout: string;
  stderr: string;
}

describe.skipIf(!isBuilt)("the SDK drives the real engine", () => {
  let engine: Engine;

  beforeAll(async () => {
    engine = await createEngine({ endpoint: inProcessEndpoint });
  }, 180_000);

  afterAll(async () => {
    await engine?.dispose();
  }, 180_000);

  async function run(args: string[]): Promise<Captured> {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const handle = engine.exec([PROGRAM, ...args], {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });
    const result = await handle.exit;
    return {
      code: result.code,
      cancelled: result.cancelled,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
  }

  it("completes the handshake and exposes the vendored build", () => {
    expect(engine.build).toMatchObject({ uv: "0.12.3", protocol: "0" });
  });

  it("streams --help through the exec handle", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.cancelled).toBe(false);
    expect(result.stdout).toContain("Usage: uv");
    expect(result.stderr).toBe("");
  });

  it.skipIf(!existsSync(nativePath))("delivers native uv's exact bytes", async () => {
    const result = await run(["--help"]);
    const native = spawnSync(nativePath, ["--help"], { encoding: "buffer" });
    expect(result.stdout).toBe(native.stdout.toString("utf8"));
  });

  it("reports a usage failure without throwing", async () => {
    const result = await run(["--nonesuch"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unexpected argument");
  });

  it("runs invocations one after another", async () => {
    const [first, second] = await Promise.all([run(["--version"]), run(["--version"])]);
    expect(first.stdout).toBe(second.stdout);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
  });
});
