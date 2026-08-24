import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SHIPPING = [
  "core",
  "engine-protocol",
  "pyodide",
  "transport-fetch",
  "transport-libcurl",
  "xterm",
];

const REQUIRED_KEYWORDS = ["uv", "python", "wasm"];
const DISCLAIMER = /[Nn]ot affiliated with or endorsed by Astral/;

const problems = [];
const notes = [];

function manifest(name) {
  return JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"));
}

const versions = new Set();
for (const name of SHIPPING) {
  const pkg = manifest(name);
  const where = `packages/${name}`;
  versions.add(pkg.version);

  if (!pkg.description) problems.push(`${where}: no description for the npm page`);
  if (!pkg.license) problems.push(`${where}: no license`);
  if (!pkg.repository?.url) problems.push(`${where}: no repository, so provenance has nothing to link`);
  if (!pkg.homepage) problems.push(`${where}: no homepage`);
  if (pkg.publishConfig?.access !== "public") problems.push(`${where}: publishConfig.access is not "public"`);
  if (pkg.publishConfig?.provenance !== true) problems.push(`${where}: publishConfig.provenance is not set`);
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) problems.push(`${where}: no files list, so the tarball would carry the whole directory`);

  const keywords = pkg.keywords ?? [];
  const missing = REQUIRED_KEYWORDS.filter((word) => !keywords.includes(word));
  if (missing.length > 0) problems.push(`${where}: keywords are missing ${missing.join(", ")}`);

  if (pkg.private === true) {
    notes.push(`${where}: still private, which is correct until the reveal flips it`);
  }
}

if (versions.size !== 1) {
  problems.push(`the shipping packages are not in lockstep: ${[...versions].sort().join(", ")}`);
}

const workspacePinned = SHIPPING.flatMap((name) => {
  const pkg = manifest(name);
  return ["dependencies", "peerDependencies", "optionalDependencies"].flatMap((field) =>
    Object.entries(pkg[field] ?? {})
      .filter(([, range]) => typeof range === "string" && range.startsWith("workspace:"))
      .map(([dependency]) => `packages/${name}: ${field}.${dependency}`),
  );
});

if (workspacePinned.length > 0) {
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  for (const script of ["rewrite-workspace-deps.mjs", "check-tarballs.mjs"]) {
    if (!release.includes(script)) {
      problems.push(
        `${workspacePinned.length} shipping dependencies use the workspace protocol, which npm cannot resolve, ` +
          `but .github/workflows/release.yml never runs scripts/${script}. Publishing would ship tarballs ` +
          "that fail every consumer install with EUNSUPPORTEDPROTOCOL:\n  " +
          workspacePinned.join("\n  "),
      );
    }
  }
}

const readme = readFileSync(join(root, "README.md"), "utf8");
if (!DISCLAIMER.test(readme)) problems.push("README.md carries no non-affiliation disclaimer");

const demo = readFileSync(join(root, "apps/demo/index.html"), "utf8");
if (!DISCLAIMER.test(demo)) problems.push("apps/demo/index.html carries no non-affiliation disclaimer");

for (const guide of ["comparison.md", "embedding.md", "hosting.md", "parity.md", "privacy.md", "pyodide.md", "transports.md"]) {
  if (!existsSync(join(root, "docs", guide))) problems.push(`docs/${guide} is missing`);
}

const brand = readFileSync(join(root, "packages/core/src/brand.ts"), "utf8");
const coldStore = readFileSync(join(root, "packages/core/src/opfs-store.ts"), "utf8");
const internalName = brand.match(/INTERNAL_NAME = "([^"]+)"/)?.[1];
const strayBrand = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const src = join(root, "packages", entry.name, "src");
    return existsSync(src) ? walk(src) : [];
  })
  .filter((file) => !file.endsWith("brand.ts") && !file.endsWith(".test.ts"))
  .filter((file) => {
    if (internalName === undefined) return false;
    const source = readFileSync(file, "utf8").replace(/export const STORE_ROOT = "[^"]+";/, "");
    return new RegExp(`["']${internalName}["']`).test(source);
  });

if (internalName === undefined) problems.push("packages/core/src/brand.ts no longer declares INTERNAL_NAME");
if (brand.includes("STORAGE_SCOPE")) {
  problems.push("packages/core/src/brand.ts declares STORAGE_SCOPE again, which re-couples the opfs directory to the brand: renaming would then orphan every user's stored state");
}
if (/from "\.\/brand\.js"/.test(coldStore)) {
  problems.push("packages/core/src/opfs-store.ts imports the brand, so STORE_ROOT would follow a rename: it must stay a fixed literal");
}
const STORE_ROOT_FOREVER = "uv-wasm";
const storeRoot = coldStore.match(/export const STORE_ROOT = "([^"]+)";/)?.[1];
if (storeRoot !== STORE_ROOT_FOREVER) {
  problems.push(
    `STORE_ROOT is ${JSON.stringify(storeRoot)} but every build has written "${STORE_ROOT_FOREVER}" to opfs. ` +
      "It is pinned to that literal here on purpose: changing it orphans every user's stored state, " +
      "and a repo-wide rename will happily move both the constant and the test that guards it.",
  );
}

const engineLib = readFileSync(join(root, "crates/uv-wasm-engine/src/lib.rs"), "utf8");
const reportedName = engineLib.match(/format!\("(\S+) \{ENGINE_VERSION\}/)?.[1];
if (reportedName === undefined) {
  problems.push("crates/uv-wasm-engine/src/lib.rs no longer renders a name before ENGINE_VERSION, so the brand it reports cannot be checked");
} else if (reportedName !== internalName) {
  problems.push(`the engine reports itself as "${reportedName}" while the brand is "${internalName}": engine.version() is public surface and the two must move together`);
}
if (strayBrand.length > 0) {
  problems.push(
    `the internal name is hard-coded outside brand.ts, so renaming at reveal would miss it:\n  ${strayBrand
      .map((file) => file.slice(root.length + 1))
      .join("\n  ")}`,
  );
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
  });
}

for (const note of notes) console.log(`note: ${note}`);
if (problems.length > 0) {
  console.error(`\n${problems.length} thing${problems.length === 1 ? "" : "s"} stand between here and a publish:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`\nAll ${SHIPPING.length} shipping packages are ready to publish once the scope is claimed.`);
