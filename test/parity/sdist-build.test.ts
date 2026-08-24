import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
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

import { jsPath, PROGRAM, wasmPath } from "./cli-goldens.js";

const require = createRequire(import.meta.url);
const hasPyodide = ((): boolean => {
  try {
    require.resolve("pyodide");
    return true;
  } catch {
    return false;
  }
})();

const canRun = existsSync(wasmPath) && existsSync(jsPath);

if (process.env.CI && (!canRun || !hasPyodide)) {
  throw new Error(
    "the source-build gate cannot run: the engine artifact or the `pyodide` package is missing. " +
      "Skipping here would report phase 5's exit criterion as green while never building anything.",
  );
}

const SOURCE = "/work/demo";
const TARGET = "/out";

const PYPROJECT = `[build-system]
requires = []
build-backend = "demo_backend"
backend-path = ["."]

[project]
name = "demo"
version = "0.1.0"
`;

const BACKEND = `import os, zipfile

WHEEL = "demo-0.1.0-py3-none-any.whl"
DIST = "demo-0.1.0.dist-info"

RECORDS = {
    "demo/__init__.py": "VALUE = 41 + 1\\n",
    DIST + "/METADATA": "Metadata-Version: 2.1\\nName: demo\\nVersion: 0.1.0\\n",
    DIST + "/WHEEL": "Wheel-Version: 1.0\\nGenerator: demo_backend\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n",
}


def get_requires_for_build_wheel(config_settings=None):
    return []


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    with zipfile.ZipFile(os.path.join(wheel_directory, WHEEL), "w") as archive:
        for name, body in RECORDS.items():
            archive.writestr(name, body)
        archive.writestr(
            DIST + "/RECORD",
            "".join(name + ",,\\n" for name in RECORDS) + DIST + "/RECORD,,\\n",
        )
    return WHEEL
`;

interface EngineInstance extends HookVfs {
  fsWrite(path: string, contents: Uint8Array): void;
  clearStdin(): void;
  hasRuntime(): boolean;
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
  "uv builds a source distribution inside wasm by running its backend in a real Pyodide",
  () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let engine: EngineInstance;
    let code: number;
    let log: string;
    const seen: RuntimeHookRequest[] = [];

    const text = (path: string): string => decoder.decode(engine.fsRead(path));

    beforeAll(async () => {
      const mod = (await import(pathToFileURL(jsPath).href)) as unknown as {
        default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
        Engine: new () => EngineInstance;
      };
      await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
      engine = new mod.Engine();
      engine.clearStdin();

      engine.fsWrite(`${SOURCE}/pyproject.toml`, encoder.encode(PYPROJECT));
      engine.fsWrite(`${SOURCE}/demo_backend.py`, encoder.encode(BACKEND));
      engine.fsWrite(`${SOURCE}/demo/__init__.py`, encoder.encode("VALUE = 41 + 1\n"));

      const { loadPyodide } = (await import("pyodide")) as {
        loadPyodide: () => Promise<PyodideLike>;
      };
      const pyodide = await loadPyodide();
      const runtime = attachPyodide(
        { exportTree: () => Promise.reject(new Error("unused")) },
        pyodide,
      );

      engine.attachRuntime(async (request) => {
        seen.push(request);
        const outcome = await runtime.hook({
          script: request.script,
          cwd: request.sourceTree,
          env: request.env,
          sitePackages: sitePackagesOf(engine, request.venv),
          trees: hookTrees(engine, request),
        });
        applyHookWrites(engine, outcome.writes);
        return { stdout: outcome.stdout, stderr: outcome.stderr, code: outcome.code };
      });

      log = "";
      code = await engine.invoke(
        [PROGRAM, "pip", "install", "--no-index", "--target", TARGET, SOURCE, "-v"],
        (_stream, data) => {
          log += decoder.decode(data);
        },
      );
    }, 900_000);

    it("built and installed the package, with no index and no network", () => {
      expect(code, `the build failed:\n${log.split("\n").slice(-30).join("\n")}`).toBe(0);
      expect(log).toContain("Built demo @ file:///work/demo");
    });

    it("drove the hooks itself rather than being called by the test", () => {
      expect(
        seen.length,
        "uv should have run at least the requires and the build hook",
      ).toBeGreaterThanOrEqual(2);
      expect(log).toContain("Creating PEP 517 build environment");
    });

    it("named the wheel directory only on the build hook, and it is not the build venv", () => {
      const build = seen.find((request) => request.outputDir !== undefined);
      const requires = seen.find((request) => request.outputDir === undefined);
      expect(requires, "get_requires_for_build_wheel takes no output directory").toBeDefined();
      expect(build, "build_wheel's output directory has to reach the runtime").toBeDefined();
      expect(
        build?.outputDir,
        "uv puts the wheel in a different temp directory from the build venv, which is why " +
          "mirroring the venv alone would lose it",
      ).not.toBe(build?.venv);
    });

    it("put the built package where uv was told to install it", () => {
      expect(engine.fsReadDir(TARGET).sort()).toContain("demo");
      expect(text(`${TARGET}/demo/__init__.py`)).toBe("VALUE = 41 + 1\n");
      expect(engine.fsKind(`${TARGET}/demo-0.1.0.dist-info/RECORD`)).toBe("file");
    });

    it("wrote metadata uv itself verified against the wheel it unpacked", () => {
      expect(text(`${TARGET}/demo-0.1.0.dist-info/METADATA`)).toContain("Name: demo");
    });
  },
);
