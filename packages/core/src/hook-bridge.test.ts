import type { HookWrite, TreeEntry } from "@uv-wasm/engine-protocol";
import { describe, expect, it } from "vitest";
import {
  applyHookWrites,
  type HookVfs,
  hookTrees,
  type RuntimeHookRequest,
  sitePackagesOf,
} from "./hook-bridge.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Node = { kind: "file"; bytes: Uint8Array } | { kind: "symlink"; target: string };

class FakeVfs implements HookVfs {
  readonly nodes = new Map<string, Node>();
  readonly folders = new Set<string>();

  private ancestors(path: string): void {
    const parts = path.split("/");
    for (let index = parts.length - 1; index > 1; index -= 1) {
      this.folders.add(parts.slice(0, index).join("/"));
    }
  }

  seed(path: string, contents: string): void {
    this.fsWrite(path, encoder.encode(contents));
  }

  fsRead(path: string): Uint8Array {
    const node = this.nodes.get(path);
    if (node?.kind !== "file") {
      throw new Error(`${path} was not found`);
    }
    return node.bytes;
  }

  fsWrite(path: string, contents: Uint8Array): void {
    this.ancestors(path);
    this.nodes.set(path, { kind: "file", bytes: contents });
  }

  fsReadDir(path: string): string[] {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const known of [...this.nodes.keys(), ...this.folders]) {
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
    return this.folders.has(path) ? "directory" : undefined;
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

  fsSymlink(target: string, link: string): void {
    this.ancestors(link);
    this.nodes.set(link, { kind: "symlink", target });
  }

  fsMkdirp(path: string): void {
    this.folders.add(path);
    this.ancestors(`${path}/x`);
  }

  fsRemove(path: string): void {
    if (!this.nodes.delete(path)) {
      throw new Error(`${path} was not found`);
    }
  }

  fsRemoveDir(path: string): void {
    const prefix = `${path}/`;
    for (const known of [...this.nodes.keys()]) {
      if (known.startsWith(prefix)) {
        this.nodes.delete(known);
      }
    }
    for (const known of [...this.folders]) {
      if (known === path || known.startsWith(prefix)) {
        this.folders.delete(known);
      }
    }
  }

  text(path: string): string {
    return decoder.decode(this.fsRead(path));
  }
}

const request = (overrides: Partial<RuntimeHookRequest> = {}): RuntimeHookRequest => ({
  venv: "/cache/builds-v0/tmp1",
  script: "print('x')",
  sourceTree: "/work/demo",
  env: {},
  path: "/cache/builds-v0/tmp1/bin",
  ...overrides,
});

describe("the venv's site-packages is found the way uv lays it out", () => {
  it("finds the interpreter's site-packages under lib", () => {
    const vfs = new FakeVfs();
    vfs.seed("/cache/builds-v0/tmp1/lib/python3.14/site-packages/setuptools/__init__.py", "");
    expect(sitePackagesOf(vfs, "/cache/builds-v0/tmp1")).toEqual([
      "/cache/builds-v0/tmp1/lib/python3.14/site-packages",
    ]);
  });

  it("reports none when the venv has no site-packages at all", () => {
    const vfs = new FakeVfs();
    vfs.seed("/cache/builds-v0/tmp1/pyvenv.cfg", "home = /bin");
    expect(sitePackagesOf(vfs, "/cache/builds-v0/tmp1")).toEqual([]);
  });
});

describe("the trees a hook needs are chosen by direction, not by name", () => {
  it("asks for new files from the venv and for changes everywhere else", () => {
    const vfs = new FakeVfs();
    vfs.seed("/cache/builds-v0/tmp1/pyvenv.cfg", "home = /bin");
    vfs.seed("/work/demo/pyproject.toml", "[project]");
    vfs.fsMkdirp("/cache/wheels");

    const trees = hookTrees(vfs, request({ outputDir: "/cache/wheels" }));
    expect(trees.map((tree) => [tree.root, tree.collect])).toEqual([
      ["/cache/builds-v0/tmp1", "new"],
      ["/work/demo", "changes"],
      ["/cache/wheels", "changes"],
    ]);
    expect(decoder.decode(trees[0]?.bytes)).toBe("home = /bin");
  });

  it("does not mirror an output directory that sits inside a tree already sent", () => {
    const vfs = new FakeVfs();
    vfs.seed("/cache/builds-v0/tmp1/pyvenv.cfg", "home = /bin");
    vfs.seed("/work/demo/pyproject.toml", "[project]");
    vfs.fsMkdirp("/work/demo/dist");

    const trees = hookTrees(vfs, request({ outputDir: "/work/demo/dist" }));
    expect(trees.map((tree) => tree.root)).toEqual(["/cache/builds-v0/tmp1", "/work/demo"]);
  });

  it("skips a root the engine's filesystem does not have", () => {
    const vfs = new FakeVfs();
    vfs.seed("/work/demo/pyproject.toml", "[project]");
    expect(hookTrees(vfs, request()).map((tree) => tree.root)).toEqual(["/work/demo"]);
  });
});

describe("what the runtime wrote comes back before uv looks for it", () => {
  const file = (path: string, offset: number, length: number): TreeEntry => ({
    kind: "file",
    path,
    offset,
    length,
  });

  it("writes new files into the engine's filesystem", () => {
    const vfs = new FakeVfs();
    const write: HookWrite = {
      root: "/cache/builds-v0/tmp1",
      entries: [file("build_wheel.txt", 0, 9)],
      bytes: encoder.encode("demo.whl\n"),
      removed: [],
    };
    applyHookWrites(vfs, [write]);
    expect(vfs.text("/cache/builds-v0/tmp1/build_wheel.txt")).toBe("demo.whl\n");
  });

  it("removes what the backend deleted, so a stale file cannot be resurrected", () => {
    const vfs = new FakeVfs();
    vfs.seed("/work/demo/build/lib/old.py", "stale");
    vfs.seed("/work/demo/build/lib/kept.py", "live");

    applyHookWrites(vfs, [
      { root: "/work/demo", entries: [], bytes: new Uint8Array(0), removed: ["build/lib/old.py"] },
    ]);

    expect(vfs.fsKind("/work/demo/build/lib/old.py")).toBeUndefined();
    expect(vfs.text("/work/demo/build/lib/kept.py")).toBe("live");
  });

  it("removes a whole directory the backend deleted", () => {
    const vfs = new FakeVfs();
    vfs.seed("/work/demo/demo.egg-info/PKG-INFO", "Name: demo");

    applyHookWrites(vfs, [
      { root: "/work/demo", entries: [], bytes: new Uint8Array(0), removed: ["demo.egg-info"] },
    ]);

    expect(vfs.fsKind("/work/demo/demo.egg-info/PKG-INFO")).toBeUndefined();
  });

  it("ignores a removal for something that is already gone", () => {
    const vfs = new FakeVfs();
    expect(() =>
      applyHookWrites(vfs, [
        { root: "/work/demo", entries: [], bytes: new Uint8Array(0), removed: ["never-existed"] },
      ]),
    ).not.toThrow();
  });

  it("refuses a removal that climbs out of the tree", () => {
    const vfs = new FakeVfs();
    expect(() =>
      applyHookWrites(vfs, [
        {
          root: "/work/demo",
          entries: [],
          bytes: new Uint8Array(0),
          removed: ["../../etc/passwd"],
        },
      ]),
    ).toThrow(/does not name a place inside/);
  });
});
