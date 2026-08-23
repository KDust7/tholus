import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const FLOOR = 80;

const [reportPath, crateRoot, ...wanted] = process.argv.slice(2);
if (reportPath === undefined || crateRoot === undefined || wanted.length === 0) {
  throw new Error("usage: check-rust-coverage.mjs <llvm-cov-json> <crates-dir> <crate-name>…");
}

function sourceFiles(directory) {
  if (!existsSync(directory)) {
    return 0;
  }
  return readdirSync(directory, { withFileTypes: true }).reduce(
    (total, entry) =>
      total +
      (entry.isDirectory()
        ? sourceFiles(join(directory, entry.name))
        : entry.name.endsWith(".rs")
          ? 1
          : 0),
    0,
  );
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const files = report.data?.[0]?.files ?? [];
if (files.length === 0) {
  throw new Error(`${reportPath} names no files, so this check would pass on nothing`);
}

const totals = new Map(wanted.map((crate) => [crate, { covered: 0, count: 0, files: 0 }]));

for (const file of files) {
  const path = file.filename.split("\\").join("/");
  const crate = wanted.find((name) => path.includes(`/crates/${name}/`));
  if (crate === undefined) {
    continue;
  }
  const totalsFor = totals.get(crate);
  totalsFor.covered += file.summary.lines.covered;
  totalsFor.count += file.summary.lines.count;
  totalsFor.files += 1;
}

const failures = [];
for (const [crate, { covered, count, files: seen }] of totals) {
  if (seen === 0) {
    failures.push(`${crate}: the report holds no file from this crate; it was never measured`);
    continue;
  }
  const percent = count === 0 ? 0 : (100 * covered) / count;
  const present = sourceFiles(resolve(crateRoot, crate, "src"));
  const scope =
    present > seen
      ? `, ${seen} of its ${present} source files compile natively; the rest is wasm-only and is covered by the parity grid instead`
      : "";
  const line = `${crate}: ${percent.toFixed(1)}% of ${count} lines across ${seen} files${scope}`;
  if (percent < FLOOR) {
    failures.push(`${line}, below the ${FLOOR}% bar`);
  } else {
    console.log(line);
  }
}

if (failures.length > 0) {
  console.error("");
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}
