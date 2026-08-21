import { describe, expect, it } from "vitest";

import {
  type CacheEntry,
  commitFlush,
  emptyManifest,
  isReusable,
  loadManifest,
  MANIFEST_SCHEMA_VERSION,
  type Manifest,
  planEviction,
  planFlush,
} from "./cold-store.js";

const ABI = "pyemscripten_2026_0_wasm32";

const manifestOf = (entries: Manifest["entries"]): Manifest => ({
  ...emptyManifest(ABI),
  entries,
});

const file = (path: string, size: number): CacheEntry => ({ kind: "file", path, size });

const flush = (live: readonly CacheEntry[], manifest: Manifest, now: number): Manifest =>
  commitFlush(manifest, live, planFlush(live, manifest).writes, now);

describe("the cold store only reuses a manifest it can trust", () => {
  it("starts empty when there is nothing stored", () => {
    expect(loadManifest(undefined, ABI)).toEqual(emptyManifest(ABI));
  });

  it("starts empty rather than throwing on a corrupt manifest", () => {
    expect(loadManifest("{not json", ABI)).toEqual(emptyManifest(ABI));
  });

  it("wipes a manifest written by a different schema", () => {
    const stale = JSON.stringify({ schemaVersion: 0, abiTag: ABI, entries: { a: { size: 1 } } });
    expect(loadManifest(stale, ABI).entries).toEqual({});
  });

  it("wipes a manifest written for a different interpreter abi", () => {
    const other = JSON.stringify({
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      abiTag: "pyemscripten_2027_0_wasm32",
      entries: { a: { kind: "file", size: 1, usedAt: 0 } },
    });
    expect(loadManifest(other, ABI).entries).toEqual({});
  });

  it("keeps a manifest that matches", () => {
    const entries = {
      "simple-v24/idna.msgpack": { kind: "file", size: 12, usedAt: 5 },
    } satisfies Manifest["entries"];
    expect(loadManifest(JSON.stringify(manifestOf(entries)), ABI).entries).toEqual(entries);
  });

  it("does not reuse across an abi change", () => {
    expect(isReusable(emptyManifest(ABI), "other")).toBe(false);
  });
});

describe("a flush writes what changed and forgets what went away", () => {
  it("writes everything the first time", () => {
    const plan = planFlush([file("a", 1)], emptyManifest(ABI));
    expect(plan).toEqual({ writes: ["a"], deletes: [] });
  });

  it("writes nothing when nothing changed", () => {
    const manifest = manifestOf({ a: { kind: "file", size: 1, usedAt: 0 } });
    expect(planFlush([file("a", 1)], manifest)).toEqual({ writes: [], deletes: [] });
  });

  it("rewrites a file whose size changed", () => {
    const manifest = manifestOf({ a: { kind: "file", size: 1, usedAt: 0 } });
    expect(planFlush([file("a", 2)], manifest).writes).toEqual(["a"]);
  });

  it("deletes what the cache no longer holds", () => {
    const manifest = manifestOf({
      a: { kind: "file", size: 1, usedAt: 0 },
      b: { kind: "file", size: 1, usedAt: 0 },
    });
    expect(planFlush([file("a", 1)], manifest).deletes).toEqual(["b"]);
  });

  it("records the sizes and the time it wrote them", () => {
    expect(flush([file("a", 7)], emptyManifest(ABI), 42).entries).toEqual({
      a: { kind: "file", size: 7, usedAt: 42 },
    });
  });

  it("drops the deleted entries when it commits", () => {
    const manifest = manifestOf({
      a: { kind: "file", size: 1, usedAt: 0 },
      b: { kind: "file", size: 1, usedAt: 0 },
    });
    expect(Object.keys(flush([file("a", 1)], manifest, 9).entries)).toEqual(["a"]);
  });

  it("leaves an untouched file's age alone, so the lru still means something", () => {
    const manifest = manifestOf({ a: { kind: "file", size: 1, usedAt: 3 } });
    expect(flush([file("a", 1)], manifest, 99).entries.a).toEqual({
      kind: "file",
      size: 1,
      usedAt: 3,
    });
  });

  it("does not claim a file it failed to write, so the next flush retries it", () => {
    const live = [file("a", 1), file("b", 2)];
    const manifest = commitFlush(emptyManifest(ABI), live, ["a"], 5);
    expect(Object.keys(manifest.entries)).toEqual(["a"]);
    expect(planFlush(live, manifest).writes).toEqual(["b"]);
  });
});

