import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyHookWrites,
  type HookVfs,
  hookTrees,
  type RuntimeHookRequest,
  sitePackagesOf,
} from "@tholus/core";
import { attachPyodide, type PyodideLike } from "@tholus/pyodide";
import { beforeAll, describe, expect, it } from "vitest";

import { jsPath, PROGRAM, root, wasmPath } from "./cli-goldens.js";
import { type ReplayServer, startReplayServer } from "./replay-server.js";

const FIXTURE = resolve(root, "test/fixtures/sdist");

const require = createRequire(import.meta.url);
const hasPyodide = ((): boolean => {
  try {
    require.resolve("pyodide");
    return true;
  } catch {
    return false;
  }
})();

const canRun =
  existsSync(wasmPath) && existsSync(jsPath) && existsSync(resolve(FIXTURE, "snapshot.json"));

if (process.env.CI && !(canRun && hasPyodide)) {
  throw new Error(
    "the project-build gate cannot run: the artifact, the sdist fixture or `pyodide` is missing. " +
      "Skipping here would report that uv can build a project in a browser without building one.",
  );
}

const PROJECT = [
  "[project]",
  'name = "probe"',
  'version = "0.1.0"',
  'description = "a project built in a browser"',
  'requires-python = ">=3.14"',
  "dependencies = []",
  "",
  "[build-system]",
  'requires = ["flit-core>=3.2,<4"]',
  'build-backend = "flit_core.buildapi"',
  "",
].join("\n");

const MODULE = ['"""probe."""', '__version__ = "0.1.0"', ""].join("\n");

interface EngineInstance extends HookVfs {
  fsWrite(path: string, contents: Uint8Array): void;
  fsMkdirp(path: string): void;
  clearStdin(): void;
  attachRuntime(
    run: (request: RuntimeHookRequest) => Promise<{
      stdout: string[];
      stderr: string[];
      code: number;
    }>,
  ): void;
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
}

interface EngineModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  Engine: new () => EngineInstance;
}

interface Built {
  code: number;
  stdout: string;
  stderr: string;
  dist: string[];
  misses: string[];
}

describe.skipIf(!canRun || !hasPyodide)("uv builds a project into a wheel, in a browser", () => {
  let engine: EngineInstance;
  let good: Built;
  let broken: Built;

  const write = (where: string, project: string): void => {
    engine.fsMkdirp(`${where}/probe`);
    engine.fsWrite(`${where}/pyproject.toml`, new TextEncoder().encode(project));
    engine.fsWrite(`${where}/probe/__init__.py`, new TextEncoder().encode(MODULE));
    engine.fsWrite(`${where}/README.md`, new TextEncoder().encode("# probe\n"));
  };

  const build = async (where: string): Promise<Built> => {
    let server: ReplayServer | undefined;
    const decoder = new TextDecoder();
    let stdout = "";
    let stderr = "";
    try {
      server = await startReplayServer(FIXTURE);
      const code = await engine.invoke(
        [
          PROGRAM,
          "build",
          "--directory",
          where,
          "--index-url",
          `${server.origin}/simple`,
          "--no-cache",
        ],
        (stream, data) => {
          if (stream === "stdout") {
            stdout += decoder.decode(data);
          } else {
            stderr += decoder.decode(data);
          }
        },
      );
      let dist: string[] = [];
      try {
        dist = engine.fsReadDir(`${where}/dist`);
      } catch {
        dist = [];
      }
      return { code, stdout, stderr, dist, misses: [...server.misses] };
    } finally {
      await server?.close();
    }
  };

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as EngineModule;
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    engine = new mod.Engine();
    engine.clearStdin();

    const { loadPyodide } = (await import("pyodide")) as {
      loadPyodide: () => Promise<PyodideLike>;
    };
    const pyodide = await loadPyodide();
    const runtime = attachPyodide(
      { exportTree: () => Promise.reject(new Error("unused")) },
      pyodide,
    );
    engine.attachRuntime(async (request) => {
      const sitePackages = sitePackagesOf(engine, request.venv);
      const outcome = await runtime.hook({
        script: request.script,
        cwd: request.sourceTree,
        env: request.env,
        sitePackages,
        trees: hookTrees(engine, request),
      });
      applyHookWrites(engine, outcome.writes);
      return { stdout: outcome.stdout, stderr: outcome.stderr, code: outcome.code };
    });

    write("/build-good", PROJECT);
    good = await build("/build-good");

    write("/build-broken", PROJECT.replace('description = "a project built in a browser"\n', ""));
    broken = await build("/build-broken");
  }, 900_000);

  it("builds, resolving its build backend off the index", () => {
    expect(good.code, `uv build failed:\n${good.stderr}`).toBe(0);
    expect(good.misses, "the build reached for something the snapshot does not hold").toEqual([]);
  });

  it("produces both a source distribution and a wheel", () => {
    expect(good.dist).toContain("probe-0.1.0.tar.gz");
    expect(good.dist).toContain("probe-0.1.0-py3-none-any.whl");
  });

  it("says what it built, in uv's words", () => {
    expect(good.stderr).toContain("Successfully built dist/probe-0.1.0.tar.gz");
    expect(good.stderr).toContain("Successfully built dist/probe-0.1.0-py3-none-any.whl");
  });

  it("reads the build backend's own failure out, rather than only its exit code", () => {
    expect(broken.code, "the broken project built, so this proves nothing").not.toBe(0);
    expect(
      broken.stderr,
      "uv streams the backend's output on native; the browser dropped it entirely until the " +
        "wasm arm was taught to feed the same printer",
    ).toContain("flit_core.config.ConfigError");
    expect(broken.stderr).toContain("description must be specified");
    expect(broken.stderr).toContain("Call to `flit_core.buildapi.build_sdist` failed");
  });
});
