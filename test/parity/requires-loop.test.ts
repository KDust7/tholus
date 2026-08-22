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
} from "@uv-wasm/core";
import { attachPyodide, type PyodideLike } from "@uv-wasm/pyodide";
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
    "the requires-loop gate cannot run: the engine artifact or the `pyodide` package is missing. " +
      "Skipping here would report phase 5's requires-loop criterion as green while never " +
      "re-entering a build.",
  );
}

const SOURCE = "/work/demo";
const MARKER = "/work/marker";
const TARGET = "/out";
const STAMP = "built-against-the-marker";

const MARKER_BACKEND = `import os, zipfile

WHEEL = "demo_marker-1.0-py3-none-any.whl"
DIST = "demo_marker-1.0.dist-info"

RECORDS = {
    "demo_marker/__init__.py": "STAMP = '${STAMP}'\\n",
    DIST + "/METADATA": "Metadata-Version: 2.1\\nName: demo-marker\\nVersion: 1.0\\n",
    DIST + "/WHEEL": "Wheel-Version: 1.0\\nGenerator: demo\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n",
}


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    with zipfile.ZipFile(os.path.join(wheel_directory, WHEEL), "w") as archive:
        for name, contents in RECORDS.items():
            archive.writestr(name, contents)
        archive.writestr(
            DIST + "/RECORD",
            "".join(name + ",,\\n" for name in RECORDS) + DIST + "/RECORD,,\\n",
        )
    return WHEEL
`;

const DEMO_BACKEND = `import os, zipfile

WHEEL = "demo-0.1.0-py3-none-any.whl"
DIST = "demo-0.1.0.dist-info"


def get_requires_for_build_wheel(config_settings=None):
    return ["demo-marker @ file://${MARKER}"]


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    import demo_marker

    records = {
        "demo/__init__.py": "STAMP = " + repr(demo_marker.STAMP) + "\\n",
        DIST + "/METADATA": "Metadata-Version: 2.1\\nName: demo\\nVersion: 0.1.0\\n",
        DIST + "/WHEEL": "Wheel-Version: 1.0\\nGenerator: demo\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n",
    }
    with zipfile.ZipFile(os.path.join(wheel_directory, WHEEL), "w") as archive:
        for name, contents in records.items():
            archive.writestr(name, contents)
        archive.writestr(
            DIST + "/RECORD",
            "".join(name + ",,\\n" for name in records) + DIST + "/RECORD,,\\n",
        )
    return WHEEL
`;

const project = (name: string, version: string, backend: string): string => `[build-system]
requires = []
build-backend = ${JSON.stringify(backend)}
backend-path = ["."]

[project]
name = ${JSON.stringify(name)}
version = ${JSON.stringify(version)}
`;

interface EngineInstance extends HookVfs {
  fsWrite(path: string, contents: Uint8Array): void;
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
  "a backend that asks for more build requirements gets them installed before it is re-entered",
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

      engine.fsWrite(
        `${MARKER}/pyproject.toml`,
        encoder.encode(project("demo-marker", "1.0", "marker_backend")),
      );
      engine.fsWrite(`${MARKER}/marker_backend.py`, encoder.encode(MARKER_BACKEND));
      engine.fsWrite(
        `${SOURCE}/pyproject.toml`,
        encoder.encode(project("demo", "0.1.0", "demo_backend")),
      );
      engine.fsWrite(`${SOURCE}/demo_backend.py`, encoder.encode(DEMO_BACKEND));

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

    it("completes the build that asked for more than it declared", () => {
      expect(code, `the build failed:\n${log.split("\n").slice(-40).join("\n")}`).toBe(0);
      expect(log).toContain("Built demo @ file:///work/demo");
    });

    it("installed the extra requirement into the build environment before re-entering", () => {
      expect(
        text(`${TARGET}/demo/__init__.py`),
        "build_wheel imports the package `get_requires_for_build_wheel` asked for, so a stamp " +
          "here is proof uv installed it and then called the backend again",
      ).toBe(`STAMP = '${STAMP}'\n`);
    });

    it("asked the backend what it needed before building it, and built the extra requirement too", () => {
      const requires = seen.filter((request) => request.outputDir === undefined);
      const builds = seen.filter((request) => request.outputDir !== undefined);
      expect(requires.length, "every build asks its backend for requirements first").toBeGreaterThanOrEqual(1);
      expect(
        builds.length,
        "the marker is a source tree of its own, so two wheels have to be built",
      ).toBe(2);
      expect(
        builds.map((request) => request.sourceTree),
        "the requirement has to be built before the package that asked for it",
      ).toEqual([MARKER, SOURCE]);
    });

    it("kept the extra requirement out of the installed target", () => {
      expect(
        engine.fsReadDir(TARGET),
        "a build requirement belongs to the build environment, never to the install target",
      ).not.toContain("demo_marker");
    });
  },
);
