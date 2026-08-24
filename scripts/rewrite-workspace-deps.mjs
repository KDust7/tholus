import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SHIPPING = [
  "core",
  "engine-protocol",
  "pyodide",
  "transport-fetch",
  "transport-libcurl",
  "xterm",
];

export const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

export const WORKSPACE_PROTOCOL = "workspace:";

export function rewritten(manifest, version) {
  const out = { ...manifest };
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (deps === undefined) {
      continue;
    }
    out[field] = Object.fromEntries(
      Object.entries(deps).map(([name, range]) => [
        name,
        typeof range === "string" && range.startsWith(WORKSPACE_PROTOCOL) ? version : range,
      ]),
    );
  }
  return out;
}

export function workspaceRangesIn(manifest) {
  return DEPENDENCY_FIELDS.flatMap((field) =>
    Object.entries(manifest[field] ?? {})
      .filter(([, range]) => typeof range === "string" && range.startsWith(WORKSPACE_PROTOCOL))
      .map(([name, range]) => ({ field, name, range })),
  );
}

function main(version) {
  if (!version) {
    process.stderr.write("usage: node scripts/rewrite-workspace-deps.mjs <version>\n");
    process.exit(1);
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let changed = 0;

  for (const name of SHIPPING) {
    const path = join(root, "packages", name, "package.json");
    const raw = readFileSync(path, "utf8");
    const manifest = JSON.parse(raw);
    const pinned = workspaceRangesIn(manifest);
    if (pinned.length === 0) {
      continue;
    }

    writeFileSync(path, `${JSON.stringify(rewritten(manifest, version), null, 2)}\n`, "utf8");
    changed += pinned.length;
    for (const { field, name: dependency } of pinned) {
      process.stdout.write(`packages/${name}: ${field}.${dependency} -> ${version}\n`);
    }
  }

  process.stdout.write(
    changed === 0
      ? "no workspace ranges to rewrite\n"
      : `${changed} workspace range${changed === 1 ? "" : "s"} pinned to ${version}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2]);
}
