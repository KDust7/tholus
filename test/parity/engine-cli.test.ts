import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const assets = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/core/assets");
const wasmPath = resolve(assets, "engine_bg.wasm");
const jsPath = resolve(assets, "engine.js");
const isBuilt = existsSync(wasmPath) && existsSync(jsPath);

interface EngineInstance {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  isRunning(): boolean;
  setTermSize(columns: number, rows: number): void;
  clearTerm(): void;
}

interface EngineModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  version: () => string;
  buildInfo: () => string;
  Engine: new () => EngineInstance;
}

interface Invocation {
  code: number;
  stdout: string;
  stderr: string;
}

const ESCAPE = String.fromCharCode(27);

describe.skipIf(!isBuilt)("the built engine answers uv's command line", () => {
  let mod: EngineModule;
  let engine: EngineInstance;

  beforeAll(async () => {
    mod = (await import(pathToFileURL(jsPath).href)) as unknown as EngineModule;
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    engine = new mod.Engine();
  });

  async function invoke(argv: string[]): Promise<Invocation> {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const code = await engine.invoke(argv, (stream, data) => {
      if (stream === "stdout") {
        stdout.push(data);
      } else if (stream === "stderr") {
        stderr.push(data);
      } else {
        throw new Error(`engine named an unknown stream: ${stream}`);
      }
    });
    const join = (parts: Uint8Array[]): string => Buffer.concat(parts).toString("utf8");
    return { code, stdout: join(stdout), stderr: join(stderr) };
  }

  it("reports the vendored uv version, not a placeholder", () => {
    expect(mod.version()).toContain("uv 0.12.3");
    expect(JSON.parse(mod.buildInfo())).toMatchObject({ uv: "0.12.3", protocol: "0" });
  });

  it("prints --version to stdout and exits zero", async () => {
    const result = await invoke(["uv", "--version"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^uv \d+\.\d+\.\d+/);
  });

  it("names the wasm target in --version rather than the build host", async () => {
    const { stdout } = await invoke(["uv", "--version"]);
    expect(stdout).toContain("wasm32-unknown-unknown");
  });

  it("prints --help to stdout and exits zero", async () => {
    const result = await invoke(["uv", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: uv [OPTIONS] <COMMAND>");
  });

  it("prints a subcommand's help to stdout", async () => {
    const result = await invoke(["uv", "pip", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: uv pip");
  });

  it("sends an unknown flag to stderr with clap's usage code", async () => {
    const result = await invoke(["uv", "--nonesuch"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unexpected argument '--nonesuch'");
  });

  it("keeps uv's subcommand suggestions", async () => {
    const result = await invoke(["uv", "install"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("uv pip install");
  });

  it("emits no escape sequences without a terminal", async () => {
    const help = await invoke(["uv", "--help"]);
    const failure = await invoke(["uv", "--nonesuch"]);
    expect(help.stdout).not.toContain(ESCAPE);
    expect(failure.stderr).not.toContain(ESCAPE);
  });

  it("is idle between invocations", async () => {
    expect(engine.isRunning()).toBe(false);
    await invoke(["uv", "--version"]);
    expect(engine.isRunning()).toBe(false);
  });
});
