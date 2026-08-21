import { describe, expect, it, vi } from "vitest";
import type { PyodideLike } from "./facts.js";
import {
  attachPyodide,
  DynlibApiUnavailable,
  PyodideProbeFailed,
  type TreeSource,
} from "./index.js";

const FACTS = {
  pythonVersion: "3.14.2",
  extensionSuffix: ".cpython-314-wasm32-emscripten.so",
  platform: "emscripten-5.0.3-wasm32",
  sitePackages: "/lib/python3.14/site-packages",
};

function fakePyodide(overrides: Partial<PyodideLike> = {}): PyodideLike & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    version: "314.0.5",
    FS: {
      writeFile: () => undefined,
      mkdirTree: () => undefined,
      symlink: () => undefined,
      analyzePath: () => ({ exists: false }),
    },
    runPython(code: string) {
      ran.push(code);
      return code.includes("sysconfig") ? JSON.stringify(FACTS) : "";
    },
    ...overrides,
  };
}

const source = (
  entries: { kind: "file"; path: string; offset: number; length: number }[],
): TreeSource => ({
  exportTree: async () => ({ entries, bytes: new Uint8Array(entries.length) }),
});

const pure = source([{ kind: "file", path: "idna/core.py", offset: 0, length: 1 }]);
const compiled = source([
  { kind: "file", path: "numpy/_m.cpython-314-wasm32-emscripten.so", offset: 0, length: 1 },
]);

describe("attaching reads the runtime rather than trusting a declaration", () => {
  it("reports the facts the live interpreter gives", () => {
    const runtime = attachPyodide(pure, fakePyodide());
    expect(runtime.facts).toEqual({ pyodideVersion: "314.0.5", ...FACTS });
  });
});

describe("mounting puts a uv environment on the runtime's path", () => {
  it("roots the mount under the venv's own name", async () => {
    const runtime = attachPyodide(pure, fakePyodide());
    const mounted = await runtime.mount("/work/.venv/lib/python3.14/site-packages");
    expect(mounted.path).toBe("/uv_envs/venv/site-packages");
    expect(mounted.from).toBe("/work/.venv/lib/python3.14/site-packages");
  });

  it("takes a name the host chose over the one it would derive", async () => {
    const runtime = attachPyodide(pure, fakePyodide());
    expect((await runtime.mount("/somewhere/site-packages", { name: "demo" })).path).toBe(
      "/uv_envs/demo/site-packages",
    );
  });

  it("adds exactly one sys.path entry, and only if it is not already there", async () => {
    const pyodide = fakePyodide();
    const runtime = attachPyodide(pure, pyodide);
    const mounted = await runtime.mount("/work/.venv/lib/python3.14/site-packages");
    const inserts = pyodide.ran.filter((code) => code.includes("sys.path.insert"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain(`not in sys.path`);
    expect(inserts[0]).toContain(mounted.path);
  });

  it("leaves extension modules for Pyodide to load when they are imported", async () => {
    const loadDynlib = vi.fn(async () => undefined);
    const pyodide = fakePyodide({ _api: { loadDynlib } });
    await attachPyodide(compiled, pyodide).mount("/work/.venv/lib/python3.14/site-packages");
    expect(
      loadDynlib,
      "preloading is 5x slower and changed nothing on Pyodide 314",
    ).not.toHaveBeenCalled();
  });

  it("preloads them when the host insists", async () => {
    const loadDynlib = vi.fn(async () => undefined);
    const pyodide = fakePyodide({ _api: { loadDynlib } });
    await attachPyodide(compiled, pyodide).mount("/env/site-packages", { loadDynlibs: true });
    expect(loadDynlib).toHaveBeenCalledWith(
      "/uv_envs/env/site-packages/numpy/_m.cpython-314-wasm32-emscripten.so",
      false,
    );
  });

  it("says so when the host insists and the runtime has no loader", async () => {
    const runtime = attachPyodide(compiled, fakePyodide({ _api: {} }));
    await expect(runtime.mount("/env/site-packages", { loadDynlibs: true })).rejects.toThrow(
      DynlibApiUnavailable,
    );
  });

  it("refuses an environment built for another runtime before writing any of it", async () => {
    const wrong = source([
      { kind: "file", path: "m.cpython-311-wasm32-emscripten.so", offset: 0, length: 1 },
    ]);
    const pyodide = fakePyodide();
    const writeFile = vi.fn();
    pyodide.FS.writeFile = writeFile;

    await expect(attachPyodide(wrong, pyodide).mount("/env/site-packages")).rejects.toThrow(
      /built for another runtime/,
    );
    expect(
      writeFile,
      "a refused mount must not leave half an environment behind",
    ).not.toHaveBeenCalled();
  });
});

describe("a runtime that will not describe itself is refused at attach", () => {
  it("says which runtime failed rather than surfacing a python traceback", () => {
    const broken = fakePyodide({
      runPython: () => {
        throw new Error("SystemError: interpreter is shutting down");
      },
    });
    expect(() => attachPyodide(pure, broken)).toThrow(PyodideProbeFailed);
    expect(() => attachPyodide(pure, broken)).toThrow(/would not describe itself/);
  });
});
