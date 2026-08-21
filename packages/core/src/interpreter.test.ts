import { describe, expect, it } from "vitest";

import { BROWSER_PYTHON, interpreterAbiTag, UNKNOWN_ABI } from "./interpreter.js";

const profile = {
  platform: { os: { name: "pyemscripten", major: 2026, minor: 0 }, arch: "wasm32" },
  markers: { implementation_name: "cpython", python_full_version: "3.14.0" },
};

const vfsOf = (contents: Record<string, string>) => ({
  fsRead(path: string): Uint8Array {
    const found = contents[path];
    if (found === undefined) {
      throw new Error(`${path} was not found`);
    }
    return new TextEncoder().encode(found);
  },
});

describe("the cache is keyed by the interpreter its wheels were built for", () => {
  it("names the implementation, the version and the platform tag", () => {
    const vfs = vfsOf({ [BROWSER_PYTHON]: JSON.stringify(profile) });
    expect(interpreterAbiTag(vfs)).toBe("cpython-3.14.0-pyemscripten_2026_0_wasm32");
  });

  it("separates two pyodide releases, which is the whole point", () => {
    const older = {
      ...profile,
      platform: { os: { name: "pyemscripten", major: 2025, minor: 0 }, arch: "wasm32" },
    };
    const vfs = vfsOf({ [BROWSER_PYTHON]: JSON.stringify(older) });
    expect(interpreterAbiTag(vfs)).not.toBe(
      interpreterAbiTag(vfsOf({ [BROWSER_PYTHON]: JSON.stringify(profile) })),
    );
  });

  it("separates two python versions, which decide the abi tag of every wheel", () => {
    const newer = {
      ...profile,
      markers: { implementation_name: "cpython", python_full_version: "3.15.0" },
    };
    expect(interpreterAbiTag(vfsOf({ [BROWSER_PYTHON]: JSON.stringify(newer) }))).toBe(
      "cpython-3.15.0-pyemscripten_2026_0_wasm32",
    );
  });

  it("says so rather than guessing when there is no interpreter", () => {
    expect(interpreterAbiTag(vfsOf({}))).toBe(UNKNOWN_ABI);
  });

  it("says so rather than throwing when the profile is not json", () => {
    expect(interpreterAbiTag(vfsOf({ [BROWSER_PYTHON]: "not json" }))).toBe(UNKNOWN_ABI);
  });

  it("says so rather than building half a tag from a profile missing its platform", () => {
    const partial = JSON.stringify({ markers: { python_full_version: "3.14.0" } });
    expect(interpreterAbiTag(vfsOf({ [BROWSER_PYTHON]: partial }))).toBe(UNKNOWN_ABI);
  });
});
