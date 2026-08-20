import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { jsPath, PROGRAM, root, wasmPath } from "./cli-goldens.js";
import { type ReplayServer, startReplayServer } from "./replay-server.js";

const fixture = resolve(root, "test/fixtures/install");
const hasEngine = existsSync(wasmPath) && existsSync(jsPath);
const hasFixture = existsSync(resolve(fixture, "snapshot.json"));
const canRun = hasEngine && hasFixture;

if (process.env.CI && !canRun) {
  throw new Error(
    "the cache gate cannot run: the engine artifact or the install fixture is missing. " +
      "Skipping here would report a gate that never ran.",
  );
}

interface EngineInstance {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  fsMkdirp(path: string): void;
  fsReadDir(path: string): string[];
  fsExists(path: string): boolean;
  clearStdin(): void;
}

interface EngineModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  Engine: new () => EngineInstance;
}

const CACHE_ROOT = "/home/browser/.cache/uv";
const CONTENT = /^\/files\//;

describe.skipIf(!canRun)("the cache spares the network on a second install", () => {
  let engine: EngineInstance;
  let server: ReplayServer;
  let cold: readonly string[];
  let warm: readonly string[];

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as EngineModule;
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    engine = new mod.Engine();

    const run = async (args: string[]): Promise<{ code: number; err: string }> => {
      engine.clearStdin();
      let err = "";
      const decoder = new TextDecoder();
      const code = await engine.invoke([PROGRAM, ...args], (stream, data) => {
        if (stream !== "stdout") {
          err += decoder.decode(data);
        }
      });
      return { code, err };
    };

    server = await startReplayServer(fixture);
    const install = async (name: string): Promise<string[]> => {
      const before = server.requested.length;
      engine.fsMkdirp(`/${name}`);
      const venv = await run(["venv", `/${name}/.venv`, "--python", "/bin/python3"]);
      expect(venv.code, `the venv failed: ${venv.err}`).toBe(0);
      const done = await run([
        "pip",
        "install",
        "idna==3.11",
        "--index-url",
        `${server.origin}/simple`,
        "--python",
        `/${name}/.venv`,
      ]);
      expect(done.code, `the install failed: ${done.err}`).toBe(0);
      return server.requested.slice(before);
    };

    cold = await install("cache-cold");
    warm = await install("cache-warm");
    await server.close();
  }, 600_000);

  it("populates uv's own cache buckets in the virtual filesystem", () => {
    expect(engine.fsExists(CACHE_ROOT), `nothing was cached at ${CACHE_ROOT}`).toBe(true);
    const buckets = engine.fsReadDir(CACHE_ROOT);
    expect(buckets).toContain("simple-v24");
    expect(buckets).toContain("wheels-v6");
    expect(buckets).toContain("archive-v0");
  });

  it("downloads the index and the distribution the first time", () => {
    expect(cold.length, "the cold install reached nothing, so the warm one proves nothing").toBe(3);
    expect(cold.filter((url) => CONTENT.test(url)).length).toBe(2);
  });

  it("downloads no content at all the second time", () => {
    expect(
      warm.filter((url) => CONTENT.test(url)),
      "the warm install fetched a distribution it had already cached",
    ).toEqual([]);
  });

  it("spends its one warm request revalidating the index, and gets a 304", () => {
    expect(warm.length, `the warm install made ${warm.length} requests: ${warm.join(", ")}`).toBe(
      1,
    );
    expect(warm[0]).toBe("/simple/idna/");
    expect(
      server.revalidated,
      "the index was re-downloaded rather than revalidated, so the cached copy was not used",
    ).toEqual(["/simple/idna/"]);
  });
});
