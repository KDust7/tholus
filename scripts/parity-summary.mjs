import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "test/fixtures");
const goldens = join(fixtures, "cli/goldens.json");
const sizeReport = join(root, "size-report.json");

const FLOOR = 85;

function cells() {
  const families = new Map();
  const add = (family, count) => families.set(family, (families.get(family) ?? 0) + count);

  if (existsSync(goldens)) {
    const recorded = JSON.parse(readFileSync(goldens, "utf8"));
    add("cli", recorded.cases.length);
  }

  for (const name of readdirSync(fixtures)) {
    const path = join(fixtures, name, "snapshot.json");
    if (name === "cli" || !existsSync(path)) {
      continue;
    }
    const snapshot = JSON.parse(readFileSync(path, "utf8"));
    const family = snapshot.command === "install" ? "install" : "compile";
    add(family, 1 + (snapshot.variants?.length ?? 0) + (snapshot.followUps?.length ?? 0));
  }

  return families;
}

function fixtureBytes() {
  let total = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        total += readFileSync(path).byteLength;
      }
    }
  };
  walk(fixtures);
  return total;
}

const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

const families = cells();
const total = [...families.values()].reduce((sum, count) => sum + count, 0);

const lines = [
  "## Parity grid",
  "",
  `**${total} cells** compared against native uv, against a floor of ${FLOOR}.`,
  "",
  "| family | cells |",
  "| --- | --- |",
  ...[...families].sort().map(([family, count]) => `| ${family} | ${count} |`),
  `| **total** | **${total}** |`,
  "",
  `Replayed from ${mib(fixtureBytes())} of recorded index responses, so no run reaches the network.`,
];

if (existsSync(sizeReport)) {
  const measured = Object.values(JSON.parse(readFileSync(sizeReport, "utf8"))).filter(
    (entry) => entry.present === true,
  );
  if (measured.length > 0) {
    lines.push(
      "",
      "## Artifact",
      "",
      "| | raw | brotli | gzip |",
      "| --- | --- | --- | --- |",
      ...measured.map(
        (entry) =>
          `| ${entry.label} | ${mib(entry.rawBytes)} | ${mib(entry.brotliBytes)} | ${mib(entry.gzipBytes)} |`,
      ),
    );
  }
}

process.stdout.write(`${lines.join("\n")}\n`);

if (total < FLOOR) {
  process.exitCode = 1;
}
