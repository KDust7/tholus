import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

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

interface EngineInstance {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
}

interface EngineModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  Engine: new () => EngineInstance;
}

interface Output {
  code: number;
  stdout: string;
  stderr: string;
}

const TARGET_TRIPLE = /\b[a-z0-9_]+(?:-[a-z0-9_]+){2,3}\)/;

function withoutTargetTriple(text: string): string {
  return text.replace(TARGET_TRIPLE, "<target>)");
}

describe.skipIf(!canCompare)("the engine matches native uv byte for byte", () => {
  let engine: EngineInstance;

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as EngineModule;
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    engine = new mod.Engine();
  });

  async function browser(argv: string[]): Promise<Output> {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const code = await engine.invoke(argv, (stream, data) => {
      (stream === "stdout" ? stdout : stderr).push(data);
    });
    const join = (parts: Uint8Array[]): string => Buffer.concat(parts).toString("utf8");
    return { code, stdout: join(stdout), stderr: join(stderr) };
  }

  function native(argv: string[]): Output {
    const result = spawnSync(nativePath, argv.slice(1), { encoding: "buffer" });
    return {
      code: result.status ?? -1,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
  }

  it.each([["--help"], ["pip", "--help"], ["python", "--help"]])(
    "matches `uv %s` exactly",
    async (...args: string[]) => {
      const argv = ["uv", ...args];
      const [there, here] = [native(argv), await browser(argv)];
      expect(here.stdout).toBe(there.stdout);
      expect(here.stderr).toBe(there.stderr);
      expect(here.code).toBe(there.code);
    },
  );

  it.each([["--nonesuch"], ["install"]])(
    "matches the failure for `uv %s` exactly",
    async (...args: string[]) => {
      const argv = ["uv", ...args];
      const [there, here] = [native(argv), await browser(argv)];
      expect(here.stderr).toBe(there.stderr);
      expect(here.stdout).toBe(there.stdout);
      expect(here.code).toBe(there.code);
    },
  );

  it("matches `uv --version` once the target triple is normalized", async () => {
    const argv = ["uv", "--version"];
    const [there, here] = [native(argv), await browser(argv)];
    expect(withoutTargetTriple(here.stdout)).toBe(withoutTargetTriple(there.stdout));
    expect(here.code).toBe(there.code);
  });

  it("reports each build's own target in --version", async () => {
    const argv = ["uv", "--version"];
    expect((await browser(argv)).stdout).toContain("wasm32-unknown-unknown");
    expect(native(argv).stdout).not.toContain("wasm32-unknown-unknown");
  });
});
