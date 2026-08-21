import { describe, expect, it } from "vitest";

import { type CacheVfs, type HydrateVfs, readCacheTree } from "./cache-tree.js";
import { emptyManifest, type Manifest } from "./cold-store.js";
import type { ColdStore } from "./opfs-store.js";
import { CACHE_LOCK, createPersistence, type LockRunner } from "./persistence.js";

const ROOT = "/home/browser/.cache/uv";
const ABI = "pyemscripten_2026_0_wasm32";

type Node = { kind: "file"; bytes: Uint8Array } | { kind: "symlink"; target: string };

class FakeVfs implements CacheVfs, HydrateVfs {
  readonly nodes = new Map<string, Node>();
  readonly directories = new Set<string>();

  file(path: string, body: string): this {
    this.fsWrite(path, new TextEncoder().encode(body));
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
}

class FakeStore implements ColdStore {
  readonly blobs = new Map<string, Uint8Array>();
  readonly writes: string[] = [];
  readonly order: string[] = [];
  manifest: string | undefined;
  refuse = new Set<string>();

  async readManifest(): Promise<string | undefined> {
    return this.manifest;
  }

  async writeManifest(raw: string): Promise<void> {
    this.manifest = raw;
    this.order.push("manifest");
  }

  async read(path: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(path);
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    if (this.refuse.has(path)) {
      throw new Error(`the store refused ${path}`);
    }
    this.blobs.set(path, bytes);
    this.writes.push(path);
    this.order.push(`blob:${path}`);
  }

