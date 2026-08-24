import type { HookTree } from "@tholus/engine-protocol";
import { describe, expect, it } from "vitest";
import { collectWrite, removeMirror, runBuildHook, walkMirror } from "./build.js";
import type { PyodideLike } from "./facts.js";
import { MemFs } from "./testing/memfs.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const tree = (overrides: Partial<HookTree> = {}): HookTree => ({
  root: "/venv",
  collect: "new",
  entries: [],
  bytes: new Uint8Array(0),
  ...overrides,
});

const textOf = (bytes: Uint8Array, offset: number, length: number): string =>
  decoder.decode(bytes.subarray(offset, offset + length));

describe("walking the mirror reads back what python left behind", () => {
  it("reports files and symlinks, and never the bytecode python derives", () => {
    const fs = new MemFs();
    fs.writeFile("/venv/pyvenv.cfg", encoder.encode("home"));
    fs.writeFile("/venv/__pycache__/setup.cpython-314.pyc", encoder.encode("junk"));
    fs.writeFile("/venv/lib/site-packages/a/__pycache__/a.pyc", encoder.encode("junk"));
    fs.writeFile("/venv/lib/site-packages/a/__init__.py", encoder.encode("x"));
    fs.symlink("/bin/python3", "/venv/bin/python");

    expect(walkMirror(fs, "/venv").map((item) => item.path)).toEqual([
      "bin/python",
      "lib/site-packages/a/__init__.py",
      "pyvenv.cfg",
    ]);
  });
});

describe("a venv is pushed to be read, so only what the hook created comes back", () => {
  it("returns the files the hook created and leaves the venv itself behind", () => {
    const fs = new MemFs();
    fs.writeFile("/venv/pyvenv.cfg", encoder.encode("home"));
    fs.writeFile("/venv/build_wheel.txt", encoder.encode("demo.whl"));
    fs.writeFile("/venv/metadata_directory/demo.dist-info/METADATA", encoder.encode("Name: demo"));

    const write = collectWrite(
      tree({
        entries: [{ kind: "file", path: "pyvenv.cfg", offset: 0, length: 4 }],
        bytes: encoder.encode("home"),
      }),
      walkMirror(fs, "/venv"),
    );

    expect(write.entries.map((entry) => entry.path)).toEqual([
      "build_wheel.txt",
      "metadata_directory/demo.dist-info/METADATA",
    ]);
    expect(write.removed).toEqual([]);
  });

  it("does not report a venv file the hook rewrote, because uv never reads it back", () => {
    const fs = new MemFs();
    fs.writeFile("/venv/pyvenv.cfg", encoder.encode("CHANGED"));

    const write = collectWrite(
      tree({
        entries: [{ kind: "file", path: "pyvenv.cfg", offset: 0, length: 4 }],
        bytes: encoder.encode("home"),
      }),
      walkMirror(fs, "/venv"),
    );
    expect(write.entries).toEqual([]);
  });
});

describe("a source tree travels both ways, so a deletion has to be expressible", () => {
  const pushed = tree({
    root: "/src",
    collect: "changes",
    entries: [
      { kind: "file", path: "a.py", offset: 0, length: 1 },
      { kind: "file", path: "gone.py", offset: 1, length: 1 },
      { kind: "file", path: "same.py", offset: 2, length: 1 },
    ],
    bytes: encoder.encode("AGS"),
  });

  it("carries back what changed and names what the backend deleted", () => {
    const fs = new MemFs();
    fs.writeFile("/src/a.py", encoder.encode("Z"));
    fs.writeFile("/src/same.py", encoder.encode("S"));
    fs.writeFile("/src/new.py", encoder.encode("N"));

    const write = collectWrite(pushed, walkMirror(fs, "/src"));

    expect(write.entries.map((entry) => entry.path)).toEqual(["a.py", "new.py"]);
    expect(write.removed).toEqual(["gone.py"]);
  });

  it("packs the returned bytes so each entry addresses its own slice", () => {
    const fs = new MemFs();
    fs.writeFile("/src/a.py", encoder.encode("Z"));
    fs.writeFile("/src/same.py", encoder.encode("S"));
    fs.writeFile("/src/new.py", encoder.encode("NN"));

    const write = collectWrite(pushed, walkMirror(fs, "/src"));
    const read = write.entries.map((entry) =>
      entry.kind === "file" ? textOf(write.bytes, entry.offset, entry.length) : entry.target,
    );
    expect(read).toEqual(["Z", "NN"]);
  });

  it("keeps a symlink whose target the hook repointed", () => {
    const fs = new MemFs();
    fs.symlink("/new/target", "/src/link");

    const write = collectWrite(
      tree({
        root: "/src",
        collect: "changes",
        entries: [{ kind: "symlink", path: "link", target: "/old/target" }],
      }),
      walkMirror(fs, "/src"),
    );
    expect(write.entries).toEqual([{ kind: "symlink", path: "link", target: "/new/target" }]);
  });
});

describe("the mirror is swept, so one build cannot leak into the next", () => {
  it("leaves nothing of the tree behind", () => {
    const fs = new MemFs();
    fs.writeFile("/src/nested/deep/a.py", encoder.encode("x"));
    fs.symlink("/elsewhere", "/src/link");

    removeMirror(fs, "/src");
    expect(fs.paths().filter((path) => path.startsWith("/src"))).toEqual([]);
  });
});

function fakePyodide(onHook: (fs: MemFs) => string): PyodideLike & { ran: string[] } {
  const fs = new MemFs();
  const ran: string[] = [];
  return {
    ran,
    version: "314.0.5",
    FS: fs,
    runPython(code: string) {
      ran.push(code);
      return code.startsWith("_uvwasm_run_hook(") ? onHook(fs) : "";
    },
  };
}

describe("running a build hook mirrors, runs, collects and sweeps", () => {
  it("hands back what the hook wrote and clears the mirror afterwards", () => {
    const pyodide = fakePyodide((fs) => {
      fs.writeFile("/venv/build_wheel.txt", encoder.encode("demo-0.1.0.whl"));
      fs.writeFile("/wheels/demo-0.1.0.whl", encoder.encode("PK"));
      return JSON.stringify({ stdout: ["built"], stderr: [], code: 0 });
    });

    const outcome = runBuildHook(pyodide, {
      script: "print('build')",
      cwd: "/src",
      env: { PEP517: "1" },
      sitePackages: ["/venv/lib/python3.14/site-packages"],
      trees: [
        tree({
          root: "/venv",
          collect: "new",
          entries: [{ kind: "file", path: "pyvenv.cfg", offset: 0, length: 4 }],
          bytes: encoder.encode("home"),
        }),
        tree({ root: "/src", collect: "changes" }),
        tree({ root: "/wheels", collect: "changes" }),
      ],
    });

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toEqual(["built"]);
    expect(outcome.writes.map((write) => [write.root, write.entries.map((e) => e.path)])).toEqual([
      ["/venv", ["build_wheel.txt"]],
      ["/src", []],
      ["/wheels", ["demo-0.1.0.whl"]],
    ]);
    expect((pyodide.FS as MemFs).paths()).toEqual([]);
  });

  it("sweeps the mirror even when the hook throws", () => {
    const pyodide = fakePyodide(() => {
      throw new Error("pyodide died");
    });

    expect(() =>
      runBuildHook(pyodide, {
        script: "print('x')",
        cwd: "/src",
        env: {},
        sitePackages: [],
        trees: [tree({ root: "/src", collect: "changes" })],
      }),
    ).toThrow(/pyodide died/);
    expect((pyodide.FS as MemFs).paths()).toEqual([]);
  });
});
