import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const assets = resolve(root, "packages/core/assets");
const wasmPath = resolve(assets, "engine_bg.wasm");
const jsPath = resolve(assets, "engine.js");

const canRun = existsSync(wasmPath) && existsSync(jsPath);
const PROGRAM = "uv";

interface EngineInstance {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  envReplace(entries: string[]): void;
}

interface EngineModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  Engine: new () => EngineInstance;
}

describe.skipIf(!canRun)("uv reads the environment the host installed", () => {
  let engine: EngineInstance;

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as EngineModule;
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    engine = new mod.Engine();
  });

  async function run(env: Record<string, string>, args: string[]): Promise<string> {
    engine.envReplace(Object.entries(env).flat());
    const chunks: Uint8Array[] = [];
    const code = await engine.invoke([PROGRAM, ...args], (stream, data) => {
      if (stream === "stdout") {
        chunks.push(data);
      }
    });
    expect(code).toBe(0);
    return Buffer.concat(chunks).toString("utf8").trim();
  }

  it("falls back to a relative cache root when the host installs nothing", async () => {
    expect(await run({}, ["cache", "dir"])).toBe(".uv_cache");
  });

  it("builds the xdg cache root from a host-set HOME", async () => {
    expect(await run({ HOME: "/home/browser" }, ["cache", "dir"])).toBe("/home/browser/.cache/uv");
  });

  it("lets XDG_CACHE_HOME move the cache root", async () => {
    const env = { HOME: "/home/browser", XDG_CACHE_HOME: "/xdg/cache" };
    expect(await run(env, ["cache", "dir"])).toBe("/xdg/cache/uv");
  });

  it("ignores a relative XDG_CACHE_HOME, as the specification requires", async () => {
    const env = { HOME: "/home/browser", XDG_CACHE_HOME: "relative/cache" };
    expect(await run(env, ["cache", "dir"])).toBe("/home/browser/.cache/uv");
  });

  it("reads UV_CACHE_DIR, which only clap ever sees", async () => {
    const env = { HOME: "/home/browser", UV_CACHE_DIR: "/explicit/cache" };
    expect(await run(env, ["cache", "dir"])).toBe("/explicit/cache");
  });

  it("reads a clap option declared on a nested subcommand", async () => {
    const env = { HOME: "/home/browser", UV_PYTHON_INSTALL_DIR: "/pythons" };
    expect(await run(env, ["python", "dir"])).toBe("/pythons");
  });

  it("parses UV_NO_CACHE as the boolean flag it is", async () => {
    const env = { HOME: "/home/browser", UV_NO_CACHE: "1" };
    expect(await run(env, ["cache", "dir"])).toMatch(/^\/tmp\//);
  });

  it("keeps the state root under the xdg data directory", async () => {
    const env = { HOME: "/home/browser" };
    expect(await run(env, ["tool", "dir"])).toBe("/home/browser/.local/share/uv/tools");
  });

  it("lets a command line flag beat the environment", async () => {
    const env = { HOME: "/home/browser", UV_CACHE_DIR: "/from/env" };
    expect(await run(env, ["cache", "dir", "--cache-dir", "/from/flag"])).toBe("/from/flag");
  });

  it("does not let one invocation's environment reach the next", async () => {
    await run({ HOME: "/home/browser", UV_CACHE_DIR: "/explicit/cache" }, ["cache", "dir"]);
    expect(await run({ HOME: "/home/browser" }, ["cache", "dir"])).toBe("/home/browser/.cache/uv");
  });
});
