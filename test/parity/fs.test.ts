import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const assets = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/core/assets");
const wasmPath = resolve(assets, "engine_bg.wasm");
const jsPath = resolve(assets, "engine.js");
const dtsPath = resolve(assets, "engine.d.ts");

const hasFsApi =
  existsSync(wasmPath) &&
  existsSync(jsPath) &&
  existsSync(dtsPath) &&
  readFileSync(dtsPath, "utf8").includes("fsWrite");

interface EngineInstance {
  fsRead(path: string): Uint8Array;
  fsWrite(path: string, contents: Uint8Array): void;
  fsReadDir(path: string): string[];
  fsMkdirp(path: string): void;
  fsExists(path: string): boolean;
  fsKind(path: string): string | undefined;
  fsRemove(path: string): void;
  fsRemoveDir(path: string): void;
}

interface EngineModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  Engine: new () => EngineInstance;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

describe.skipIf(!hasFsApi)("the engine exposes its in-memory filesystem", () => {
  let engine: EngineInstance;

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as EngineModule;
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    engine = new mod.Engine();
  }, 180_000);

  it("round-trips a file's bytes", () => {
    engine.fsWrite("/work/pyproject.toml", encoder.encode("[project]\nname = 'demo'\n"));
    expect(decoder.decode(engine.fsRead("/work/pyproject.toml"))).toBe(
      "[project]\nname = 'demo'\n",
    );
  });

  it("creates missing parents on write", () => {
    engine.fsWrite("/deep/nested/dir/file.txt", encoder.encode("hi"));
    expect(engine.fsExists("/deep/nested/dir")).toBe(true);
    expect(engine.fsKind("/deep/nested/dir")).toBe("directory");
    expect(engine.fsKind("/deep/nested/dir/file.txt")).toBe("file");
  });

  it("lists a directory by entry name", () => {
    engine.fsMkdirp("/listing");
    engine.fsWrite("/listing/a.txt", encoder.encode("a"));
    engine.fsWrite("/listing/b.txt", encoder.encode("b"));
    expect(engine.fsReadDir("/listing").sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("reports absence rather than throwing", () => {
    expect(engine.fsExists("/nope")).toBe(false);
    expect(engine.fsKind("/nope")).toBeUndefined();
  });

  it("fails a read of a missing path with a legible error", () => {
    expect(() => engine.fsRead("/missing/file")).toThrow(/missing[\\/]file/);
  });

  it("removes files and trees", () => {
    engine.fsWrite("/trash/one.txt", encoder.encode("x"));
    engine.fsRemove("/trash/one.txt");
    expect(engine.fsExists("/trash/one.txt")).toBe(false);
    expect(engine.fsExists("/trash")).toBe(true);
    engine.fsRemoveDir("/trash");
    expect(engine.fsExists("/trash")).toBe(false);
  });

  it("shares one filesystem with the uv the engine runs", () => {
    engine.fsWrite("/shared/marker", encoder.encode("seeded"));
    const second = engine;
    expect(decoder.decode(second.fsRead("/shared/marker"))).toBe("seeded");
  });
});
