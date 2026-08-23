import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const [rawDestination] = process.argv.slice(2);
if (rawDestination === undefined) {
  throw new Error("usage: install-pyodide-matrix.mjs <destination-directory>");
}
const destination = resolve(rawDestination);
mkdirSync(destination, { recursive: true });

const registry = await (await fetch("https://registry.npmjs.org/pyodide")).json();
const tags = registry["dist-tags"] ?? {};
const stable = Object.keys(registry.versions ?? {}).filter((version) => !version.includes("-"));

const latest = tags.latest;
if (latest === undefined) {
  throw new Error("the pyodide package has no `latest` tag, so there is no stable to check");
}
const previous = stable.filter((version) => version !== latest).at(-1);
const next = tags.next !== latest ? tags.next : undefined;

const wanted = [
  { channel: "stable", version: latest },
  ...(previous === undefined ? [] : [{ channel: "previous", version: previous }]),
  ...(next === undefined ? [] : [{ channel: "next", version: next }]),
];

const entries = [];
for (const { channel, version } of wanted) {
  const into = join(destination, version);
  mkdirSync(into, { recursive: true });
  if (!existsSync(join(into, "package", "pyodide.mjs"))) {
    const url = registry.versions?.[version]?.dist?.tarball;
    if (url === undefined) {
      throw new Error(`the registry lists no tarball for pyodide@${version}`);
    }
    const tarball = Buffer.from(await (await fetch(url)).arrayBuffer());
    execFileSync("tar", ["-xzf", "-"], { cwd: into, input: tarball });
  }
  entries.push({ channel, version, loader: join(into, "package", "pyodide.mjs") });
  console.log(`${channel}: pyodide ${version}`);
}

const manifest = join(destination, "matrix.json");
writeFileSync(manifest, `${JSON.stringify(entries, null, 2)}\n`);
console.log(manifest);
