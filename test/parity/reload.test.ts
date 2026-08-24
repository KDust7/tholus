import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ColdStore,
  createPersistence,
  type Persistence,
  readCacheTree,
} from "@tholus/core";
import { beforeAll, describe, expect, it } from "vitest";

import { jsPath, PROGRAM, root, wasmPath } from "./cli-goldens.js";
import { type ReplayServer, startReplayServer } from "./replay-server.js";

const fixture = resolve(root, "test/fixtures/install");
const canRun =
  existsSync(wasmPath) && existsSync(jsPath) && existsSync(resolve(fixture, "snapshot.json"));

if (process.env.CI && !canRun) {
  throw new Error(
    "the reload gate cannot run: the engine artifact or the install fixture is missing. " +
      "Skipping here would report a gate that never ran.",
  );
}

interface EngineInstance {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  fsMkdirp(path: string): void;
  fsReadDir(path: string): string[];
  fsRead(path: string): Uint8Array;
  fsWrite(path: string, contents: Uint8Array): void;
  fsKind(path: string): string | undefined;
  fsSize(path: string): number;
  fsReadLink(path: string): string;
  fsSymlink(target: string, link: string): void;
  fsExists(path: string): boolean;
  fsRemoveDir(path: string): void;
  clearStdin(): void;
}

interface EngineModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  Engine: new () => EngineInstance;
}

class MemoryColdStore implements ColdStore {
  readonly blobs = new Map<string, Uint8Array>();
  manifest: string | undefined;

  async readManifest(): Promise<string | undefined> {
    return this.manifest;
  }

  async writeManifest(raw: string): Promise<void> {
    this.manifest = raw;
  }

  async read(path: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(path);
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(path, Uint8Array.from(bytes));
  }

  async remove(path: string): Promise<void> {
    this.blobs.delete(path);
  }
}

const CACHE_ROOT = "/home/browser/.cache/uv";
const CONTENT = /^\/files\//;
const ABI = "pyemscripten_2026_0_wasm32";

describe.skipIf(!canRun)("a cache that outlived the tab spares the network", () => {
  let engine: EngineInstance;
  let server: ReplayServer;
  let store: MemoryColdStore;
  let persistence: Persistence;
  let cold: readonly string[];
  let afterReload: readonly string[];
  let flushed: number;
  let hydrated: number;
  let treeBefore: unknown;
  let treeAfter: unknown;

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
    store = new MemoryColdStore();
    persistence = createPersistence({
      store,
      vfs: engine,
      root: CACHE_ROOT,
      abiTag: ABI,
      lock: (_name, task) => task(),
      now: () => 1,
    });

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

    cold = await install("before-reload");
    treeBefore = readCacheTree(engine, CACHE_ROOT);
    flushed = (await persistence.flush()).written.length;

    engine.fsRemoveDir(CACHE_ROOT);
    expect(
      engine.fsExists(CACHE_ROOT),
      "the cache survived the wipe, so nothing about a reload is being tested",
    ).toBe(false);

    hydrated = (await persistence.hydrate()).hydrated.length;
    treeAfter = readCacheTree(engine, CACHE_ROOT);

    afterReload = await install("after-reload");
    await server.close();
  }, 600_000);

  it("reached the network the first time, so the second time means something", () => {
    expect(cold.filter((url) => CONTENT.test(url)).length).toBe(2);
  });

  it("wrote every cached file to the cold store", () => {
    expect(flushed).toBeGreaterThan(0);
    expect(store.manifest, "the flush recorded no manifest").toBeDefined();
  });

  it("puts back exactly the tree it took, symlink and all", () => {
    expect(hydrated).toBeGreaterThan(0);
    expect(treeAfter).toEqual(treeBefore);
  });

  it("restores a working archive link, not just its bytes", () => {
    const links: string[] = [];
    const walk = (path: string): void => {
      for (const name of engine.fsReadDir(path)) {
        const child = `${path}/${name}`;
        const kind = engine.fsKind(child);
        if (kind === "directory") {
          walk(child);
        } else if (kind === "symlink") {
          links.push(child);
        }
      }
    };
    walk(CACHE_ROOT);
    expect(links.length, "hydration restored no link, so this proves nothing").toBeGreaterThan(0);
    for (const link of links) {
      expect(engine.fsExists(link), `${link} dangles after hydration`).toBe(true);
    }
  });

  it("downloads no distribution after the reload, which is what persistence is for", () => {
    expect(
      afterReload.filter((url) => CONTENT.test(url)),
      "the reinstall re-downloaded a distribution the cold store was holding",
    ).toEqual([]);
  });
});
