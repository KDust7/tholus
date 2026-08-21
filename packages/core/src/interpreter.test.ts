import { describe, expect, it } from "vitest";

import {
  BROWSER_PYTHON,
  checkInterpreter,
  InconsistentInterpreter,
  interpreterAbiTag,
  UNKNOWN_ABI,
} from "./interpreter.js";

const profile = {
  platform: { os: { name: "pyemscripten", major: 2026, minor: 0 }, arch: "wasm32" },
  markers: {
    implementation_name: "cpython",
    python_full_version: "3.14.0",
    python_version: "3.14",
  },
  stdlib: "/lib/python3.14",
  extension_suffixes: [".cpython-314-wasm32-emscripten.so", ".so"],
  scheme: { purelib: "/lib/python3.14/site-packages" },
  virtualenv: { purelib: "lib/python3.14/site-packages" },
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

const reading = (body: unknown) => vfsOf({ [BROWSER_PYTHON]: JSON.stringify(body) });

describe("the cache is keyed by the interpreter its wheels were built for", () => {
  it("names the implementation, the version and the platform tag", () => {
    expect(interpreterAbiTag(reading(profile))).toBe("cpython-3.14.0-pyemscripten_2026_0_wasm32");
  });

  it("separates two pyodide releases, which is the whole point", () => {
    const older = {
      ...profile,
      platform: { os: { name: "pyemscripten", major: 2025, minor: 0 }, arch: "wasm32" },
    };
    expect(interpreterAbiTag(reading(older))).not.toBe(interpreterAbiTag(reading(profile)));
  });

  it("separates two python versions, which decide the abi tag of every wheel", () => {
    const newer = {
      ...profile,
      markers: { ...profile.markers, python_full_version: "3.15.0", python_version: "3.15" },
      stdlib: "/lib/python3.15",
      extension_suffixes: [".cpython-315-wasm32-emscripten.so", ".so"],
      scheme: { purelib: "/lib/python3.15/site-packages" },
      virtualenv: { purelib: "lib/python3.15/site-packages" },
    };
    expect(interpreterAbiTag(reading(newer))).toBe("cpython-3.15.0-pyemscripten_2026_0_wasm32");
  });

  it("says so rather than guessing when there is no interpreter", () => {
    expect(interpreterAbiTag(vfsOf({}))).toBe(UNKNOWN_ABI);
  });

  it("says so rather than throwing when the profile is not json", () => {
    expect(interpreterAbiTag(vfsOf({ [BROWSER_PYTHON]: "not json" }))).toBe(UNKNOWN_ABI);
  });

  it("says so rather than building half a tag from a profile missing its platform", () => {
    expect(interpreterAbiTag(reading({ markers: { python_full_version: "3.14.0" } }))).toBe(
      UNKNOWN_ABI,
    );
  });
});

describe("an interpreter that disagrees with itself is refused when it is read", () => {
  it("accepts the profile the engine seeds", () => {
    expect(checkInterpreter(profile)).toEqual([]);
  });

  it("catches an extension suffix built for another python", () => {
    const swapped = { ...profile, extension_suffixes: [".cpython-313-wasm32-emscripten.so"] };
    expect(checkInterpreter(swapped)).toEqual([
      "extension suffix .cpython-313-wasm32-emscripten.so is built for python 3.13, not 3.14",
    ]);
  });

  it("catches an extension suffix built for another architecture", () => {
    const swapped = { ...profile, extension_suffixes: [".cpython-314-x86_64-linux-gnu.so"] };
    expect(checkInterpreter(swapped)).toEqual([
      "extension suffix .cpython-314-x86_64-linux-gnu.so is built for x86_64, not wasm32",
    ]);
  });

  it("catches a short version that is not a prefix of the full one", () => {
    const swapped = { ...profile, markers: { ...profile.markers, python_version: "3.13" } };
    expect(checkInterpreter(swapped)).toEqual([
      "python_version 3.13 does not match python_full_version 3.14.0",
    ]);
  });

  it("catches a site-packages path left behind by another python", () => {
    const swapped = { ...profile, virtualenv: { purelib: "lib/python3.11/site-packages" } };
    expect(checkInterpreter(swapped)).toEqual([
      "virtualenv.purelib lib/python3.11/site-packages is laid out for python 3.11, not 3.14",
    ]);
  });

  it("reports every disagreement, not just the first", () => {
    const swapped = {
      ...profile,
      stdlib: "/lib/python3.11",
      extension_suffixes: [".cpython-313-wasm32-emscripten.so"],
    };
    expect(checkInterpreter(swapped)).toHaveLength(2);
  });

  it("tolerates a suffix that claims nothing, and a profile that omits the optional parts", () => {
    const bare = { platform: profile.platform, markers: profile.markers };
    expect(checkInterpreter({ ...bare, extension_suffixes: [".so", ".abi3.so"] })).toEqual([]);
  });

  it("refuses to key a cache on an interpreter that disagrees with itself", () => {
    const swapped = { ...profile, extension_suffixes: [".cpython-313-wasm32-emscripten.so"] };
    expect(() => interpreterAbiTag(reading(swapped))).toThrow(InconsistentInterpreter);
  });

  it("names the file and every disagreement, so the host can fix its profile", () => {
    const swapped = { ...profile, markers: { ...profile.markers, python_version: "3.13" } };
    expect(() => interpreterAbiTag(reading(swapped))).toThrow(
      /\/bin\/python3.*python_version 3\.13 does not match/s,
    );
  });
});
