import { describe, expect, it } from "vitest";

import {
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
      entries: { a: { size: 1, usedAt: 0 } },
    });
    expect(loadManifest(other, ABI).entries).toEqual({});
  });

  it("keeps a manifest that matches", () => {
    const entries = { "simple-v24/idna.msgpack": { size: 12, usedAt: 5 } };
    expect(loadManifest(JSON.stringify(manifestOf(entries)), ABI).entries).toEqual(entries);
  });

  it("does not reuse across an abi change", () => {
    expect(isReusable(emptyManifest(ABI), "other")).toBe(false);
  });
});

describe("a flush writes what changed and forgets what went away", () => {
  it("writes everything the first time", () => {
    const plan = planFlush([{ path: "a", size: 1 }], emptyManifest(ABI));
    expect(plan).toEqual({ writes: ["a"], deletes: [] });
  });

  it("writes nothing when nothing changed", () => {
    const manifest = manifestOf({ a: { size: 1, usedAt: 0 } });
    expect(planFlush([{ path: "a", size: 1 }], manifest)).toEqual({ writes: [], deletes: [] });
  });

  it("rewrites a file whose size changed", () => {
    const manifest = manifestOf({ a: { size: 1, usedAt: 0 } });
    expect(planFlush([{ path: "a", size: 2 }], manifest).writes).toEqual(["a"]);
  });

  it("deletes what the cache no longer holds", () => {
    const manifest = manifestOf({ a: { size: 1, usedAt: 0 }, b: { size: 1, usedAt: 0 } });
    expect(planFlush([{ path: "a", size: 1 }], manifest).deletes).toEqual(["b"]);
  });

  it("records the sizes and the time it wrote them", () => {
    const live = [{ path: "a", size: 7 }];
    const plan = planFlush(live, emptyManifest(ABI));
    expect(commitFlush(emptyManifest(ABI), live, plan, 42).entries).toEqual({
      a: { size: 7, usedAt: 42 },
    });
  });

  it("drops the deleted entries when it commits", () => {
    const manifest = manifestOf({ a: { size: 1, usedAt: 0 }, b: { size: 1, usedAt: 0 } });
    const live = [{ path: "a", size: 1 }];
    const plan = planFlush(live, manifest);
    expect(Object.keys(commitFlush(manifest, live, plan, 9).entries)).toEqual(["a"]);
  });
});

describe("eviction gives up archives first and built wheels last", () => {
  it("evicts nothing while the cache is inside its budget", () => {
    expect(planEviction(manifestOf({ a: { size: 10, usedAt: 0 } }), 10)).toEqual([]);
  });

  it("gives up an archive before a simple-index entry of the same age", () => {
    const manifest = manifestOf({
      "simple-v24/idna.msgpack": { size: 10, usedAt: 0 },
      "archive-v0/abc/idna": { size: 10, usedAt: 0 },
    });
    expect(planEviction(manifest, 10)).toEqual(["archive-v0/abc/idna"]);
  });

  it("gives up a built sdist wheel last of all", () => {
    const manifest = manifestOf({
      "sdists-v9/abc/wheel": { size: 10, usedAt: 0 },
      "simple-v24/idna.msgpack": { size: 10, usedAt: 0 },
      "archive-v0/abc/idna": { size: 10, usedAt: 0 },
    });
    expect(planEviction(manifest, 10)).toEqual(["archive-v0/abc/idna", "simple-v24/idna.msgpack"]);
  });

  it("gives up the least recently used of equal rank", () => {
    const manifest = manifestOf({
      "archive-v0/old": { size: 10, usedAt: 1 },
      "archive-v0/new": { size: 10, usedAt: 9 },
    });
    expect(planEviction(manifest, 10)).toEqual(["archive-v0/old"]);
  });

  it("stops as soon as the cache fits", () => {
    const manifest = manifestOf({
      "archive-v0/a": { size: 10, usedAt: 1 },
      "archive-v0/b": { size: 10, usedAt: 2 },
      "archive-v0/c": { size: 10, usedAt: 3 },
    });
    expect(planEviction(manifest, 20)).toEqual(["archive-v0/a"]);
  });

  it("evicts everything when the budget cannot be met", () => {
    const manifest = manifestOf({ "archive-v0/a": { size: 10, usedAt: 1 } });
    expect(planEviction(manifest, 0)).toEqual(["archive-v0/a"]);
  });
});
