import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const assets = resolve(root, "packages/core/assets");
const wasmPath = resolve(assets, "engine_bg.wasm");
const jsPath = resolve(assets, "engine.js");
const nativePath = resolve(
  root,
  "vendor/uv/target/debug",
  process.platform === "win32" ? "uv.exe" : "uv",
);

const canCompare = existsSync(wasmPath) && existsSync(jsPath) && existsSync(nativePath);
const PROGRAM = basename(nativePath);

const PYPROJECT = `[project]
name = "demo"
version = "0.1.0"
requires-python = ">=3.14"
dependencies = []

[tool.uv]
package = false
`;

interface EngineInstance {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  fsRead(path: string): Uint8Array;
  fsWrite(path: string, contents: Uint8Array): void;
}

interface EngineModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  Engine: new () => EngineInstance;
}

describe.skipIf(!canCompare)("the engine resolves the same lockfile as native uv", () => {
  let engine: EngineInstance;
  let workspace: string;

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as EngineModule;
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    engine = new mod.Engine();
    workspace = mkdtempSync(join(tmpdir(), "uv-wasm-lock-"));
    writeFileSync(join(workspace, "pyproject.toml"), PYPROJECT);
  }, 180_000);

  afterAll(() => {
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("writes a byte-identical uv.lock for the same project", async () => {
    const nativeRun = spawnSync(nativePath, ["lock", "--directory", workspace, "--offline"], {
      encoding: "utf8",
    });
    expect(nativeRun.status, `native uv could not lock the fixture: ${nativeRun.stderr}`).toBe(0);

    engine.fsWrite("/work/pyproject.toml", new TextEncoder().encode(PYPROJECT));
    const code = await engine.invoke(
      [PROGRAM, "lock", "--directory", "/work", "--offline"],
      () => {},
    );
    expect(code).toBe(0);

    const native = readFileSync(join(workspace, "uv.lock"));
    const browser = Buffer.from(engine.fsRead("/work/uv.lock"));

    expect(browser.toString("utf8")).toBe(native.toString("utf8"));
    expect(browser.equals(native)).toBe(true);
  }, 180_000);
});
