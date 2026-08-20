import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import {
  CASES,
  FAILING,
  type GoldenCase,
  type Goldens,
  goldensPath,
  jsPath,
  key,
  nativePath,
  normalize,
  PROGRAM,
  SUCCEEDING,
  wasmPath,
} from "./cli-goldens.js";

const hasEngine = existsSync(wasmPath) && existsSync(jsPath);
const hasGoldens = existsSync(goldensPath);
const hasNative = existsSync(nativePath);
const canCompare = hasEngine && hasGoldens;

if (process.env.CI && !canCompare) {
  throw new Error(
    "the byte-parity gate cannot run: the engine artifact or the recorded goldens are missing. " +
      "Skipping here would report a gate that never ran.",
  );
}

if (!canCompare) {
  console.warn(
    `[native-parity] SKIPPED, needs the engine artifact in packages/core/assets and goldens at ${goldensPath}. ` +
      "Record them with `bun run --filter @uv-wasm/parity record` where a native uv exists.",
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

function native(args: readonly string[]): Output {
  const result = spawnSync(nativePath, [...args], { encoding: "buffer" });
  return {
    code: result.status ?? -1,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  };
}

describe.skipIf(!canCompare)("the engine matches native uv byte for byte", () => {
  let engine: EngineInstance;
  let goldens: Map<string, GoldenCase>;

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as EngineModule;
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    engine = new mod.Engine();

    const recorded = JSON.parse(await readFile(goldensPath, "utf8")) as Goldens;
    goldens = new Map(recorded.cases.map((entry) => [key(entry.args), entry]));
    for (const args of CASES) {
      expect(goldens.has(key(args)), `no golden for \`uv ${key(args)}\`; re-record`).toBe(true);
    }
  }, 180_000);

  async function browser(args: readonly string[]): Promise<Output> {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const code = await engine.invoke([PROGRAM, ...args], (stream, data) => {
      (stream === "stdout" ? stdout : stderr).push(data);
    });
    const join = (parts: Uint8Array[]): string => Buffer.concat(parts).toString("utf8");
    return { code, stdout: join(stdout), stderr: join(stderr) };
  }

  it.each(SUCCEEDING.map((args) => [key(args), args] as const))(
    "matches the recorded `uv %s` exactly",
    async (_name, args) => {
      const golden = goldens.get(key(args)) as GoldenCase;
      expect(
        golden.stdout.length,
        "the golden printed nothing, so this comparison would agree with anything",
      ).toBeGreaterThan(0);

      const here = await browser(args);
      expect(normalize(here.stdout)).toBe(golden.stdout);
      expect(normalize(here.stderr)).toBe(golden.stderr);
      expect(here.code).toBe(golden.code);
    },
    120_000,
  );

  it.each(FAILING.map((args) => [key(args), args] as const))(
    "matches the recorded failure for `uv %s` exactly",
    async (_name, args) => {
      const golden = goldens.get(key(args)) as GoldenCase;
      expect(
        golden.stderr.length,
        "the golden reported nothing, so this comparison would agree with anything",
      ).toBeGreaterThan(0);

      const here = await browser(args);
      expect(normalize(here.stderr)).toBe(golden.stderr);
      expect(normalize(here.stdout)).toBe(golden.stdout);
      expect(here.code).toBe(golden.code);
    },
    120_000,
  );

  it.skipIf(!hasNative).each(CASES.map((args) => [key(args), args] as const))(
    "the golden still matches what native uv prints for `uv %s`",
    (_name, args) => {
      const golden = goldens.get(key(args)) as GoldenCase;
      const there = native(args);
      expect(normalize(there.stdout), "the golden is stale; re-record it").toBe(golden.stdout);
      expect(normalize(there.stderr), "the golden is stale; re-record it").toBe(golden.stderr);
      expect(there.code, "the golden is stale; re-record it").toBe(golden.code);
    },
    120_000,
  );

  it("takes its program name from argv[0], as native takes it from its path", async () => {
    const here = await browser(["--help"]);
    expect(here.stdout).toContain(`Usage: ${PROGRAM} [OPTIONS]`);
  });

  it("reports its own target in --version", async () => {
    expect((await browser(["--version"])).stdout).toContain("wasm32-unknown-unknown");
  });

  it.skipIf(!hasNative)("was built from the same commit as the native binary", async () => {
    const [there, here] = [native(["--version"]), await browser(["--version"])];
    const commit = (text: string): string | undefined =>
      /^uv \S+ \((\S+ \S+) /.exec(text)?.[1] ?? undefined;
    expect(
      commit(here.stdout),
      "the artifact and the native binary carry different commit stamps, so --version cannot match; rebuild both from one tree",
    ).toBe(commit(there.stdout));
  });

  it.skipIf(!hasNative)("does not report the browser target for the native build", () => {
    expect(native(["--version"]).stdout).not.toContain("wasm32-unknown-unknown");
  });
});
