import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const assets = resolve(root, "packages/core/assets");
const wasmPath = resolve(assets, "engine_bg.wasm");
const jsPath = resolve(assets, "engine.js");
const nativePath = resolve(
  root,
  "vendor/uv/target/debug",
  process.platform === "win32" ? "uv.exe" : "uv",
);

const canCompare = existsSync(wasmPath) && existsSync(jsPath) && existsSync(nativePath);
const PROGRAM = basename(nativePath);

if (!canCompare) {
  console.warn(
    `[native-parity] SKIPPED, this suite needs a natively built uv at ${nativePath}. ` +
      "Phase 1's byte-parity gate did NOT run. Unlike the compile matrix, it has no recorded " +
      "golden yet, so it can only run where the binary exists.",
  );
}

interface EngineInstance {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
}

interface EngineModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  Engine: new () => EngineInstance;
}

interface Output {
  code: number;
  stdout: string;
  stderr: string;
}

const TARGET_TRIPLE = /\b[a-z0-9_]+(?:-[a-z0-9_]+){2,3}\)/;

function withoutTargetTriple(text: string): string {
  return text.replace(TARGET_TRIPLE, "<target>)");
}

describe.skipIf(!canCompare)("the engine matches native uv byte for byte", () => {
  let engine: EngineInstance;

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as EngineModule;
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    engine = new mod.Engine();
  });

  async function browser(args: string[]): Promise<Output> {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const code = await engine.invoke([PROGRAM, ...args], (stream, data) => {
      (stream === "stdout" ? stdout : stderr).push(data);
    });
    const join = (parts: Uint8Array[]): string => Buffer.concat(parts).toString("utf8");
    return { code, stdout: join(stdout), stderr: join(stderr) };
  }

  function native(args: string[]): Output {
    const result = spawnSync(nativePath, args, { encoding: "buffer" });
    return {
      code: result.status ?? -1,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
  }

  it.each([["--help"], ["pip", "--help"], ["python", "--help"], ["pip", "install", "--help"]])(
    "matches `uv %s` exactly",
    async (...args: string[]) => {
      const [there, here] = [native(args), await browser(args)];
      expect(
        there.stdout.length,
        "native printed nothing, so this comparison would agree with anything",
      ).toBeGreaterThan(0);
      expect(here.stdout).toBe(there.stdout);
      expect(here.stderr).toBe(there.stderr);
      expect(here.code).toBe(there.code);
    },
    120_000,
  );

  it.each([["--nonesuch"], ["install"], ["pip", "--nonesuch"]])(
    "matches the failure for `uv %s` exactly",
    async (...args: string[]) => {
      const [there, here] = [native(args), await browser(args)];
      expect(
        there.stderr.length,
        "native reported nothing, so this comparison would agree with anything",
      ).toBeGreaterThan(0);
      expect(here.stderr).toBe(there.stderr);
      expect(here.stdout).toBe(there.stdout);
      expect(here.code).toBe(there.code);
    },
    120_000,
  );

  it("takes its program name from argv[0], as native takes it from its path", async () => {
    const here = await browser(["--help"]);
    expect(here.stdout).toContain(`Usage: ${PROGRAM} [OPTIONS]`);
  });

  it("was built from the same commit as the native binary", async () => {
    const [there, here] = [native(["--version"]), await browser(["--version"])];
    const stamp = (text: string): string | undefined =>
      /^uv \S+ \((\S+ \S+) /.exec(text)?.[1] ?? undefined;
    expect(
      stamp(here.stdout),
      "the artifact and the native binary carry different commit stamps, so --version cannot match; rebuild both from one tree",
    ).toBe(stamp(there.stdout));
  });

  it("matches `uv --version` once the target triple is normalized", async () => {
    const [there, here] = [native(["--version"]), await browser(["--version"])];
    expect(withoutTargetTriple(here.stdout)).toBe(withoutTargetTriple(there.stdout));
    expect(here.code).toBe(there.code);
  });

  it("reports each build's own target in --version", async () => {
    expect((await browser(["--version"])).stdout).toContain("wasm32-unknown-unknown");
    expect(native(["--version"]).stdout).not.toContain("wasm32-unknown-unknown");
  });
});
