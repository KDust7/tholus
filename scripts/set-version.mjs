import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SHIPPING } from "./rewrite-workspace-deps.mjs";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const version = process.argv[2];

if (!version) {
  process.stderr.write("usage: node scripts/set-version.mjs <version>\n");
  process.exit(1);
}

if (!SEMVER.test(version)) {
  process.stderr.write(`"${version}" is not a version npm will accept\n`);
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const name of SHIPPING) {
  const path = join(root, "packages", name, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const was = manifest.version;
  writeFileSync(path, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`, "utf8");
  process.stdout.write(`packages/${name}: ${was} -> ${version}\n`);
}

process.stdout.write(
  `\nall ${SHIPPING.length} shipping packages carry ${version}. ` +
    "Commit that, then dispatch the release workflow with the same version.\n",
);
