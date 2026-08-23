import { readFileSync } from "node:fs";

const FLOOR = 80;

const [reportPath, ...wanted] = process.argv.slice(2);
if (reportPath === undefined || wanted.length === 0) {
  throw new Error("usage: check-rust-coverage.mjs <llvm-cov-json> <crate-directory>…");
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
  const line = `${crate}: ${percent.toFixed(1)}% of ${count} lines across ${seen} files`;
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
