import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderReport, surfaceOf } from "./report.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const PACKAGES = [
  "core",
  "engine-protocol",
  "mock-engine",
  "pyodide",
  "transport-fetch",
  "transport-libcurl",
  "xterm",
] as const;

async function main(): Promise<void> {
  const out = resolve(root, "api");
  await mkdir(out, { recursive: true });

  const missing: string[] = [];
  for (const name of PACKAGES) {
    const entry = resolve(root, "packages", name, "dist/index.d.ts");
    if (!existsSync(entry)) {
      missing.push(name);
      continue;
    }
    const entries = surfaceOf(entry);
    await writeFile(
      resolve(out, `${name}.api.md`),
      renderReport(`@tholus/${name}`, entries),
      "utf8",
    );
    process.stdout.write(`@tholus/${name}: ${entries.length} exports\n`);
  }

  if (missing.length > 0) {
    process.stderr.write(
      `no built types for ${missing.join(", ")}; run \`bun run build\` first so the report ` +
        "describes what is actually shipped\n",
    );
    process.exitCode = 1;
  }
}

await main();
