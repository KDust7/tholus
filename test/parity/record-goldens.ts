import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  CASES,
  FAILING,
  type GoldenCase,
  type Goldens,
  goldensPath,
  key,
  nativePath,
  normalize,
} from "./cli-goldens.js";

if (!existsSync(nativePath)) {
  throw new Error(
    `no native uv at ${nativePath}. Build it with \`cargo build -p uv\` inside vendor/uv, ` +
      "from the same fork commit the artifact was built from.",
  );
}

function run(args: readonly string[]): GoldenCase {
  const result = spawnSync(nativePath, [...args], { encoding: "buffer" });
  if (result.error) {
    throw result.error;
  }
  return {
    args: [...args],
    code: result.status ?? -1,
    stdout: normalize(result.stdout.toString("utf8")),
    stderr: normalize(result.stderr.toString("utf8")),
  };
}

function stamp(): string {
  const version = spawnSync(nativePath, ["--version"], { encoding: "utf8" }).stdout ?? "";
  return /\(([0-9a-f]{7,40}) /.exec(version)?.[1] ?? version.trim();
}

const failing = new Set(FAILING.map(key));
const cases = CASES.map((args) => {
  const recorded = run(args);
  const channel = failing.has(key(args)) ? recorded.stderr : recorded.stdout;
  if (channel.length === 0) {
    throw new Error(
      `\`uv ${key(args)}\` recorded nothing, so the golden would agree with anything`,
    );
  }
  if (recorded.stdout.includes(nativePath) || recorded.stderr.includes(nativePath)) {
    throw new Error(`\`uv ${key(args)}\` leaked the host path into its output; normalize it first`);
  }
  return recorded;
});

const goldens: Goldens = {
  recordedAt: new Date().toISOString(),
  recordedFrom: stamp(),
  cases,
};

mkdirSync(dirname(goldensPath), { recursive: true });
await writeFile(goldensPath, `${JSON.stringify(goldens, null, 2)}\n`);

console.log(`recorded ${cases.length} cases from ${goldens.recordedFrom} to ${goldensPath}`);
