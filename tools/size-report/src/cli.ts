import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
import {
  type Budgets,
  evaluate,
  formatFindings,
  hasFatalFinding,
  type Measurement,
} from "./report.js";

const toolDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(toolDir, "..", "..");

const budgets = JSON.parse(readFileSync(join(toolDir, "budgets.json"), "utf8")) as Budgets;

const measurements: Measurement[] = budgets.artifacts.map((artifact) => {
  const absolute = join(repoRoot, artifact.path);
  if (!existsSync(absolute)) {
    return {
      path: artifact.path,
      label: artifact.label,
      present: false,
      rawBytes: 0,
      brotliBytes: 0,
      gzipBytes: 0,
    };
  }
  const bytes = readFileSync(absolute);
  return {
    path: artifact.path,
    label: artifact.label,
    present: true,
    rawBytes: bytes.byteLength,
    brotliBytes: brotliCompressSync(bytes).byteLength,
    gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
  };
});

const baselinePath = process.env.UV_WASM_SIZE_BASELINE;
const baseline =
  baselinePath && existsSync(baselinePath)
    ? (JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, Measurement>)
    : undefined;

const findings = evaluate(budgets, measurements, { baseline });

process.stdout.write("Artifact sizes\n");
process.stdout.write(`${formatFindings(findings)}\n`);

const outputPath = join(repoRoot, "size-report.json");
const snapshot = Object.fromEntries(measurements.map((entry) => [entry.path, entry]));
writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
process.stdout.write(`\nWrote ${outputPath}\n`);

if (hasFatalFinding(findings)) {
  process.stdout.write("\nSize check failed.\n");
  process.exit(1);
}
