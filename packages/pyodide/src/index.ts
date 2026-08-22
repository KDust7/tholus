import type { ExportedTree } from "@uv-wasm/core";
import { type PyodideFacts, type PyodideLike, probePyodide } from "./facts.js";
import { checkAbi, MOUNT_ROOT, type WrittenTree, writeTree } from "./mount.js";

export * from "./facts.js";
export * from "./hook.js";
export * from "./mount.js";

export interface TreeSource {
  exportTree(path: string): Promise<ExportedTree>;
}

export interface MountOptions {
  name?: string;
  loadDynlibs?: true;
}

export interface MountedEnv extends WrittenTree {
  path: string;
  from: string;
}

export interface PyodideRuntime {
  facts: PyodideFacts;
  mount(sitePackages: string, options?: MountOptions): Promise<MountedEnv>;
}

export class DynlibApiUnavailable extends Error {
  constructor(version: string) {
    super(
      `Pyodide ${version} exposes no dynamic-library loader, so loadDynlibs cannot be honored; ` +
        "omit it and let Pyodide load extension modules when they are imported",
    );
    this.name = "DynlibApiUnavailable";
  }
}

function nameFrom(sitePackages: string, given: string | undefined): string {
  if (given !== undefined) {
    return given;
  }
  const parts = sitePackages.split("/").filter((part) => part !== "");
  const venv = parts.findIndex((part) => part.endsWith(".venv") || part === "venv");
  return venv === -1 ? "env" : (parts[venv] as string).replace(/^\./, "");
}

export function attachPyodide(engine: TreeSource, pyodide: PyodideLike): PyodideRuntime {
  const facts = probePyodide(pyodide);

  return {
    facts,
    async mount(sitePackages, options = {}): Promise<MountedEnv> {
      const { entries, bytes } = await engine.exportTree(sitePackages);
      checkAbi(entries, facts);

      const root = `${MOUNT_ROOT}/${nameFrom(sitePackages, options.name)}/site-packages`;
      const written = writeTree(pyodide.FS, root, entries, bytes);

      if (written.dynlibs.length > 0 && options.loadDynlibs === true) {
        const load = pyodide._api?.loadDynlib;
        if (load === undefined) {
          throw new DynlibApiUnavailable(facts.pyodideVersion);
        }
        for (const path of written.dynlibs) {
          await load(path, false);
        }
      }

      pyodide.runPython(
        `import sys\nif ${JSON.stringify(root)} not in sys.path:\n    sys.path.insert(0, ${JSON.stringify(root)})\n`,
      );
      return { ...written, path: root, from: sitePackages };
    },
  };
}