  async remove(path: string): Promise<void> {
    this.blobs.delete(path);
    this.order.push(`remove:${path}`);
  }
}

const serial = (): { lock: LockRunner; taken: string[]; held: () => number } => {
  const taken: string[] = [];
  let depth = 0;
  let peak = 0;
  const lock: LockRunner = async (name, run) => {
    taken.push(name);
    depth += 1;
    peak = Math.max(peak, depth);
    try {
      return await run();
    } finally {
      depth -= 1;
    }
  };
  return { lock, taken, held: () => peak };
};

const setup = (options: { vfs?: FakeVfs; store?: FakeStore; budgetBytes?: number } = {}) => {
  const vfs = options.vfs ?? new FakeVfs();
  const store = options.store ?? new FakeStore();
  const clock = { now: 100 };
  const { lock, taken, held } = serial();
  const persistence = createPersistence({
    store,
    vfs,
    root: ROOT,
    abiTag: ABI,
    lock,
    now: () => clock.now,
    ...(options.budgetBytes === undefined ? {} : { budgetBytes: options.budgetBytes }),
  });
  return { persistence, vfs, store, clock, taken, held };
};

const stored = (store: FakeStore): Manifest =>
  store.manifest === undefined ? emptyManifest(ABI) : (JSON.parse(store.manifest) as Manifest);

describe("a flush writes the cache to the cold store", () => {
  it("writes every blob the first time, then the manifest", async () => {
    const { persistence, store } = setup({
      vfs: new FakeVfs().file(`${ROOT}/simple-v24/idna.rkyv`, "index"),
    });
    const report = await persistence.flush();

    expect(report.written).toEqual(["simple-v24/idna.rkyv"]);
    expect(store.order).toEqual(["blob:simple-v24/idna.rkyv", "manifest"]);
    expect(Object.keys(stored(store).entries)).toEqual(["simple-v24/idna.rkyv"]);
  });

  it("writes the manifest last, so a torn flush never claims a blob it lacks", async () => {
    const vfs = new FakeVfs().file(`${ROOT}/a`, "1").file(`${ROOT}/b`, "2");
    const { persistence, store } = setup({ vfs });
    await persistence.flush();
    expect(store.order.at(-1)).toBe("manifest");
  });

  it("writes nothing the second time, because nothing changed", async () => {
    const vfs = new FakeVfs().file(`${ROOT}/a`, "1");
    const { persistence, store } = setup({ vfs });
    await persistence.flush();
    store.writes.length = 0;
    const report = await persistence.flush();
    expect(report.written).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  it("removes a blob the cache no longer holds", async () => {
    const vfs = new FakeVfs().file(`${ROOT}/a`, "1").file(`${ROOT}/b`, "2");
    const { persistence, store } = setup({ vfs });
    await persistence.flush();
    vfs.nodes.delete(`${ROOT}/b`);
    const report = await persistence.flush();
    expect(report.removed).toEqual(["b"]);
    expect(store.blobs.has("b")).toBe(false);
  });

  it("keeps going when the store refuses one blob, and reports it", async () => {
    const vfs = new FakeVfs().file(`${ROOT}/a`, "1").file(`${ROOT}/b`, "2");
    const store = new FakeStore();
    store.refuse.add("a");
    const { persistence } = setup({ vfs, store });

    const report = await persistence.flush();
    expect(report.written).toEqual(["b"]);
    expect(report.failed).toEqual(["a"]);
    expect(store.manifest).toBeDefined();
  });

  it("retries the refused blob on the next flush", async () => {
    const vfs = new FakeVfs().file(`${ROOT}/a`, "1");
    const store = new FakeStore();
    store.refuse.add("a");
    const { persistence } = setup({ vfs, store });
    await persistence.flush();

    store.refuse.clear();
    expect((await persistence.flush()).written).toEqual(["a"]);
  });

  it("holds one exclusive lock around the whole flush", async () => {
    const { persistence, taken, held } = setup({
      vfs: new FakeVfs().file(`${ROOT}/a`, "1"),
    });
    await persistence.flush();
    expect(taken).toEqual([CACHE_LOCK]);
    expect(held()).toBe(1);
  });

  it("evicts past the budget, oldest archives first, and forgets what it evicted", async () => {
    const vfs = new FakeVfs()
      .file(`${ROOT}/archive-v0/old/x`, "aaaaa")
      .file(`${ROOT}/simple-v24/idx`, "bbbbb");
    const { persistence, store } = setup({ vfs, budgetBytes: 5 });

    const report = await persistence.flush();
    expect(report.evicted).toEqual(["archive-v0/old/x"]);
    expect(store.blobs.has("archive-v0/old/x")).toBe(false);
    expect(Object.keys(stored(store).entries)).toEqual(["simple-v24/idx"]);
  });
});

describe("hydration puts the stored cache back before uv runs", () => {
  it("hydrates nothing from an empty store", async () => {
    const { persistence, vfs } = setup();
    const report = await persistence.hydrate();
    expect(report.hydrated).toEqual([]);
    expect(vfs.nodes.size).toBe(0);
  });

  it("restores the tree a flush wrote, symlink included", async () => {
    const source = new FakeVfs().file(`${ROOT}/archive-v0/xyz/idna.py`, "import idna");
    source.fsSymlink("../../archive-v0/xyz", `${ROOT}/wheels-v6/idna`);
    const store = new FakeStore();
    await setup({ vfs: source, store }).persistence.flush();

    const { persistence, vfs } = setup({ store });
    const report = await persistence.hydrate();

    expect(report.missing).toEqual([]);
    expect(report.hydrated.length).toBe(2);
    expect(readCacheTree(vfs, ROOT)).toEqual(readCacheTree(source, ROOT));
  });

  it("hydrates nothing when the interpreter abi changed under the cache", async () => {
    const source = new FakeVfs().file(`${ROOT}/a`, "1");
    const store = new FakeStore();
    await setup({ vfs: source, store }).persistence.flush();
    store.manifest = store.manifest?.replace(ABI, "pyemscripten_2027_0_wasm32");

    const { persistence, vfs } = setup({ store });
    expect((await persistence.hydrate()).hydrated).toEqual([]);
    expect(vfs.nodes.size).toBe(0);
  });

  it("reports a blob the store lost rather than failing the boot", async () => {
    const source = new FakeVfs().file(`${ROOT}/a`, "1").file(`${ROOT}/b`, "2");
    const store = new FakeStore();
    await setup({ vfs: source, store }).persistence.flush();
    store.blobs.delete("a");

    const { persistence, vfs } = setup({ store });
    const report = await persistence.hydrate();
    expect(report.missing).toEqual(["a"]);
    expect(vfs.fsKind(`${ROOT}/b`)).toBe("file");
  });

  it("takes the lock, so a flush in another tab cannot tear what it reads", async () => {
    const { persistence, taken } = setup();
    await persistence.hydrate();
    expect(taken).toEqual([CACHE_LOCK]);
  });
});
