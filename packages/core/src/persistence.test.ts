import { describe, expect, it } from "vitest";

import { type CacheVfs, type HydrateVfs, readCacheTree } from "./cache-tree.js";
import { emptyManifest, type Manifest } from "./cold-store.js";
import type { ColdStore } from "./opfs-store.js";
import { CACHE_LOCK, createPersistence, type LockRunner, QUOTA_SHARE } from "./persistence.js";

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
  outOfRoom = false;

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
    if (this.outOfRoom) {
      throw Object.assign(new Error("out of room"), { name: "QuotaExceededError" });
    }
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

const setup = (
  options: {
    vfs?: FakeVfs;
    store?: FakeStore;
    budgetBytes?: number;
    quota?: { quota: number; usage: number };
  } = {},
) => {
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
    ...(options.quota === undefined ? {} : { quota: async () => options.quota }),
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

  it("keeps a refused blob's siblings out of the manifest, rather than recording half an archive", async () => {
    const vfs = new FakeVfs()
      .file(`${ROOT}/archive-v0/idna/__init__.py`, "a")
      .file(`${ROOT}/archive-v0/idna/core.py`, "b");
    const store = new FakeStore();
    store.refuse.add("archive-v0/idna/core.py");
    const { persistence } = setup({ vfs, store });

    await persistence.flush();
    expect(
      Object.keys(stored(store).entries),
      "one refused blob must not leave a package uv would install from",
    ).toEqual([]);
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

  it("leaves out the siblings of a blob the store lost, rather than restoring half an archive", async () => {
    const source = new FakeVfs()
      .file(`${ROOT}/archive-v0/idna/__init__.py`, "a")
      .file(`${ROOT}/archive-v0/idna/core.py`, "b");
    const store = new FakeStore();
    await setup({ vfs: source, store }).persistence.flush();
    store.blobs.delete("archive-v0/idna/core.py");

    const { persistence, vfs } = setup({ store });
    await persistence.hydrate();
    expect(
      vfs.fsKind(`${ROOT}/archive-v0/idna`),
      "a directory with one of two files is a package uv would install",
    ).toBeUndefined();
  });

  it("takes the lock, so a flush in another tab cannot tear what it reads", async () => {
    const { persistence, taken } = setup();
    await persistence.hydrate();
    expect(taken).toEqual([CACHE_LOCK]);
  });
});

describe("the cold store prunes itself to its budget before it loads anything", () => {
  const filled = async (build: (vfs: FakeVfs) => FakeVfs): Promise<FakeStore> => {
    const store = new FakeStore();
    await setup({ vfs: build(new FakeVfs()), store }).persistence.flush();
    return store;
  };

  it("gives up the oldest archive first, and forgets it", async () => {
    const store = await filled((vfs) =>
      vfs.file(`${ROOT}/archive-v0/old/x`, "aaaaa").file(`${ROOT}/simple-v24/idx`, "bbbbb"),
    );
    const { persistence } = setup({ store, budgetBytes: 5 });

    const report = await persistence.hydrate();
    expect(report.evicted).toEqual(["archive-v0/old/x"]);
    expect(store.blobs.has("archive-v0/old/x")).toBe(false);
    expect(Object.keys(stored(store).entries)).toEqual(["simple-v24/idx"]);
  });

  it("gives up a whole archive, because uv reads the directory as proof of the package", async () => {
    const store = await filled((vfs) =>
      vfs
        .file(`${ROOT}/archive-v0/idna/__init__.py`, "aaaaa")
        .file(`${ROOT}/archive-v0/idna/core.py`, "bbbbb")
        .file(`${ROOT}/simple-v24/idx`, "ccccc"),
    );
    const { persistence } = setup({ store, budgetBytes: 10 });

    const report = await persistence.hydrate();
    expect(
      [...report.evicted].sort(),
      "half an archive still has a directory, and uv would install from it",
    ).toEqual(["archive-v0/idna/__init__.py", "archive-v0/idna/core.py"]);
    expect(store.blobs.has("archive-v0/idna/core.py")).toBe(false);
  });

  it("never loads what it evicted, so the next flush cannot put it back", async () => {
    const store = await filled((vfs) =>
      vfs.file(`${ROOT}/archive-v0/old/x`, "aaaaa").file(`${ROOT}/simple-v24/idx`, "bbbbb"),
    );
    const { persistence, vfs } = setup({ store, budgetBytes: 5 });
    await persistence.hydrate();

    store.writes.length = 0;
    expect(
      (await persistence.flush()).written,
      "a re-written blob means the budget is never really enforced",
    ).toEqual([]);
    expect(vfs.fsKind(`${ROOT}/archive-v0/old/x`)).toBeUndefined();
  });

  it("sizes its budget from a share of the origin's quota when the host names none", async () => {
    const store = await filled((vfs) =>
      vfs.file(`${ROOT}/archive-v0/a`, "aaaaaaaaaa").file(`${ROOT}/simple-v24/b`, "bbbbbbbbbb"),
    );
    const quota = { quota: Math.ceil(10 / QUOTA_SHARE), usage: 0 };
    const { persistence } = setup({ store, quota });

    const report = await persistence.hydrate();
    expect(report.evicted, "a 20-byte cache should not fit a 10-byte share").toEqual([
      "archive-v0/a",
    ]);
    expect(store.blobs.has("archive-v0/a")).toBe(false);
  });

  it("prefers a budget the host named over the one it would derive", async () => {
    const store = await filled((vfs) => vfs.file(`${ROOT}/archive-v0/a`, "aaaaaaaaaa"));
    const { persistence } = setup({ store, budgetBytes: 1000, quota: { quota: 1, usage: 0 } });
    expect((await persistence.hydrate()).evicted).toEqual([]);
  });

  it("forgets a blob it could not delete, and says it is still taking up room", async () => {
    const store = await filled((vfs) =>
      vfs.file(`${ROOT}/archive-v0/old/x`, "aaaaa").file(`${ROOT}/simple-v24/idx`, "bbbbb"),
    );
    store.remove = async (path: string): Promise<void> => {
      throw new Error(`the store would not delete ${path}`);
    };
    const { persistence, vfs } = setup({ store, budgetBytes: 5 });

    const report = await persistence.hydrate();
    expect(report.orphaned).toEqual(["archive-v0/old/x"]);
    expect(
      vfs.fsKind(`${ROOT}/archive-v0/old/x`),
      "a blob the manifest has forgotten must not be loaded anyway",
    ).toBeUndefined();
  });
});

describe("the cold store warns before the origin runs out of room", () => {
  it("says the origin is nearly full without evicting a share that is not the problem", async () => {
    const vfs = new FakeVfs().file(`${ROOT}/archive-v0/a`, "aaaaaaaaaa");
    const { persistence, store } = setup({ vfs, quota: { quota: 100, usage: 95 } });

    const report = await persistence.flush();
    expect(report.nearQuota, "95 of 100 bytes used should be reported as pressure").toBe(true);
    expect(
      store.blobs.has("archive-v0/a"),
      "giving up 10 bytes of our own would not fix an origin filled by something else",
    ).toBe(true);
  });

  it("does not cry pressure while the origin has room", async () => {
    const vfs = new FakeVfs().file(`${ROOT}/a`, "1");
    const { persistence } = setup({ vfs, quota: { quota: 100, usage: 5 } });
    expect((await persistence.flush()).nearQuota).toBe(false);
  });

  it("persists as before when the browser will not say what the quota is", async () => {
    const vfs = new FakeVfs().file(`${ROOT}/archive-v0/a`, "aaaaaaaaaa");
    const store = new FakeStore();
    await setup({ vfs, store }).persistence.flush();

    expect((await setup({ store }).persistence.hydrate()).evicted).toEqual([]);
    expect(store.blobs.has("archive-v0/a")).toBe(true);
  });

  it("reports running out of room as its own thing, not as a refused blob", async () => {
    const vfs = new FakeVfs().file(`${ROOT}/a`, "1");
    const store = new FakeStore();
    store.outOfRoom = true;
    const { persistence } = setup({ vfs, store });

    const report = await persistence.flush();
    expect(report.quotaExceeded).toBe(true);
    expect(report.failed).toEqual(["a"]);
  });

  it("does not claim a quota failure on an ordinary refusal", async () => {
    const vfs = new FakeVfs().file(`${ROOT}/a`, "1");
    const store = new FakeStore();
    store.refuse.add("a");
    const { persistence } = setup({ vfs, store });
    expect((await persistence.flush()).quotaExceeded).toBe(false);
  });
});