describe("a symlink is persisted as metadata, because opfs has no symlink", () => {
  const link = {
    kind: "symlink",
    path: "wheels-v6/index/abc/idna/3.11",
    target: "../../../../archive-v0/xyz",
  } as const;

  it("records the target rather than a size", () => {
    expect(flush([link], emptyManifest(ABI), 42).entries).toEqual({
      [link.path]: { kind: "symlink", target: link.target, usedAt: 42 },
    });
  });

  it("writes no blob for it, because there are no bytes to write", () => {
    expect(planFlush([link], emptyManifest(ABI)).writes).toEqual([]);
  });

  it("re-records a link whose target moved", () => {
    const manifest = manifestOf({
      [link.path]: { kind: "symlink", target: "../../../../archive-v0/old", usedAt: 1 },
    });
    const moved = { ...link, target: "../../../../archive-v0/new" };
    expect(flush([moved], manifest, 9).entries[link.path]).toEqual({
      kind: "symlink",
      target: moved.target,
      usedAt: 9,
    });
  });

  it("forgets a link the cache no longer holds", () => {
    const manifest = manifestOf({
      [link.path]: { kind: "symlink", target: link.target, usedAt: 1 },
    });
    expect(flush([], manifest, 9).entries).toEqual({});
  });

  it("deletes the stored blob when a file becomes a link", () => {
    const manifest = manifestOf({ [link.path]: { kind: "file", size: 4, usedAt: 1 } });
    expect(planFlush([link], manifest).deletes).toEqual([link.path]);
  });

  it("writes the blob when a link becomes a file", () => {
    const manifest = manifestOf({
      [link.path]: { kind: "symlink", target: link.target, usedAt: 1 },
    });
    expect(planFlush([file(link.path, 4)], manifest)).toEqual({
      writes: [link.path],
      deletes: [],
    });
  });

  it("counts for nothing against the eviction budget", () => {
    const manifest = manifestOf({
      [link.path]: { kind: "symlink", target: link.target, usedAt: 0 },
    });
    expect(planEviction(manifest, 0)).toEqual([]);
  });
});

describe("eviction gives up archives first and built wheels last", () => {
  it("evicts nothing while the cache is inside its budget", () => {
    expect(planEviction(manifestOf({ a: { kind: "file", size: 10, usedAt: 0 } }), 10)).toEqual([]);
  });

  it("gives up an archive before a simple-index entry of the same age", () => {
    const manifest = manifestOf({
      "simple-v24/idna.msgpack": { kind: "file", size: 10, usedAt: 0 },
      "archive-v0/abc/idna": { kind: "file", size: 10, usedAt: 0 },
    });
    expect(planEviction(manifest, 10)).toEqual(["archive-v0/abc/idna"]);
  });

  it("gives up a built sdist wheel last of all", () => {
    const manifest = manifestOf({
      "sdists-v9/abc/wheel": { kind: "file", size: 10, usedAt: 0 },
      "simple-v24/idna.msgpack": { kind: "file", size: 10, usedAt: 0 },
      "archive-v0/abc/idna": { kind: "file", size: 10, usedAt: 0 },
    });
    expect(planEviction(manifest, 10)).toEqual(["archive-v0/abc/idna", "simple-v24/idna.msgpack"]);
  });

  it("gives up the least recently used of equal rank", () => {
    const manifest = manifestOf({
      "archive-v0/old": { kind: "file", size: 10, usedAt: 1 },
      "archive-v0/new": { kind: "file", size: 10, usedAt: 9 },
    });
    expect(planEviction(manifest, 10)).toEqual(["archive-v0/old"]);
  });

  it("stops as soon as the cache fits", () => {
    const manifest = manifestOf({
      "archive-v0/a": { kind: "file", size: 10, usedAt: 1 },
      "archive-v0/b": { kind: "file", size: 10, usedAt: 2 },
      "archive-v0/c": { kind: "file", size: 10, usedAt: 3 },
    });
    expect(planEviction(manifest, 20)).toEqual(["archive-v0/a"]);
  });

  it("evicts everything when the budget cannot be met", () => {
    const manifest = manifestOf({ "archive-v0/a": { kind: "file", size: 10, usedAt: 1 } });
    expect(planEviction(manifest, 0)).toEqual(["archive-v0/a"]);
  });
});
