import type { HookTree, HookWrite, TreeEntry } from "@uv-wasm/engine-protocol";
import type { PyodideFileSystem, PyodideLike } from "./facts.js";
import { runHook } from "./hook.js";
import { writeTree } from "./mount.js";

export interface HookInvocation {
  script: string;
  cwd: string;
  env: Record<string, string>;
  sitePackages: string[];
  trees: HookTree[];
}

export interface HookOutcome {
  stdout: string[];
  stderr: string[];
  code: number;
  writes: HookWrite[];
}

const DERIVED = "__pycache__";

type Node = { kind: "file"; bytes: Uint8Array } | { kind: "symlink"; target: string };

export interface Seen {
  path: string;
  node: Node;
}

function isDerived(path: string): boolean {
  return path.split("/").includes(DERIVED);
}

export function walkMirror(fs: PyodideFileSystem, root: string): Seen[] {
  const seen: Seen[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const name of [...fs.readdir(directory)].sort()) {
      if (name === "." || name === ".." || name === DERIVED) {
        continue;
      }
      const absolute = `${directory}/${name}`;
      const path = prefix === "" ? name : `${prefix}/${name}`;
      const { mode } = fs.lstat(absolute);
      if (fs.isLink(mode)) {
        seen.push({ path, node: { kind: "symlink", target: fs.readlink(absolute) } });
      } else if (fs.isDir(mode)) {
        visit(absolute, path);
      } else if (fs.isFile(mode)) {
        seen.push({
          path,
          node: { kind: "file", bytes: fs.readFile(absolute, { encoding: "binary" }) },
        });
      }
    }
  };
  visit(root, "");
  return seen;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function changed(tree: HookTree, before: TreeEntry, node: Node): boolean {
  if (before.kind === "symlink" && node.kind === "symlink") {
    return before.target !== node.target;
  }
  if (before.kind === "file" && node.kind === "file") {
    return !sameBytes(
      tree.bytes.subarray(before.offset, before.offset + before.length),
      node.bytes,
    );
  }
  return true;
}

function pack(kept: readonly Seen[]): { entries: TreeEntry[]; bytes: Uint8Array } {
  const total = kept.reduce(
    (sum, item) => (item.node.kind === "file" ? sum + item.node.bytes.byteLength : sum),
    0,
  );
  const bytes = new Uint8Array(total);
  const entries: TreeEntry[] = [];
  let offset = 0;
  for (const { path, node } of kept) {
    if (node.kind === "symlink") {
      entries.push({ kind: "symlink", path, target: node.target });
      continue;
    }
    bytes.set(node.bytes, offset);
    entries.push({ kind: "file", path, offset, length: node.bytes.byteLength });
    offset += node.bytes.byteLength;
  }
  return { entries, bytes };
}

export function collectWrite(tree: HookTree, seen: readonly Seen[]): HookWrite {
  const pushed = new Map(tree.entries.map((entry) => [entry.path, entry]));
  const kept = seen.filter((item) => {
    const before = pushed.get(item.path);
    if (before === undefined) {
      return true;
    }
    return tree.collect === "changes" && changed(tree, before, item.node);
  });

  const present = new Set(seen.map((item) => item.path));
  const removed =
    tree.collect === "changes"
      ? tree.entries
          .filter((entry) => !present.has(entry.path) && !isDerived(entry.path))
          .map((entry) => entry.path)
      : [];

  return { root: tree.root, ...pack(kept), removed };
}

export function removeMirror(fs: PyodideFileSystem, root: string): void {
  const visit = (directory: string): void => {
    for (const name of fs.readdir(directory)) {
      if (name === "." || name === "..") {
        continue;
      }
      const absolute = `${directory}/${name}`;
      const { mode } = fs.lstat(absolute);
      if (fs.isDir(mode) && !fs.isLink(mode)) {
        visit(absolute);
        fs.rmdir(absolute);
      } else {
        fs.unlink(absolute);
      }
    }
  };
  visit(root);
  fs.rmdir(root);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runBuildHook(pyodide: PyodideLike, invocation: HookInvocation): HookOutcome {
  const leftovers: string[] = [];
  const sweep = (): void => {
    for (const tree of invocation.trees) {
      try {
        removeMirror(pyodide.FS, tree.root);
      } catch (error) {
        leftovers.push(`${tree.root}: ${describe(error)}`);
      }
    }
  };

  try {
    for (const tree of invocation.trees) {
      writeTree(pyodide.FS, tree.root, tree.entries, tree.bytes);
    }
    const result = runHook(
      pyodide,
      { script: invocation.script, cwd: invocation.cwd, env: invocation.env },
      invocation.sitePackages,
    );
    const writes = invocation.trees.map((tree) =>
      collectWrite(tree, walkMirror(pyodide.FS, tree.root)),
    );
    sweep();
    return {
      ...result,
      stderr: [...result.stderr, ...leftovers.map((left) => `uv-wasm: ${left}`)],
      writes,
    };
  } catch (error) {
    sweep();
    throw error;
  }
}
