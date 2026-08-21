import type { TreeEntry } from "@uv-wasm/engine-protocol";
import type { PyodideFacts, PyodideFileSystem } from "./facts.js";

export const MOUNT_ROOT = "/uv_envs";

const PORTABLE = new Set([".so", ".abi3.so"]);

export class AbiMismatch extends Error {
  readonly offenders: string[];

  constructor(expected: string, offenders: string[]) {
    super(
      `this environment holds extension modules built for another runtime; ` +
        `Pyodide loads ${expected} but found ${[...new Set(offenders)].sort().join(", ")}`,
    );
    this.name = "AbiMismatch";
    this.offenders = offenders;
  }
}

function extensionSuffixOf(path: string): string | undefined {
  if (!path.endsWith(".so")) {
    return undefined;
  }
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.indexOf(".");
  return dot === -1 ? undefined : name.slice(dot);
}

export function checkAbi(entries: readonly TreeEntry[], facts: PyodideFacts): void {
  const offenders = entries
    .map((entry) => extensionSuffixOf(entry.path))
    .filter((suffix): suffix is string => suffix !== undefined)
    .filter((suffix) => suffix !== facts.extensionSuffix && !PORTABLE.has(suffix));
  if (offenders.length > 0) {
    throw new AbiMismatch(facts.extensionSuffix, offenders);
  }
}

export function parentOf(path: string): string | undefined {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? undefined : path.slice(0, cut);
}

export interface WrittenTree {
  files: number;
  links: number;
  bytes: number;
  dynlibs: string[];
}

export function writeTree(
  fs: PyodideFileSystem,
  root: string,
  entries: readonly TreeEntry[],
  bytes: Uint8Array,
): WrittenTree {
  fs.mkdirTree(root);
  const made = new Set<string>([root]);
  const ensure = (path: string): void => {
    const parent = parentOf(path);
    if (parent === undefined || made.has(`${root}/${parent}`)) {
      return;
    }
    fs.mkdirTree(`${root}/${parent}`);
    made.add(`${root}/${parent}`);
  };

  const written: WrittenTree = { files: 0, links: 0, bytes: 0, dynlibs: [] };
  for (const entry of entries) {
    ensure(entry.path);
    const target = `${root}/${entry.path}`;
    if (entry.kind === "symlink") {
      if (!fs.analyzePath(target).exists) {
        fs.symlink(entry.target, target);
        written.links += 1;
      }
      continue;
    }
    fs.writeFile(target, bytes.subarray(entry.offset, entry.offset + entry.length));
    written.files += 1;
    written.bytes += entry.length;
    if (entry.path.endsWith(".so")) {
      written.dynlibs.push(target);
    }
  }
  return written;
}
