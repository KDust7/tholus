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
  ["--version"],
  ["help"],
  ["help", "pip"],
  ["help", "venv"],
  ["auth", "--help"],
  ["run", "--help"],
  ["init", "--help"],
  ["add", "--help"],
  ["remove", "--help"],
  ["version", "--help"],
  ["sync", "--help"],
  ["lock", "--help"],
  ["export", "--help"],
  ["tree", "--help"],
  ["format", "--help"],
  ["check", "--help"],
  ["audit", "--help"],
  ["tool", "--help"],
  ["python", "--help"],
  ["pip", "--help"],
  ["venv", "--help"],
  ["build", "--help"],
  ["publish", "--help"],
  ["workspace", "--help"],
  ["cache", "--help"],
  ["self", "--help"],
  ["pip", "install", "--help"],
  ["pip", "compile", "--help"],
  ["pip", "sync", "--help"],
  ["pip", "uninstall", "--help"],
  ["pip", "list", "--help"],
  ["pip", "freeze", "--help"],
  ["pip", "show", "--help"],
  ["pip", "check", "--help"],
  ["pip", "tree", "--help"],
  ["python", "list", "--help"],
  ["python", "find", "--help"],
  ["python", "pin", "--help"],
  ["python", "install", "--help"],
  ["python", "dir", "--help"],
  ["tool", "run", "--help"],
  ["tool", "install", "--help"],
  ["tool", "list", "--help"],
  ["tool", "dir", "--help"],
  ["tool", "uninstall", "--help"],
  ["cache", "clean", "--help"],
  ["cache", "prune", "--help"],
  ["cache", "dir", "--help"],
  ["self", "version", "--help"],
  ["auth", "login", "--help"],
  ["auth", "token", "--help"],
  ["self", "version"],
];

export const FAILING: readonly (readonly string[])[] = [
  ["--nonesuch"],
  ["--nonesuch", "x"],
  ["install"],
  ["pip"],
  ["python"],
  ["tool"],
  ["cache"],
  ["self"],
  ["auth"],
  ["pip", "--nonesuch"],
  ["pip", "install"],
  ["pip", "compile"],
  ["pip", "show"],
  ["pip", "uninstall"],
  ["pip", "install", "--nonesuch"],
  ["venv", "--python"],
  ["pip", "compile", "--annotation-style", "bogus"],
  ["pip", "install", "--link-mode", "bogus"],
  ["pip", "compile", "-", "--resolution", "bogus"],
  ["pip", "list", "--format", "bogus"],
  ["--color", "bogus", "--help"],
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
