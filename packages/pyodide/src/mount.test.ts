import type { TreeEntry } from "@tholus/engine-protocol";
import { describe, expect, it } from "vitest";

import type { PyodideFacts } from "./facts.js";
import { AbiMismatch, checkAbi, parentOf, writeTree } from "./mount.js";
import { MemFs } from "./testing/memfs.js";

const facts: PyodideFacts = {
  pyodideVersion: "314.0.5",
  pythonVersion: "3.14.2",
  extensionSuffix: ".cpython-314-wasm32-emscripten.so",
  platform: "emscripten-5.0.3-wasm32",
  sitePackages: "/lib/python3.14/site-packages",
};

class FakeFs extends MemFs {
  readonly trees: string[] = [];

  get files(): Map<string, Uint8Array> {
    const found = new Map<string, Uint8Array>();
    for (const [path, node] of this.nodes) {
      if (node.kind === "file") {
        found.set(path, node.bytes);
      }
    }
    return found;
  }

  get links(): Map<string, string> {
    const found = new Map<string, string>();
    for (const [path, node] of this.nodes) {
      if (node.kind === "symlink") {
        found.set(path, node.target);
      }
    }
    return found;
  }

  override mkdirTree(path: string): void {
    this.trees.push(path);
    super.mkdirTree(path);
  }
}

const file = (path: string, offset: number, length: number): TreeEntry => ({
  kind: "file",
  path,
  offset,
  length,
});

describe("an environment built for another runtime is refused before it is written", () => {
  it("accepts extension modules built for this Pyodide", () => {
    expect(() =>
      checkAbi([file("numpy/_core/_multiarray.cpython-314-wasm32-emscripten.so", 0, 1)], facts),
    ).not.toThrow();
  });

  it("refuses extension modules built for another python", () => {
    expect(() =>
      checkAbi([file("numpy/_core/_multiarray.cpython-311-wasm32-emscripten.so", 0, 1)], facts),
    ).toThrow(AbiMismatch);
  });

  it("names what it found, so the mismatch is diagnosable", () => {
    const bad = [file("a.cpython-311-wasm32-emscripten.so", 0, 1)];
    expect(() => checkAbi(bad, facts)).toThrow(/loads \.cpython-314.*found \.cpython-311/s);
  });

  it("accepts a bare or stable-abi suffix, which claims no particular build", () => {
    expect(() =>
      checkAbi([file("mod.so", 0, 1), file("other.abi3.so", 0, 1)], facts),
    ).not.toThrow();
  });

  it("ignores everything that is not an extension module", () => {
    expect(() =>
      checkAbi([file("idna/core.py", 0, 1), file("x.dist-info/RECORD", 0, 1)], facts),
    ).not.toThrow();
  });
});

describe("a tree is rebuilt inside the pyodide filesystem", () => {
  const bytes = new TextEncoder().encode("onetwo");

  it("writes each file at its own slice of the buffer", () => {
    const fs = new FakeFs();
    writeTree(fs, "/uv_envs/venv/site-packages", [file("a.py", 0, 3), file("b.py", 3, 3)], bytes);

    expect(new TextDecoder().decode(fs.files.get("/uv_envs/venv/site-packages/a.py"))).toBe("one");
    expect(new TextDecoder().decode(fs.files.get("/uv_envs/venv/site-packages/b.py"))).toBe("two");
  });

  it("makes each directory once, not once per file inside it", () => {
    const fs = new FakeFs();
    writeTree(
      fs,
      "/root",
      [file("pkg/a.py", 0, 3), file("pkg/b.py", 3, 3), file("pkg/c.py", 0, 0)],
      bytes,
    );
    expect(fs.trees.filter((made) => made === "/root/pkg")).toHaveLength(1);
  });

  it("counts what it wrote, and which of it was an extension module", () => {
    const fs = new FakeFs();
    const written = writeTree(
      fs,
      "/root",
      [file("a.py", 0, 3), file("m.cpython-314-wasm32-emscripten.so", 3, 3)],
      bytes,
    );
    expect(written).toMatchObject({ files: 2, links: 0, bytes: 6 });
    expect(written.dynlibs).toEqual(["/root/m.cpython-314-wasm32-emscripten.so"]);
  });

  it("recreates a symlink rather than copying what it points at", () => {
    const fs = new FakeFs();
    const written = writeTree(
      fs,
      "/root",
      [{ kind: "symlink", path: "alias", target: "real.py" }],
      new Uint8Array(0),
    );
    expect(fs.links.get("/root/alias")).toBe("real.py");
    expect(written.links).toBe(1);
  });

  it("leaves a symlink that is already there, because remaking one throws", () => {
    const fs = new FakeFs();
    fs.symlink("old", "/root/alias");
    const written = writeTree(
      fs,
      "/root",
      [{ kind: "symlink", path: "alias", target: "new" }],
      new Uint8Array(0),
    );
    expect(fs.links.get("/root/alias")).toBe("old");
    expect(written.links).toBe(0);
  });
});

describe("parentOf", () => {
  it("names the directory holding a nested path", () => {
    expect(parentOf("a/b/c.py")).toBe("a/b");
  });

  it("says nothing for a path already at the root", () => {
    expect(parentOf("c.py")).toBeUndefined();
  });
});
