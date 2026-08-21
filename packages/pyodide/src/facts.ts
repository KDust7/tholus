export interface PyodideFileSystem {
  writeFile(path: string, data: Uint8Array, options?: { encoding?: string }): void;
  mkdirTree(path: string): void;
  symlink(target: string, link: string): void;
  analyzePath(path: string): { exists: boolean };
}

export interface PyodideLike {
  version: string;
  FS: PyodideFileSystem;
  runPython(code: string): unknown;
  _api?: { loadDynlib?: (path: string, global?: boolean) => Promise<void> };
}

export interface PyodideFacts {
  pyodideVersion: string;
  pythonVersion: string;
  extensionSuffix: string;
  platform: string;
  sitePackages: string;
}

const PROBE = `
import json, site, sys, sysconfig
json.dumps({
    "pythonVersion": sys.version.split()[0],
    "extensionSuffix": sysconfig.get_config_var("EXT_SUFFIX") or "",
    "platform": sysconfig.get_platform(),
    "sitePackages": (site.getsitepackages() or [""])[0],
})
`;

export class PyodideProbeFailed extends Error {
  constructor(cause: unknown) {
    super(`the Pyodide runtime would not describe itself: ${String(cause)}`);
    this.name = "PyodideProbeFailed";
  }
}

export function probePyodide(pyodide: PyodideLike): PyodideFacts {
  let raw: string;
  try {
    raw = String(pyodide.runPython(PROBE));
  } catch (error) {
    throw new PyodideProbeFailed(error);
  }
  const parsed = JSON.parse(raw) as Omit<PyodideFacts, "pyodideVersion">;
  return { pyodideVersion: pyodide.version, ...parsed };
}
