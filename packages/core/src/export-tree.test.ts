import { describe, expect, it } from "vitest";

import { type ExportVfs, exportTree, MAX_EXPORT_BYTES } from "./export-tree.js";

const encoder = new TextEncoder();

class FakeVfs implements ExportVfs {
  readonly nodes = new Map<
    string,
    { kind: "file"; bytes: Uint8Array } | { kind: "symlink"; target: string }
  >();
  readonly directories = new Set<string>();
  sizes: Map<string, number> = new Map();

  file(path: string, body: string): this {
    this.parents(path);
    this.nodes.set(path, { kind: "file", bytes: encoder.encode(body) });
    return this;
  }

  link(path: string, target: string): this {
    this.parents(path);
    this.nodes.set(path, { kind: "symlink", target });
    return this;
  }

  private parents(path: string): void {
    const parts = path.split("/");
    for (let index = parts.length - 1; index > 1; index -= 1) {
      this.directories.add(parts.slice(0, index).join("/"));
    }
  }

  fsRead(path: string): Uint8Array {
    const node = this.nodes.get(path);
    if (node?.kind !== "file") {
      throw new Error(`${path} was not found`);
    }
    return node.bytes;
  }

  fsReadDir(path: string): string[] {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const known of [...this.nodes.keys(), ...this.directories]) {
      if (known.startsWith(prefix)) {
        const head = known.slice(prefix.length).split("/")[0];
        if (head !== undefined && head !== "") {
          names.add(head);
        }
      }
    }
    return [...names].sort();
  }

  fsKind(path: string): string | undefined {
    const node = this.nodes.get(path);
    if (node) {
      return node.kind === "file" ? "file" : "symlink";
    }
    return this.directories.has(path) ? "directory" : undefined;
  }

  fsSize(path: string): number {
    const forced = this.sizes.get(path);
    if (forced !== undefined) {
      return forced;
    }
    const node = this.nodes.get(path);
    return node?.kind === "file" ? node.bytes.byteLength : 0;
  }

  fsReadLink(path: string): string {
    const node = this.nodes.get(path);
    if (node?.kind !== "symlink") {
      throw new Error(`${path} is not a symbolic link`);
    }
    return node.target;
  }
}

const ROOT = "/work/.venv/lib/python3.14/site-packages";

const textAt = (bytes: Uint8Array, offset: number, length: number): string =>
  new TextDecoder().decode(bytes.subarray(offset, offset + length));

describe("a tree leaves the engine as one buffer and a table of where things are", () => {
  it("packs every file end to end, with no gaps between them", () => {
    const vfs = new FakeVfs().file(`${ROOT}/idna/__init__.py`, "one").file(`${ROOT}/six.py`, "two");
    const { entries, bytes } = exportTree(vfs, ROOT);

    expect(bytes.byteLength).toBe(6);
    expect(entries).toEqual([
      { kind: "file", path: "idna/__init__.py", offset: 0, length: 3 },
      { kind: "file", path: "six.py", offset: 3, length: 3 },
    ]);
    expect(textAt(bytes, 0, 3)).toBe("one");
    expect(textAt(bytes, 3, 3)).toBe("two");
  });

  it("names paths relative to the root, so the reader can re-root them", () => {
    const vfs = new FakeVfs().file(`${ROOT}/a/b/c.py`, "x");
    expect(exportTree(vfs, ROOT).entries[0]).toMatchObject({ path: "a/b/c.py" });
  });

  it("carries a symlink as its target, because it has no bytes to carry", () => {
    const vfs = new FakeVfs().file(`${ROOT}/real.py`, "x").link(`${ROOT}/alias.py`, "real.py");
    const { entries, bytes } = exportTree(vfs, ROOT);

    expect(bytes.byteLength).toBe(1);
    expect(entries).toContainEqual({ kind: "symlink", path: "alias.py", target: "real.py" });
  });

  it("exports an empty tree as an empty buffer rather than failing", () => {
    const vfs = new FakeVfs();
    vfs.fsReadDir(ROOT);
    vfs.file(`${ROOT}/x`, "");
    vfs.nodes.delete(`${ROOT}/x`);
    expect(exportTree(vfs, ROOT)).toEqual({ entries: [], bytes: new Uint8Array(0) });
  });

  it("refuses a path that is not a directory, rather than exporting nothing", () => {
    const vfs = new FakeVfs().file(`${ROOT}/a.py`, "x");
    expect(() => exportTree(vfs, `${ROOT}/a.py`)).toThrow(/not a directory/);
  });

  it("refuses a tree too large to hold in one buffer", () => {
    const vfs = new FakeVfs().file(`${ROOT}/big`, "x");
    vfs.sizes.set(`${ROOT}/big`, MAX_EXPORT_BYTES + 1);
    expect(() => exportTree(vfs, ROOT)).toThrow(RangeError);
  });

  it("refuses a file that reads a different length than it measured", () => {
    const vfs = new FakeVfs().file(`${ROOT}/a.py`, "hello");
    vfs.sizes.set(`${ROOT}/a.py`, 2);
    expect(() => exportTree(vfs, ROOT)).toThrow(/measured 2 bytes and read 5/);
  });
});
