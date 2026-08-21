import { describe, expect, it } from "vitest";

import { type CacheVfs, hydrateCacheTree, readCacheTree } from "./cache-tree.js";
import type { CacheEntry } from "./cold-store.js";

const ROOT = "/home/browser/.cache/uv";

type Node = { kind: "file"; bytes: Uint8Array } | { kind: "symlink"; target: string };

class FakeVfs implements CacheVfs {
  readonly nodes = new Map<string, Node>();
  readonly directories = new Set<string>([ROOT]);

  file(path: string, bytes: string): this {
    this.parents(path);
    this.nodes.set(path, { kind: "file", bytes: new TextEncoder().encode(bytes) });
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

  fsReadDir(path: string): string[] {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const known of [...this.nodes.keys(), ...this.directories]) {
      if (known.startsWith(prefix)) {
        const rest = known.slice(prefix.length);
        const head = rest.split("/")[0];
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

  fsRead(path: string): Uint8Array {
    const node = this.nodes.get(path);
    if (node?.kind !== "file") {
      throw new Error(`${path} was not found`);
    }
    return node.bytes;
  }

  fsWrite(path: string, contents: Uint8Array): void {
    this.parents(path);
    this.nodes.set(path, { kind: "file", bytes: contents });
  }

  fsSymlink(target: string, link: string): void {
    this.parents(link);
    this.nodes.set(link, { kind: "symlink", target });
  }

  fsMkdirp(path: string): void {
    this.directories.add(path);
    this.parents(`${path}/x`);
  }

  fsExists(path: string): boolean {
    return this.nodes.has(path) || this.directories.has(path);
  }
}

describe("the walk turns the live cache into entries the manifest can diff", () => {
  it("reports nothing when the cache root does not exist", () => {
    expect(readCacheTree(new FakeVfs(), "/nowhere")).toEqual([]);
  });

  it("reports a file by a path relative to the root, so the root can move", () => {
    const vfs = new FakeVfs().file(`${ROOT}/simple-v24/index/abc/idna.rkyv`, "hello");
    expect(readCacheTree(vfs, ROOT)).toEqual([
      { kind: "file", path: "simple-v24/index/abc/idna.rkyv", size: 5 },
    ]);
  });

  it("sizes a file without reading its bytes, so a flush does not copy the whole cache", () => {
    const vfs = new FakeVfs().file(`${ROOT}/a`, "1234567890");
    const unreadable: CacheVfs = {
      fsReadDir: (path) => vfs.fsReadDir(path),
      fsKind: (path) => vfs.fsKind(path),
      fsSize: (path) => vfs.fsSize(path),
      fsReadLink: (path) => vfs.fsReadLink(path),
    };
    expect(readCacheTree(unreadable, ROOT)).toEqual([{ kind: "file", path: "a", size: 10 }]);
  });

  it("reports a symlink by its target rather than following it", () => {
    const vfs = new FakeVfs()
      .file(`${ROOT}/archive-v0/xyz/idna/__init__.py`, "x")
      .link(`${ROOT}/wheels-v6/index/abc/idna/3.11`, "../../../../archive-v0/xyz");
    expect(readCacheTree(vfs, ROOT)).toContainEqual({
      kind: "symlink",
      path: "wheels-v6/index/abc/idna/3.11",
      target: "../../../../archive-v0/xyz",
    });
  });

  it("descends through every directory it finds", () => {
    const vfs = new FakeVfs()
      .file(`${ROOT}/a/b/c/d/deep.txt`, "z")
      .file(`${ROOT}/CACHEDIR.TAG`, "Signature");
    expect(readCacheTree(vfs, ROOT).map((entry) => entry.path)).toEqual([
      "CACHEDIR.TAG",
      "a/b/c/d/deep.txt",
    ]);
  });

  it("keeps a stable order, so two walks of one cache diff to nothing", () => {
    const vfs = new FakeVfs().file(`${ROOT}/b`, "1").file(`${ROOT}/a`, "1").file(`${ROOT}/c`, "1");
    expect(readCacheTree(vfs, ROOT).map((entry) => entry.path)).toEqual(["a", "b", "c"]);
  });
});

describe("hydration puts a stored cache back where uv looks for it", () => {
  const load = (blobs: Record<string, string>) => async (path: string) => {
    const found = blobs[path];
    return found === undefined ? undefined : new TextEncoder().encode(found);
  };

  it("writes a file back under the root", async () => {
    const vfs = new FakeVfs();
    const entries: CacheEntry[] = [{ kind: "file", path: "simple-v24/idna.rkyv", size: 5 }];
    await hydrateCacheTree(vfs, ROOT, entries, load({ "simple-v24/idna.rkyv": "hello" }));
    expect(vfs.fsRead(`${ROOT}/simple-v24/idna.rkyv`)).toEqual(new TextEncoder().encode("hello"));
  });

  it("recreates a symlink with the target it was stored with", async () => {
    const vfs = new FakeVfs();
    const entries: CacheEntry[] = [
      { kind: "symlink", path: "wheels-v6/a", target: "../../archive-v0/xyz" },
    ];
    await hydrateCacheTree(vfs, ROOT, entries, load({}));
    expect(vfs.fsReadLink(`${ROOT}/wheels-v6/a`)).toBe("../../archive-v0/xyz");
  });

  it("round trips a walked cache unchanged", async () => {
    const source = new FakeVfs()
      .file(`${ROOT}/archive-v0/xyz/idna/__init__.py`, "import idna")
      .file(`${ROOT}/CACHEDIR.TAG`, "Signature")
      .link(`${ROOT}/wheels-v6/index/abc/idna/3.11`, "../../../../archive-v0/xyz");
    const entries = readCacheTree(source, ROOT);
    const blobs: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.kind === "file") {
        blobs[entry.path] = new TextDecoder().decode(source.fsRead(`${ROOT}/${entry.path}`));
      }
    }

    const target = new FakeVfs();
    await hydrateCacheTree(target, ROOT, entries, load(blobs));
    expect(readCacheTree(target, ROOT)).toEqual(entries);
  });

  it("reports the entry whose blob the store had lost, and hydrates the rest", async () => {
    const vfs = new FakeVfs();
    const entries: CacheEntry[] = [
      { kind: "file", path: "gone", size: 1 },
      { kind: "file", path: "here", size: 4 },
    ];
    const missing = await hydrateCacheTree(vfs, ROOT, entries, load({ here: "kept" }));
    expect(missing).toEqual(["gone"]);
    expect(vfs.fsExists(`${ROOT}/here`)).toBe(true);
    expect(vfs.fsExists(`${ROOT}/gone`)).toBe(false);
  });
});
