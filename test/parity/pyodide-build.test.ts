import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { applyHookWrites, type HookVfs, hookTrees, sitePackagesOf } from "@uv-wasm/core";
import { attachPyodide, type PyodideLike, type PyodideRuntime } from "@uv-wasm/pyodide";
import { beforeAll, describe, expect, it } from "vitest";

import { jsPath, wasmPath } from "./cli-goldens.js";

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
    "the build-hook gate cannot run: the engine artifact or the `pyodide` package is missing. " +
      "Skipping here would report phase 5's seam as green while never running a hook.",
  );
}

const VENV = "/cache/builds-v0/tmp1";
const SOURCE = "/work/demo";
const WHEELS = "/cache/wheels";
const OUTFILE = `${VENV}/build_wheel.txt`;
const WHEEL = "demo-0.1.0-py3-none-any.whl";

const BACKEND = `import os


def get_requires_for_build_wheel(config_settings=None):
    return []


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    with open(os.path.join(wheel_directory, ${JSON.stringify(WHEEL)}), "w") as fp:
        fp.write("built in " + os.getcwd())
    return ${JSON.stringify(WHEEL)}
`;

const quoted = (value: string): string => JSON.stringify(value);

const SCRIPT = [
  "import demo_backend",
  "backend = demo_backend",
  "",
  `wheel_filename = backend.build_wheel(${quoted(WHEELS)}, {}, None)`,
  `with open(${quoted(OUTFILE)}, "w") as fp:`,
  "    fp.write(wheel_filename)",
].join("\n");

interface EngineInstance extends HookVfs {
  fsWrite(path: string, contents: Uint8Array): void;
  fsMkdirp(path: string): void;
  clearStdin(): void;
}

describe.skipIf(!canRun || !hasPyodide)(
  "a PEP 517 hook runs in a real Pyodide and its output lands back in uv's filesystem",
  () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let engine: EngineInstance;
    let pyodide: PyodideLike;
    let runtime: PyodideRuntime;
    let code: number;
    let stderr: string[];

    const text = (path: string): string => decoder.decode(engine.fsRead(path));

    beforeAll(async () => {
      const mod = (await import(pathToFileURL(jsPath).href)) as unknown as {
        default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
        Engine: new () => EngineInstance;
      };
      await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
      engine = new mod.Engine();

      engine.fsWrite(
        `${VENV}/lib/python3.14/site-packages/demo_backend.py`,
        encoder.encode(BACKEND),
      );
      engine.fsWrite(`${VENV}/pyvenv.cfg`, encoder.encode("home = /bin\n"));
      engine.fsWrite(`${SOURCE}/pyproject.toml`, encoder.encode("[project]\nname = 'demo'\n"));
      engine.fsMkdirp(WHEELS);

      const { loadPyodide } = (await import("pyodide")) as {
        loadPyodide: () => Promise<PyodideLike>;
      };
      pyodide = await loadPyodide();
      runtime = attachPyodide({ exportTree: () => Promise.reject(new Error("unused")) }, pyodide);

      const request = {
        venv: VENV,
        script: SCRIPT,
        sourceTree: SOURCE,
        env: { PEP517: "1" },
        path: `${VENV}/bin`,
        outputDir: WHEELS,
      };
      const outcome = await runtime.hook({
        script: request.script,
        cwd: request.sourceTree,
        env: request.env,
        sitePackages: sitePackagesOf(engine, VENV),
        trees: hookTrees(engine, request),
      });
      code = outcome.code;
      stderr = outcome.stderr;
      applyHookWrites(engine, outcome.writes);
    }, 600_000);

    it("ran the backend without error", () => {
      expect(code, `the hook failed: ${stderr.join("\n")}`).toBe(0);
    });

    it("brought back the file uv reads the built wheel's name out of", () => {
      expect(text(OUTFILE)).toBe(WHEEL);
    });

    it("brought back the wheel itself, from a directory uv only ever named inside the script", () => {
      expect(
        engine.fsKind(`${WHEELS}/${WHEEL}`),
        "the output directory reaches the runtime only because HookRequest carries it",
      ).toBe("file");
    });

    it("ran the hook in the source tree, so a backend that reads the cwd sees the project", () => {
      expect(text(`${WHEELS}/${WHEEL}`)).toBe(`built in ${SOURCE}`);
    });

    it("imported the backend from the build venv rather than from Pyodide's own packages", () => {
      expect(String(pyodide.runPython("'demo_backend' in __import__('sys').modules"))).toBe("true");
    });

    it("swept its mirror, so the next build cannot inherit this one's files", () => {
      expect(pyodide.FS.analyzePath(VENV).exists).toBe(false);
      expect(pyodide.FS.analyzePath(SOURCE).exists).toBe(false);
      expect(pyodide.FS.analyzePath(WHEELS).exists).toBe(false);
    });
  },
);
