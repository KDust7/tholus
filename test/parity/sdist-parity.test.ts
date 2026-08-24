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
import { normalizeReport } from "./normalize-report.js";
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

if (process.env.CI && (!canRun || !hasPyodide)) {
  throw new Error(
    "the sdist parity gate cannot run: the engine artifact, the sdist fixture or the `pyodide` " +
      "package is missing. Skipping here would report phase 5's parity criterion as green while " +
      "never building a source distribution.",
  );
}

const HOME = "/sdist";
const TARGET = `${HOME}/target`;

const normalize = normalizeReport;

interface SeenHook extends RuntimeHookRequest {
  sitePackages: string[];
  backends: string[];
}

interface Snapshot {
  args: string[];
  expectedReport?: string;
}

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

describe.skipIf(!canRun || !hasPyodide)(
  "uv builds a real sdist off the index and matches native uv's report",
  () => {
    const decoder = new TextDecoder();
    let engine: EngineInstance;
    let snapshot: Snapshot;
    let code: number;
    let stderr: string;
    let hooks: SeenHook[];
    let server: ReplayServer | undefined;

    const text = (path: string): string => decoder.decode(engine.fsRead(path));

    beforeAll(async () => {
      snapshot = JSON.parse(await readFile(resolve(FIXTURE, "snapshot.json"), "utf8")) as Snapshot;
      server = await startReplayServer(FIXTURE);

      const mod = (await import(pathToFileURL(jsPath).href)) as unknown as {
        default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
        Engine: new () => EngineInstance;
      };
      await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
      engine = new mod.Engine();
      engine.clearStdin();
      engine.fsMkdirp(HOME);

      const { loadPyodide } = (await import("pyodide")) as {
        loadPyodide: () => Promise<PyodideLike>;
      };
      const pyodide = await loadPyodide();
      const runtime = attachPyodide(
        { exportTree: () => Promise.reject(new Error("unused")) },
        pyodide,
      );

      hooks = [];
      engine.attachRuntime(async (request) => {
        const sitePackages = sitePackagesOf(engine, request.venv);
        hooks.push({
          ...request,
          sitePackages,
          backends: sitePackages.filter(
            (path) => engine.fsKind(`${path}/flit_core`) === "directory",
          ),
        });
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

      stderr = "";
      code = await engine.invoke(
        [PROGRAM, ...snapshot.args, "--index-url", `${server.origin}/simple`, "--target", TARGET],
        (stream, data) => {
          if (stream !== "stdout") {
            stderr += decoder.decode(data);
          }
        },
      );
      await server.close();
      server = undefined;
    }, 900_000);

    it("built the source distribution and installed what it produced", () => {
      expect(code, `the build failed:\n${stderr}`).toBe(0);
    });

    it("reports what native uv reported, once timings are normalized", () => {
      expect(snapshot.expectedReport, "the fixture must carry native's own report").toBeDefined();
      expect(normalize(stderr)).toBe(normalize(snapshot.expectedReport as string));
    });

    it("really built rather than quietly falling back to the wheel", () => {
      expect(stderr).toContain("Building idna==3.11");
      expect(stderr).toContain("Built idna==3.11");
      expect(
        hooks.length,
        "a flit-core build runs get_requires_for_build_wheel and build_wheel",
      ).toBeGreaterThanOrEqual(2);
    });

    it("ran the backend uv installed into the build venv, not one the test supplied", () => {
      const build = hooks.find((hook) => hook.outputDir !== undefined) as SeenHook;
      expect(build.script).toContain("flit_core.buildapi");
      expect(
        build.sitePackages,
        "uv makes the build venv and deletes it, so this can only be read at hook time",
      ).not.toEqual([]);
      expect(
        build.backends,
        "the backend uv resolved off the index has to be importable when the hook runs",
      ).not.toEqual([]);
    });

    it("installed a package whose RECORD describes the bytes on disk", () => {
      expect(engine.fsReadDir(TARGET)).toContain("idna");
      const record = text(`${TARGET}/idna-3.11.dist-info/RECORD`);
      expect(record).toContain("idna/__init__.py");
      expect(text(`${TARGET}/idna/__init__.py`).length).toBeGreaterThan(0);
    });
  },
);
