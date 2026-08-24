import type { HookTree, HookWrite } from "@tholus/engine-protocol";
import { type ExportVfs, exportTree, guard, type ImportVfs, importTree } from "./export-tree.js";

export interface RuntimeHookRequest {
  venv: string;
  script: string;
  sourceTree: string;
  env: Record<string, string>;
  path: string;
  outputDir?: string;
}

export interface RemoveVfs {
  fsKind(path: string): string | undefined;
  fsRemove(path: string): void;
  fsRemoveDir(path: string): void;
}

export type HookVfs = ExportVfs & ImportVfs & RemoveVfs;

function contains(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(`${outer}/`);
}

export function sitePackagesOf(vfs: ExportVfs, venv: string): string[] {
  const found: string[] = [];
  const consider = (path: string): void => {
    if (vfs.fsKind(path) === "directory") {
      found.push(path);
    }
  };
  if (vfs.fsKind(`${venv}/lib`) === "directory") {
    for (const name of [...vfs.fsReadDir(`${venv}/lib`)].sort()) {
      consider(`${venv}/lib/${name}/site-packages`);
    }
  }
  consider(`${venv}/Lib/site-packages`);
  return found;
}

export function hookTrees(vfs: ExportVfs, request: RuntimeHookRequest): HookTree[] {
  const trees: HookTree[] = [];
  const add = (root: string, collect: HookTree["collect"]): void => {
    if (vfs.fsKind(root) !== "directory") {
      return;
    }
    if (trees.some((tree) => contains(tree.root, root))) {
      return;
    }
    const { entries, bytes } = exportTree(vfs, root);
    trees.push({ root, collect, entries, bytes });
  };
  add(request.venv, "new");
  add(request.sourceTree, "changes");
  if (request.outputDir !== undefined) {
    add(request.outputDir, "changes");
  }
  return trees;
}

export function applyHookWrites(vfs: HookVfs, writes: readonly HookWrite[]): void {
  for (const write of writes) {
    for (const path of write.removed) {
      guard(path);
      const absolute = `${write.root}/${path}`;
      const kind = vfs.fsKind(absolute);
      if (kind === "directory") {
        vfs.fsRemoveDir(absolute);
      } else if (kind !== undefined) {
        vfs.fsRemove(absolute);
      }
    }
    importTree(vfs, write.root, write.entries, write.bytes);
  }
}
