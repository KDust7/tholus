import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "package.json"));

const FILES = ["libcurl.mjs", "libcurl.wasm"];

const source = dirname(require.resolve("libcurl.js/libcurl.wasm"));
const destination = resolve(here, "dist/libcurl");
await mkdir(destination, { recursive: true });

for (const name of FILES) {
  await copyFile(join(source, name), join(destination, name));
}

console.log(`copied ${FILES.length} libcurl files into ${destination}`);
