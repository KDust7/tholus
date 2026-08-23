import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const summaryPath = resolve(root, "coverage/coverage-summary.json");

if (!existsSync(summaryPath)) {
  throw new Error(`${summaryPath} is missing; run the suite with --coverage first`);
}

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const packages = new Map();

for (const [file, metrics] of Object.entries(summary)) {
  if (file === "total") {
    continue;
  }
  const path = file.split("\\").join("/");
  const named = /\/(packages|tools|test)\/([^/]+)\//.exec(path);
  if (named === null) {
    continue;
  }
  const key = `${named[1]}/${named[2]}`;
  const totals = packages.get(key) ?? { lines: [0, 0], branches: [0, 0], functions: [0, 0] };
  for (const metric of ["lines", "branches", "functions"]) {
    totals[metric][0] += metrics[metric].covered;
    totals[metric][1] += metrics[metric].total;
  }
  packages.set(key, totals);
}

const percent = ([covered, total]) => (total === 0 ? "n/a" : `${((100 * covered) / total).toFixed(1)}%`);

const rows = [...packages]
  .sort()
  .map(
    ([name, totals]) =>
      `| ${name} | ${percent(totals.lines)} | ${percent(totals.branches)} | ${percent(totals.functions)} |`,
  );

process.stdout.write(
  `${[
    "## JavaScript coverage",
    "",
    `Every package is held to 80% on its own, not just the tree as a whole. Overall: **${summary.total.lines.pct}%** of lines.`,
    "",
    "| package | lines | branches | functions |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n")}\n`,
);
