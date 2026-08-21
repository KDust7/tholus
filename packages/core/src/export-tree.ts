import type { TreeEntry } from "@uv-wasm/engine-protocol";

export interface ExportVfs {
  fsRead(path: string): Uint8Array;
  fsReadDir(path: string): string[];
  fsKind(path: string): string | undefined;
  fsSize(path: string): number;
  fsReadLink(path: string): string;
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
