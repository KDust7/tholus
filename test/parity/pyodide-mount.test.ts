import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type ExportVfs, exportTree } from "@uv-wasm/core";
import { attachPyodide, type PyodideLike, type PyodideRuntime } from "@uv-wasm/pyodide";
import { beforeAll, describe, expect, it } from "vitest";

import { jsPath, PROGRAM, root, wasmPath } from "./cli-goldens.js";
import { startReplayServer } from "./replay-server.js";

const FIXTURE = resolve(root, "test/fixtures/install-pyodide");
const EXTENSION = "_cmsgpack.cpython-314-wasm32-emscripten.so";

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

if (process.env.CI && !canRun) {
  throw new Error(
    "the mount gate cannot run: the engine artifact or the install-pyodide fixture is missing. " +
      "Skipping here would report a gate that never ran.",
  );
}

interface EngineInstance extends ExportVfs {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  fsMkdirp(path: string): void;
  clearStdin(): void;
}

interface Snapshot {
  args: string[];
}

describe.skipIf(!canRun || !hasPyodide)(
  "an environment uv built inside wasm imports in a real Pyodide",
  () => {
    const target = "/mount/target";
    let runtime: PyodideRuntime;
    let pyodide: PyodideLike;
    let mounted: Awaited<ReturnType<PyodideRuntime["mount"]>>;
    let installCode: number;
    let installLog: string;

    beforeAll(async () => {
      const mod = (await import(pathToFileURL(jsPath).href)) as unknown as {
        default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
        Engine: new () => EngineInstance;
      };
      await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
      const engine = new mod.Engine();
      engine.clearStdin();
      engine.fsMkdirp("/mount");

      const snapshot = JSON.parse(
        await readFile(resolve(FIXTURE, "snapshot.json"), "utf8"),
      ) as Snapshot;
      const server = await startReplayServer(FIXTURE);
      const decoder = new TextDecoder();
      installLog = "";
      installCode = await engine.invoke(
        [PROGRAM, ...snapshot.args, "--index-url", `${server.origin}/simple`, "--target", target],
        (_stream, data) => {
          installLog += decoder.decode(data);
        },
      );
      await server.close();

      const { loadPyodide } = (await import("pyodide")) as {
        loadPyodide: () => Promise<PyodideLike>;
      };
      pyodide = await loadPyodide();
      runtime = attachPyodide({ exportTree: async (path) => exportTree(engine, path) }, pyodide);
      mounted = await runtime.mount(target, { name: "gate" });
    }, 600_000);

    it("installed the wheel uv resolved, extension module and all", () => {
      expect(installCode, `the install failed: ${installLog}`).toBe(0);
    });

    it("reads the runtime's own abi rather than trusting the profile", () => {
      expect(runtime.facts.extensionSuffix).toBe(".cpython-314-wasm32-emscripten.so");
      expect(runtime.facts.pythonVersion).toMatch(/^3\.14\./);
    });

    it("carried the compiled extension module across", () => {
      expect(mounted.dynlibs.map((path) => path.split("/").at(-1))).toContain(EXTENSION);
      expect(mounted.files).toBeGreaterThan(0);
      expect(mounted.bytes).toBeGreaterThan(0);
    });

    it("imports the package, and it is the mounted one and not Pyodide's", () => {
      const where = String(pyodide.runPython("import msgpack; msgpack.__file__"));
      expect(where, "an import that resolves elsewhere would pass while proving nothing").toContain(
        mounted.path,
      );
    });

    it("runs the compiled extension, not just the python that wraps it", () => {
      const answer = pyodide.runPython(
        "import msgpack; msgpack.unpackb(msgpack.packb({'uv': [1, 2, 3]}))['uv']",
      );
      expect(String(answer)).toContain("1");
      expect(
        String(pyodide.runPython("msgpack._cmsgpack.__name__")),
        "the pure-python fallback would answer the same, so name the C module",
      ).toBe("msgpack._cmsgpack");
    });
  },
);
