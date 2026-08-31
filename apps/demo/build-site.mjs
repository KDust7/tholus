import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const site = resolve(here, "dist/site");

const FILES = [
  ["index.html", join(here, "index.html")],
  ["demo/main.js", join(here, "dist/main.js")],
  ["demo/worker.js", join(root, "packages/core/dist/worker.js")],
  ["assets/engine.js", join(root, "packages/core/assets/engine.js")],
  ["assets/engine_bg.wasm", join(root, "packages/core/assets/engine_bg.wasm")],
  ["libcurl/libcurl.mjs", join(here, "dist/libcurl/libcurl.mjs")],
  ["libcurl/libcurl.wasm", join(here, "dist/libcurl/libcurl.wasm")],
];

const missing = FILES.filter(([, source]) => !existsSync(source));

if (missing.length > 0) {
  for (const [served, source] of missing) {
    process.stderr.write(`${served} is missing: nothing at ${source}\n`);
  }
  process.stderr.write(
    "The engine assets are gitignored and produced by `cargo xtask build`, " +
      "so assembling the site before that step deploys a page that 404s.\n",
  );
  process.exit(1);
}

await rm(site, { recursive: true, force: true });

for (const [served, source] of FILES) {
  const destination = join(site, served);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

process.stdout.write(`assembled ${FILES.length} files into ${site}\n`);
