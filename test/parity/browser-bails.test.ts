import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const assets = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/core/assets");
const wasmPath = resolve(assets, "engine_bg.wasm");
const jsPath = resolve(assets, "engine.js");
const isBuilt = existsSync(wasmPath) && existsSync(jsPath);

const PROGRAM = "uv";

interface EngineInstance {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  fsWrite(path: string, contents: Uint8Array): void;
  fsMkdirp(path: string): void;
}

interface EngineModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  Engine: new () => EngineInstance;
}

interface Invocation {
  code: number;
  output: string;
}

describe.skipIf(!isBuilt)("the browser names what it cannot do", () => {
  let engine: EngineInstance;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const run = async (...args: string[]): Promise<Invocation> => {
    let output = "";
    const code = await engine.invoke([PROGRAM, ...args], (_stream, data) => {
      output += decoder.decode(data);
    });
    return { code, output: output.trim() };
  };

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as EngineModule;
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    engine = new mod.Engine();

    const write = (path: string, text: string): void => {
      engine.fsWrite(path, encoder.encode(text));
    };

    engine.fsMkdirp("/bails");
    write(
      "/bails/pyproject.toml",
      '[project]\nname = "demo"\nversion = "0.1.0"\nrequires-python = ">=3.14"\ndependencies = []\n',
    );

    engine.fsMkdirp("/ws");
    write(
      "/ws/pyproject.toml",
      '[project]\nname = "root"\nversion = "0.1.0"\nrequires-python = ">=3.14"\ndependencies = []\n\n[tool.uv.workspace]\nmembers = ["packages/*"]\n',
    );
    for (const name of ["alpha", "beta"]) {
      engine.fsMkdirp(`/ws/packages/${name}/src/${name}`);
      write(
        `/ws/packages/${name}/pyproject.toml`,
        `[project]\nname = "${name}"\nversion = "0.1.0"\nrequires-python = ">=3.14"\ndependencies = []\n`,
      );
      write(`/ws/packages/${name}/src/${name}/__init__.py`, "\n");
    }
  });

  it("refuses to initialize a git repository, by name", async () => {
    const result = await run("init", "--directory", "/bails", "--vcs", "git", "child");
    expect(result.code).toBe(2);
    expect(result.output).toContain("Initializing a Git repository is not supported in the browser");
  });

  it("refuses to fetch a git dependency, by name", async () => {
    const result = await run(
      "add",
      "--directory",
      "/bails",
      "--offline",
      "git+https://example.com/x.git",
    );
    expect(result.code).toBe(2);
    expect(result.output).toContain("Fetching a Git repository is not supported in the browser");
  });

  it("refuses to compile bytecode, and says why rather than how", async () => {
    const result = await run("sync", "--directory", "/bails", "--offline", "--compile-bytecode");
    expect(result.code).toBe(2);
    expect(result.output).toContain(
      "Bytecode compilation requires running a Python interpreter, which is unavailable in the browser",
    );
  });

  it("has no python to download, because none is built for this platform", async () => {
    const result = await run("python", "install", "3.14");
    expect(result.code).toBe(2);
    expect(result.output).toContain("No download found for request");
    expect(result.output).toContain("wasm32");
  });

  it("still runs the commands it does support", async () => {
    const result = await run("publish", "--help");
    expect(result.code).toBe(0);
    expect(result.output).toContain("Upload distributions to an index");
  });

  it("lists a workspace root but none of the members its glob should have matched", async () => {
    const result = await run("workspace", "list", "--directory", "/ws");
    expect(result.code).toBe(0);
    expect(result.output).toContain("root");
    expect(result.output).not.toContain("alpha");
    expect(result.output).not.toContain("beta");
  });

  it("locks that workspace as though it had no members, and reports success", async () => {
    const result = await run("lock", "--directory", "/ws", "--offline");
    expect(result.code).toBe(0);
    expect(result.output).toContain("Resolved 1 package");
  });
});
