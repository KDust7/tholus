import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { PyodideLike } from "@tholus/pyodide";
import { beforeAll, describe, expect, it } from "vitest";

import { asPythonVersion } from "./pyodide-versions.js";

const manifestPath = process.env.UV_WASM_PYODIDE_MATRIX ?? "";
const asked = manifestPath !== "";

if (asked && !existsSync(manifestPath)) {
  throw new Error(
    `UV_WASM_PYODIDE_MATRIX names ${manifestPath}, which does not exist. Build it with ` +
      "scripts/install-pyodide-matrix.mjs; skipping would report the tripwire as armed when it is not.",
  );
}

interface Entry {
  channel: string;
  version: string;
  loader: string;
}

const entries: Entry[] = asked ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Entry[]) : [];

if (asked && entries.length < 2) {
  throw new Error(
    `the matrix holds ${entries.length} release, so it cannot compare channels; expected stable, previous and next`,
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

const ABI = `
import json, sys, sysconfig
json.dumps({
    "version": sys.version.split()[0],
    "suffix": sysconfig.get_config_var("EXT_SUFFIX") or "",
    "platform": sysconfig.get_platform(),
})
`;

describe.skipIf(!asked)("the adapter's surface across Pyodide channels", () => {
  for (const entry of entries) {
    describe(`${entry.channel}, pyodide ${entry.version}`, () => {
      let pyodide: PyodideLike;
      let failure: unknown;

      beforeAll(async () => {
        try {
          const { loadPyodide } = (await import(pathToFileURL(entry.loader).href)) as {
            loadPyodide: (options?: { indexURL?: string }) => Promise<PyodideLike>;
          };
          pyodide = await loadPyodide();
        } catch (error) {
          failure = error;
        }
      }, 900_000);

      it("loads at all", () => {
        expect(failure, `pyodide ${entry.version} would not start: ${String(failure)}`).toBe(
          undefined,
        );
        expect(
          pyodide.version,
          "npm spells a prerelease `-alpha.N` and Pyodide reports it `aN`; anything keying one to " +
            "the other breaks on the next channel",
        ).toBe(asPythonVersion(entry.version));
      });

      it.each(FILESYSTEM)("still exposes FS.%s", (member) => {
        expect(
          typeof (pyodide.FS as unknown as Record<string, unknown>)[member],
          `pyodide ${entry.version} drops FS.${member}; the mount adapter breaks on upgrade`,
        ).toBe("function");
      });

      it("still exposes the private dynamic-library loader", () => {
        expect(
          typeof pyodide._api?.loadDynlib,
          `pyodide ${entry.version} drops _api.loadDynlib. attachPyodide refuses loadDynlibs when ` +
            "it is absent, so upgrading to this release costs the dynlib bridge",
        ).toBe("function");
      });

      it("reports an abi whose extension suffix matches its own version", () => {
        const facts = JSON.parse(String(pyodide.runPython(ABI))) as {
          version: string;
          suffix: string;
          platform: string;
        };
        const [major, minor] = facts.version.split(".");
        expect(facts.suffix).toBe(`.cpython-${major}${minor}-wasm32-emscripten.so`);
        expect(facts.platform).toMatch(/^emscripten[-_]/);
      });
    });
  }
});
