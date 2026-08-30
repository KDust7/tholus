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

await rm(site, { recursive: true, force: true });

for (const [served, source] of FILES) {
  const destination = join(site, served);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

process.stdout.write(`assembled ${FILES.length} files into ${site}\n`);
