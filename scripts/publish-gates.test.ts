import { describe, expect, it } from "vitest";

import { entriesOf } from "./read-tarball.mjs";
import { rewritten, workspaceRangesIn } from "./rewrite-workspace-deps.mjs";

const BLOCK = 512;

function tarEntry(name: string, body: string): Uint8Array {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, "utf8");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "utf8");

  const content = Buffer.from(body, "utf8");
  const padded = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK);
  content.copy(padded);

  return Buffer.concat([header, padded]);
}

describe("pinning the ranges npm cannot resolve", () => {
  it("replaces a workspace range in every field npm installs from", () => {
    const pinned = rewritten(
      {
        dependencies: { a: "workspace:*" },
        peerDependencies: { b: "workspace:^" },
        optionalDependencies: { c: "workspace:~" },
      },
      "1.2.3",
    );

    expect(pinned.dependencies).toEqual({ a: "1.2.3" });
    expect(pinned.peerDependencies).toEqual({ b: "1.2.3" });
    expect(pinned.optionalDependencies).toEqual({ c: "1.2.3" });
  });

  it("leaves a range that resolves on its own alone", () => {
    const pinned = rewritten({ dependencies: { zod: "^3.23.8", sibling: "workspace:*" } }, "1.2.3");

    expect(pinned.dependencies).toEqual({ zod: "^3.23.8", sibling: "1.2.3" });
  });

  it("does not touch the manifest it was given", () => {
    const manifest = { dependencies: { a: "workspace:*" } };
    rewritten(manifest, "1.2.3");

    expect(manifest.dependencies.a).toBe("workspace:*");
  });

  it("carries a manifest with no dependencies through untouched", () => {
    expect(rewritten({ name: "solo" }, "1.2.3")).toEqual({ name: "solo" });
  });

  it("names every range that would fail a consumer's install", () => {
    expect(
      workspaceRangesIn({
        dependencies: { a: "workspace:*", zod: "^3.23.8" },
        peerDependencies: { b: "workspace:*" },
      }),
    ).toEqual([
      { field: "dependencies", name: "a", range: "workspace:*" },
      { field: "peerDependencies", name: "b", range: "workspace:*" },
    ]);
  });

  it("finds nothing when every range already resolves", () => {
    expect(workspaceRangesIn({ dependencies: { zod: "^3.23.8" } })).toEqual([]);
  });
});

describe("reading back what npm actually packed", () => {
  it("returns each entry's bytes", () => {
    const archive = Buffer.concat([
      tarEntry("package/package.json", '{"name":"a"}'),
      tarEntry("package/dist/index.js", "export {};"),
    ]);

    const entries = entriesOf(archive);

    expect([...entries.keys()]).toEqual(["package/package.json", "package/dist/index.js"]);
    expect(entries.get("package/package.json")?.toString()).toBe('{"name":"a"}');
  });

  it("reads an entry whose body spans more than one block", () => {
    const body = "x".repeat(BLOCK + 7);
    const entries = entriesOf(Buffer.from(tarEntry("package/big.bin", body)));

    expect(entries.get("package/big.bin")?.length).toBe(body.length);
  });

  it("stops at the padding tar writes after the last entry", () => {
    const archive = Buffer.concat([
      tarEntry("package/package.json", "{}"),
      Buffer.alloc(BLOCK * 2),
      tarEntry("package/never-read.js", "unreachable"),
    ]);

    expect([...entriesOf(archive).keys()]).toEqual(["package/package.json"]);
  });
});
