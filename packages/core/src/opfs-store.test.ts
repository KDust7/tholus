import { describe, expect, it } from "vitest";

import { type ColdStore, openColdStore, STORE_ROOT, STORE_VERSION } from "./opfs-store.js";

class FakeSyncHandle {
  constructor(private readonly file: FakeFile) {}

  getSize(): number {
    return this.file.bytes.byteLength;
  }

  read(into: Uint8Array, options: { at: number }): number {
    const slice = this.file.bytes.subarray(options.at, options.at + into.byteLength);
    into.set(slice);
    return slice.byteLength;
  }

  write(from: Uint8Array, options: { at: number }): number {
    const grown = new Uint8Array(
      Math.max(this.file.bytes.byteLength, options.at + from.byteLength),
    );
    grown.set(this.file.bytes);
    grown.set(from, options.at);
    this.file.bytes = grown;
    return from.byteLength;
  }

  truncate(size: number): void {
    this.file.bytes = this.file.bytes.subarray(0, size);
  }

  flush(): void {}

  close(): void {
    this.file.directory.open -= 1;
  }
}

class FakeFile {
  bytes = new Uint8Array();

  constructor(readonly directory: FakeDirectory) {}

  async createSyncAccessHandle(): Promise<FakeSyncHandle> {
    this.directory.open += 1;
    return new FakeSyncHandle(this);
  }
}

class FakeDirectory {
  readonly kind = "directory";
  readonly children = new Map<string, FakeDirectory | FakeFile>();
  open = 0;

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    const found = this.children.get(name);
    if (found instanceof FakeDirectory) {
      return found;
    }
    if (found !== undefined || options?.create !== true) {
      throw Object.assign(new Error(`${name} not found`), { name: "NotFoundError" });
    }
    const made = new FakeDirectory();
    this.children.set(name, made);
    return made;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFile> {
    const found = this.children.get(name);
    if (found instanceof FakeFile) {
      return found;
    }
    if (found !== undefined || options?.create !== true) {
      throw Object.assign(new Error(`${name} not found`), { name: "NotFoundError" });
    }
    const made = new FakeFile(this);
    this.children.set(name, made);
    return made;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    if (!this.children.has(name)) {
      throw Object.assign(new Error(`${name} not found`), { name: "NotFoundError" });
    }
    void options;
    this.children.delete(name);
  }

  leaked(): number {
    let total = this.open;
    for (const child of this.children.values()) {
      if (child instanceof FakeDirectory) {
        total += child.leaked();
      }
    }
    return total;
  }
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (raw: Uint8Array | undefined): string | undefined =>
  raw === undefined ? undefined : new TextDecoder().decode(raw);

async function store(): Promise<{ cold: ColdStore; root: FakeDirectory }> {
  const root = new FakeDirectory();
  const cold = await openColdStore(root as unknown as FileSystemDirectoryHandle);
  return { cold, root };
}

describe("the cold store keeps uv's cache in its own corner of opfs", () => {
  it("puts everything under a versioned directory it owns", async () => {
    const { cold, root } = await store();
    await cold.write("simple-v24/idna.rkyv", bytes("hello"));
    const owned = await root.getDirectoryHandle(STORE_ROOT);
    expect([...(await owned.getDirectoryHandle(STORE_VERSION)).children.keys()]).toContain("cache");
  });

  it("reads back exactly what it wrote", async () => {
    const { cold } = await store();
    await cold.write("simple-v24/idna.rkyv", bytes("hello"));
    expect(text(await cold.read("simple-v24/idna.rkyv"))).toBe("hello");
  });

  it("creates every directory a nested path needs", async () => {
    const { cold } = await store();
    await cold.write("archive-v0/xyz/idna/__init__.py", bytes("import idna"));
    expect(text(await cold.read("archive-v0/xyz/idna/__init__.py"))).toBe("import idna");
  });

  it("reports a path it does not hold rather than throwing", async () => {
    const { cold } = await store();
    expect(await cold.read("never/written")).toBeUndefined();
  });

  it("truncates when a shorter payload replaces a longer one", async () => {
    const { cold } = await store();
    await cold.write("a", bytes("a much longer payload"));
    await cold.write("a", bytes("short"));
    expect(text(await cold.read("a"))).toBe("short");
  });

  it("removes a path it holds", async () => {
    const { cold } = await store();
    await cold.write("a/b", bytes("x"));
    await cold.remove("a/b");
    expect(await cold.read("a/b")).toBeUndefined();
  });

  it("ignores a remove of something already gone, so a retried flush is safe", async () => {
    const { cold } = await store();
    await expect(cold.remove("never/written")).resolves.toBeUndefined();
  });

  it("round trips the manifest as text", async () => {
    const { cold } = await store();
    expect(await cold.readManifest()).toBeUndefined();
    await cold.writeManifest('{"schemaVersion":2}');
    expect(await cold.readManifest()).toBe('{"schemaVersion":2}');
  });

  it("keeps the manifest out of the cache tree", async () => {
    const { cold, root } = await store();
    await cold.writeManifest("{}");
    const version = await (await root.getDirectoryHandle(STORE_ROOT)).getDirectoryHandle(
      STORE_VERSION,
    );
    expect([...version.children.keys()]).toContain("manifest.json");
  });

  it("closes every handle it opens, because opfs locks a file while one is open", async () => {
    const { cold, root } = await store();
    await cold.write("a/b", bytes("x"));
    await cold.read("a/b");
    await cold.read("missing");
    await cold.remove("a/b");
    await cold.writeManifest("{}");
    await cold.readManifest();
    expect(root.leaked()).toBe(0);
  });
});

describe("the store root is a fixed constant rather than the brand", () => {
  it("keeps the name every shipped release has written, so a rename orphans nobody", () => {
    expect(STORE_ROOT).toBe("uv-wasm");
  });
});
