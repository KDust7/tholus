import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

import { declarationText, kindOf, renderReport, stripLeadingComment, surfaceOf } from "./report.js";

const sandbox = mkdtempSync(resolve(tmpdir(), "api-report-"));

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function declare(contents: string): string {
  const path = resolve(sandbox, `${Math.abs(hash(contents))}.d.ts`);
  writeFileSync(path, contents, "utf8");
  return path;
}

function hash(text: string): number {
  let value = 0;
  for (const character of text) {
    value = (value * 31 + character.charCodeAt(0)) | 0;
  }
  return value;
}

describe("the report describes what a package actually exports", () => {
  it("lists every export, sorted, with its kind", () => {
    const entry = declare(
      [
        "export declare function beta(value: string): number;",
        "export interface Alpha { id: string }",
        "export type Gamma = 'a' | 'b';",
      ].join("\n"),
    );
    expect(surfaceOf(entry).map((item) => `${item.kind} ${item.name}`)).toEqual([
      "interface Alpha",
      "function beta",
      "type Gamma",
    ]);
  });

  it("keeps the signature, so a changed parameter shows up as a change", () => {
    const before = surfaceOf(declare("export declare function run(a: string): void;"));
    const after = surfaceOf(declare("export declare function run(a: string, b: number): void;"));
    expect(
      before[0]?.signature,
      "a report that recorded only names would call these two identical",
    ).not.toBe(after[0]?.signature);
  });

  it("keeps interface members, so adding a required field is visible", () => {
    const before = surfaceOf(declare("export interface Options { a: string }"));
    const after = surfaceOf(declare("export interface Options { a: string; b: number }"));
    expect(before[0]?.signature).not.toBe(after[0]?.signature);
  });

  it("follows a re-export to the declaration it points at", () => {
    writeFileSync(resolve(sandbox, "inner.d.ts"), "export declare const value: number;\n", "utf8");
    const entry = resolve(sandbox, "outer.d.ts");
    writeFileSync(entry, 'export * from "./inner.js";\n', "utf8");
    expect(surfaceOf(entry).map((item) => item.name)).toEqual(["value"]);
  });

  it("refuses a package that was never built, rather than reporting nothing", () => {
    expect(() => surfaceOf(resolve(sandbox, "absent.d.ts"))).toThrow(/build the package first/);
  });

  it("reports nothing for a file that is not a module", () => {
    const entry = resolve(sandbox, "script.d.ts");
    writeFileSync(entry, `declare const notExported: number;${String.fromCharCode(10)}`, "utf8");
    expect(surfaceOf(entry)).toEqual([]);
  });
});

describe("the small pieces", () => {
  it("names each kind of declaration", () => {
    expect(kindOf(ts.SymbolFlags.Interface)).toBe("interface");
    expect(kindOf(ts.SymbolFlags.Function)).toBe("function");
    expect(kindOf(ts.SymbolFlags.TypeAlias)).toBe("type");
    expect(kindOf(ts.SymbolFlags.None)).toBe("unknown");
  });

  it("drops a doc comment without touching the declaration under it", () => {
    expect(stripLeadingComment("/** doc */\nexport declare const a: number;")).toBe(
      "export declare const a: number;",
    );
    expect(stripLeadingComment("// line\nexport declare const a: number;")).toBe(
      "export declare const a: number;",
    );
    expect(stripLeadingComment("export declare const a: number;")).toBe(
      "export declare const a: number;",
    );
  });

  it("gives up on a comment that is never closed rather than looping", () => {
    expect(stripLeadingComment("/* never closed")).toBe("/* never closed");
  });

  it("returns nothing for a file that is only a line comment", () => {
    expect(stripLeadingComment("// nothing follows")).toBe("");
  });

  it("has no signature to report for a symbol with no declaration", () => {
    expect(declarationText({ declarations: undefined } as unknown as ts.Symbol)).toBe("");
  });

  it("renders a report a diff can be read from", () => {
    const rendered = renderReport("@tholus/example", [
      { name: "alpha", kind: "function", signature: "export declare function alpha(): void;" },
    ]);
    expect(rendered).toContain("# @tholus/example");
    expect(rendered).toContain("1 public export.");
    expect(rendered).toContain("export declare function alpha(): void;");
  });

  it("says `exports` when there is more than one", () => {
    expect(renderReport("x", [])).toContain("0 public exports.");
  });
});
