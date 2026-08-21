import type { TreeEntry } from "@uv-wasm/engine-protocol";

export interface ExportVfs {
  fsRead(path: string): Uint8Array;
  fsReadDir(path: string): string[];
  fsKind(path: string): string | undefined;
  fsSize(path: string): number;
  fsReadLink(path: string): string;
}

export interface ImportVfs {
  fsWrite(path: string, contents: Uint8Array): void;
  fsSymlink(target: string, link: string): void;
  fsMkdirp(path: string): void;
  fsKind(path: string): string | undefined;
}

export interface ExportedTree {
  entries: TreeEntry[];
  bytes: Uint8Array;
}

interface Found {
  path: string;
  node: { kind: "file"; size: number } | { kind: "symlink"; target: string };
}

function collect(vfs: ExportVfs, root: string): Found[] {
  const found: Found[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const name of [...vfs.fsReadDir(directory)].sort()) {
      const absolute = `${directory}/${name}`;
      const path = prefix === "" ? name : `${prefix}/${name}`;
      switch (vfs.fsKind(absolute)) {
        case "directory":
          walk(absolute, path);
          break;
        case "symlink":
          found.push({ path, node: { kind: "symlink", target: vfs.fsReadLink(absolute) } });
          break;
        case "file":
          found.push({ path, node: { kind: "file", size: vfs.fsSize(absolute) } });
          break;
      }
    }
  };
  walk(root, "");
  return found;
}

export const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;

export function exportTree(vfs: ExportVfs, root: string): ExportedTree {
  if (vfs.fsKind(root) !== "directory") {
    throw new Error(`${root} is not a directory in the engine's filesystem`);
  }

  const found = collect(vfs, root);
  const total = found.reduce(
    (sum, entry) => (entry.node.kind === "file" ? sum + entry.node.size : sum),
    0,
  );
  if (total > MAX_EXPORT_BYTES) {
    throw new RangeError(
      `${root} holds ${total} bytes, which exceeds the ${MAX_EXPORT_BYTES}-byte export limit`,
    );
  }

  const bytes = new Uint8Array(total);
  const entries: TreeEntry[] = [];
  let offset = 0;
  for (const { path, node } of found) {
    if (node.kind === "symlink") {
      entries.push({ kind: "symlink", path, target: node.target });
      continue;
    }
    const contents = vfs.fsRead(`${root}/${path}`);
    if (contents.byteLength !== node.size) {
      throw new Error(
        `${root}/${path} measured ${node.size} bytes and read ${contents.byteLength}`,
      );
    }
    bytes.set(contents, offset);
    entries.push({ kind: "file", path, offset, length: contents.byteLength });
    offset += contents.byteLength;
  }
  return { entries, bytes };
}

export interface ImportedTree {
  files: number;
  links: number;
  bytes: number;
}

function guard(path: string): void {
  const parts = path.split("/");
  if (path.startsWith("/") || parts.some((part) => part === ".." || part === "" || part === ".")) {
    throw new Error(`${path} does not name a place inside the imported tree`);
  }
}

export function importTree(
  vfs: ImportVfs,
  root: string,
  entries: readonly TreeEntry[],
  bytes: Uint8Array,
): ImportedTree {
  for (const entry of entries) {
    guard(entry.path);
    if (entry.kind === "file" && entry.offset + entry.length > bytes.byteLength) {
      throw new RangeError(`${entry.path} reaches past the ${bytes.byteLength} bytes it was sent`);
    }
  }

  vfs.fsMkdirp(root);
  const imported: ImportedTree = { files: 0, links: 0, bytes: 0 };
  for (const entry of entries) {
    if (entry.kind === "symlink") {
      continue;
    }
    vfs.fsWrite(`${root}/${entry.path}`, bytes.subarray(entry.offset, entry.offset + entry.length));
    imported.files += 1;
    imported.bytes += entry.length;
  }
  for (const entry of entries) {
    if (entry.kind === "symlink") {
      vfs.fsSymlink(entry.target, `${root}/${entry.path}`);
      imported.links += 1;
    }
  }
  return imported;
}
