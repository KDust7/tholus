import { createRequire } from "node:module";
import type { PyodideLike } from "@uv-wasm/pyodide";
import { beforeAll, describe, expect, it } from "vitest";

import { asPythonVersion } from "./pyodide-versions.js";

const require = createRequire(import.meta.url);
const hasPyodide = ((): boolean => {
  try {
    require.resolve("pyodide");
    return true;
  } catch {
    return false;
  }
})();

if (process.env.CI && !hasPyodide) {
  throw new Error(
    "the Pyodide surface tripwire cannot run: the `pyodide` package is not installed. " +
      "Skipping here would report the adapter's dependencies as intact while checking nothing.",
  );
}

const FILESYSTEM = [
  "writeFile",
  "mkdirTree",
  "symlink",
  "analyzePath",
  "readFile",
  "readdir",
  "lstat",
  "readlink",
  "unlink",
  "rmdir",
  "isDir",
  "isFile",
  "isLink",
] as const;

const PINNED = (require("pyodide/package.json") as { version?: string }).version ?? "";

describe.skipIf(!hasPyodide)("the Pyodide surface the adapter reaches for", () => {
  let pyodide: PyodideLike;

  beforeAll(async () => {
    const { loadPyodide } = (await import("pyodide")) as {
      loadPyodide: () => Promise<PyodideLike>;
    };
    pyodide = await loadPyodide();
  }, 600_000);

  it("is the version this repository pins", () => {
    expect(PINNED, "the pyodide dependency carries no version").not.toBe("");
    expect(pyodide.version).toBe(asPythonVersion(PINNED));
  });

  it.each(FILESYSTEM)("still exposes FS.%s", (member) => {
    expect(
      typeof (pyodide.FS as unknown as Record<string, unknown>)[member],
      `Pyodide ${pyodide.version} no longer exposes FS.${member}; the mount adapter is broken`,
    ).toBe("function");
  });

  it("still runs Python through the public entry point", () => {
    expect(pyodide.runPython("1 + 1")).toBe(2);
  });

  it("still exposes the private dynamic-library loader, or says so loudly", () => {
    const load = pyodide._api?.loadDynlib;
    expect(
      typeof load,
      `Pyodide ${pyodide.version} dropped _api.loadDynlib. attachPyodide refuses loadDynlibs ` +
        "when it is absent, so this is a capability regression rather than a crash.",
    ).toBe("function");
  });

  it("describes an abi the seeded interpreter profile can match", () => {
    const raw = String(
      pyodide.runPython(`
import json, sys, sysconfig
json.dumps({
    "version": sys.version.split()[0],
    "suffix": sysconfig.get_config_var("EXT_SUFFIX") or "",
    "platform": sysconfig.get_platform(),
})
`),
    );
    const facts = JSON.parse(raw) as { version: string; suffix: string; platform: string };
    const [major, minor] = facts.version.split(".");
    expect(facts.suffix).toBe(`.cpython-${major}${minor}-wasm32-emscripten.so`);
    expect(facts.platform).toMatch(/^emscripten[-_]/);
    expect(facts.version).toMatch(/^3\.\d+\.\d+$/);
  });

  it("bundles none of the packages the port must resolve itself", () => {
    const raw = String(
      pyodide.runPython(`
import importlib.util, json
names = ("json", "sqlite3", "micropip", "numpy", "requests")
json.dumps([name for name in names if importlib.util.find_spec(name) is None])
`),
    );
    const missing = JSON.parse(raw) as string[];
    expect(
      missing,
      "the probe reports the standard library missing, so it would call anything absent",
    ).not.toContain("json");
    expect(missing).not.toContain("sqlite3");
    expect(
      missing,
      "Pyodide now bundles something the port assumes it must install; revisit the adapter",
    ).toEqual(["micropip", "numpy", "requests"]);
  });
});
