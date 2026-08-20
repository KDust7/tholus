import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const root = resolve(here, "../..");
export const assets = resolve(root, "packages/core/assets");
export const wasmPath = resolve(assets, "engine_bg.wasm");
export const jsPath = resolve(assets, "engine.js");
export const goldensPath = resolve(root, "test/fixtures/cli/goldens.json");

export const nativePath = resolve(
  root,
  "vendor/uv/target/debug",
  process.platform === "win32" ? "uv.exe" : "uv",
);

export const PROGRAM = basename(nativePath);

export interface GoldenCase {
  args: string[];
  code: number;
  stdout: string;
  stderr: string;
}

export interface Goldens {
  recordedAt: string;
  recordedFrom: string;
  cases: GoldenCase[];
}

export const SUCCEEDING: readonly (readonly string[])[] = [
  ["--help"],
  ["pip", "--help"],
  ["python", "--help"],
  ["pip", "install", "--help"],
  ["--version"],
];

export const FAILING: readonly (readonly string[])[] = [
  ["--nonesuch"],
  ["install"],
  ["pip", "--nonesuch"],
];

export const CASES: readonly (readonly string[])[] = [...SUCCEEDING, ...FAILING];

export const key = (args: readonly string[]): string => args.join(" ");

const USAGE_PROGRAM = /^Usage: \S+/gm;
const VERSION_STAMP = /^uv (\d+\.\d+\.\d+)\+\d+ \([0-9a-f]{7,40} \d{4}-\d{2}-\d{2} [^)]+\)/gm;

export function normalize(text: string): string {
  return text
    .replace(USAGE_PROGRAM, "Usage: <PROGRAM>")
    .replace(VERSION_STAMP, "uv $1+<COMMITS> (<COMMIT> <DATE> <TARGET>)");
}
