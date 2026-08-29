import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { jsPath, nativePath, root, wasmPath } from "./cli-goldens.js";
import { type ReplayServer, startReplayServer } from "./replay-server.js";

const FIXTURE = resolve(root, "test/fixtures/install-pyodide");
const REQUIREMENT = "msgpack==1.1.2";
const WHEEL = "msgpack-1.1.2-cp314-cp314-pyemscripten_2026_0_wasm32.whl";

const crossPython = process.env.UV_WASM_PYODIDE_PYTHON ?? "";
const asked = crossPython !== "";
const ready =
  asked &&
  existsSync(crossPython) &&
  existsSync(nativePath) &&
  existsSync(wasmPath) &&
  existsSync(resolve(FIXTURE, "snapshot.json"));

if (asked && !ready) {
  throw new Error(
    "UV_WASM_PYODIDE_PYTHON names a cross venv but the native binary, the artifact or the " +
      "install-pyodide fixture is missing; skipping would report the baseline as met without it",
  );
}

const PROBE = [
  "import json, sys, sysconfig",
  "print(json.dumps({",
  '    "version": sys.version.split()[0],',
  '    "suffix": sysconfig.get_config_var("EXT_SUFFIX") or "",',
  '    "platform": sysconfig.get_platform(),',
  "}))",
].join("\n");

interface Profile {
  markers: { python_full_version: string };
  extension_suffixes: string[];
  platform: { os: { name: string; major: number; minor: number }; arch: string };
}

interface EngineInstance {
  fsRead(path: string): Uint8Array;
}

const SELECTING = /Selecting: \S+ \[compatible\] \(([^)]+)\)/;

const isBatch = /\.(bat|cmd)$/i.test(crossPython);

function runCross(args: string[]): { stdout: string; stderr: string } {
  const run = isBatch
    ? spawnSync(`"${crossPython}" ${args.map((arg) => `"${arg}"`).join(" ")}`, {
        encoding: "utf8",
        shell: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      })
    : spawnSync(crossPython, args, {
        encoding: "utf8",
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
  if (run.error) {
    throw run.error;
  }
  return { stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

function runNative(args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(nativePath, args, { env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    let log = "";
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      log += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      log += chunk;
    });
    child.on("error", fail);
    child.on("close", () => done(log));
  });
}

async function selectedWheel(args: string[]): Promise<{ wheel: string; log: string }> {
  const log = await runNative(args);
  return { wheel: SELECTING.exec(log)?.[1] ?? "", log };
}

describe.skipIf(!ready)("a real Pyodide cross venv agrees with the target we assert", () => {
  let workspace = "";
  let reported: { version: string; suffix: string; platform: string };
  let profile: Profile;
  let server: ReplayServer | undefined;

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "tholus-crossvenv-"));
    const script = join(workspace, "probe.py");
    writeFileSync(script, `${PROBE}\n`);
    const run = runCross([script]);
    const line = run.stdout.split("\n").find((text) => text.trim().startsWith("{"));
    expect(
      line,
      `the cross interpreter would not describe itself:\n${run.stdout}\n${run.stderr}`,
    ).toBeDefined();
    reported = JSON.parse(line as string);

    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as {
      default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
      Engine: new () => EngineInstance;
    };
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    const engine = new mod.Engine();
    profile = JSON.parse(new TextDecoder().decode(engine.fsRead("/bin/python3"))) as Profile;

    server = await startReplayServer(FIXTURE);
  }, 600_000);

  const minorOf = (version: string): string => version.split(".").slice(0, 2).join(".");

  it("reports the Python minor the engine seeds a profile for", () => {
    expect(minorOf(reported.version)).toBe(minorOf(profile.markers.python_full_version));
  }, 60_000);

  it("differs from the seeded profile only in the patch digit, which the host corrects", () => {
    expect(
      reported.version,
      "the seeded profile now disagrees with a real Pyodide beyond the patch digit; " +
        "attachPyodide probes rather than trusts, but the seed is what uv resolves against " +
        "before a runtime is attached",
    ).not.toBe(profile.markers.python_full_version);
    expect(profile.markers.python_full_version.split(".")).toHaveLength(3);
  }, 60_000);

  it("reports the extension suffix the engine seeds", () => {
    expect(profile.extension_suffixes[0]).toBe(reported.suffix);
  });

  it("reports an Emscripten platform at the version the profile names", () => {
    expect(reported.platform).toMatch(/^emscripten[-_]/);
    expect(profile.platform.os.name).toMatch(/emscripten|pyodide/);
    expect(profile.platform.arch).toBe("wasm32");
  });

  it("selects the same wheel as the platform flags the fixtures assert", async () => {
    const requirements = join(workspace, "requirements.in");
    writeFileSync(requirements, `${REQUIREMENT}\n`);
    const index = ["--index-url", `${server?.origin}/simple`];
    const common = ["pip", "install", "--dry-run", "-v", "--no-cache", REQUIREMENT, ...index];

    const derived = await selectedWheel([...common, "--python", crossPython]);
    const asserted = await selectedWheel([
      ...common,
      "--python-platform",
      "wasm32-pyodide2026",
      "--python-version",
      "3.14",
      "--target",
      join(workspace, "target"),
    ]);

    expect(derived.wheel, `no wheel was selected against the cross venv:\n${derived.log}`).toBe(
      WHEEL,
    );
    expect(
      asserted.wheel,
      "the flag-asserted target selected a different wheel from the one a real Pyodide derives, " +
        "so every install fixture is resolving for a platform that does not exist",
    ).toBe(derived.wheel);
  }, 900_000);

  it("asked the fixture for everything it needed, so nothing reached the live index", () => {
    expect(server?.misses, "the cross venv asked for something the snapshot does not hold").toEqual(
      [],
    );
    expect((server?.requested.length ?? 0) > 0).toBe(true);
  });

  it("cleans up", async () => {
    await server?.close();
    rmSync(workspace, { recursive: true, force: true });
  });
});
