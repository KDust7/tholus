import { type CacheEntry, groupByUnit } from "./cold-store.js";

export interface CacheVfs {
  fsReadDir(path: string): string[];
  fsKind(path: string): string | undefined;
  fsSize(path: string): number;
  fsReadLink(path: string): string;
}

export interface HydrateVfs {
  fsWrite(path: string, contents: Uint8Array): void;
  fsSymlink(target: string, link: string): void;
  fsMkdirp(path: string): void;
}

export type LoadBlob = (path: string) => Promise<Uint8Array | undefined>;

export function readCacheTree(vfs: CacheVfs, root: string): CacheEntry[] {
  const entries: CacheEntry[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const name of [...vfs.fsReadDir(directory)].sort()) {
      const absolute = `${directory}/${name}`;
      const path = prefix === "" ? name : `${prefix}/${name}`;
      switch (vfs.fsKind(absolute)) {
        case "directory":
          walk(absolute, path);
          break;
        case "symlink":
          entries.push({ kind: "symlink", path, target: vfs.fsReadLink(absolute) });
          break;
        case "file":
          entries.push({ kind: "file", path, size: vfs.fsSize(absolute) });
          break;
      }
    }
  };
  if (vfs.fsKind(root) !== "directory") {
    return entries;
  }
  walk(root, "");
  return entries;
}

async function loadUnit(
  members: readonly CacheEntry[],
  load: LoadBlob,
): Promise<[string, Uint8Array][] | undefined> {
  const loaded: [string, Uint8Array][] = [];
  for (const entry of members) {
    if (entry.kind === "symlink") {
      continue;
    }
    const bytes = await load(entry.path);
    if (bytes === undefined) {
      return undefined;
    }
    loaded.push([entry.path, bytes]);
  }
  return loaded;
}

export async function hydrateCacheTree(
  vfs: HydrateVfs,
  root: string,
  entries: readonly CacheEntry[],
  load: LoadBlob,
): Promise<string[]> {
  const missing: string[] = [];
  const links: CacheEntry[] = [];
  vfs.fsMkdirp(root);
  for (const [, members] of groupByUnit(entries, (entry) => entry.path)) {
    const loaded = await loadUnit(members, load);
    if (loaded === undefined) {
      missing.push(...members.map((entry) => entry.path));
      continue;
    }
    for (const [path, bytes] of loaded) {
      vfs.fsWrite(`${root}/${path}`, bytes);
    }
    links.push(...members.filter((entry) => entry.kind === "symlink"));
  }
  for (const entry of links) {
    if (entry.kind === "symlink") {
      vfs.fsSymlink(entry.target, `${root}/${entry.path}`);
    }
  }
  return missing;
}
