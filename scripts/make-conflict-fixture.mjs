import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "test/fixtures/conflicts");

const packages = [
  { name: "uv-wasm-left", version: "1.0.0", requires: ["uv-wasm-shared==1.0.0"] },
  { name: "uv-wasm-right", version: "1.0.0", requires: ["uv-wasm-shared==2.0.0"] },
  { name: "uv-wasm-shared", version: "1.0.0", requires: [] },
  { name: "uv-wasm-shared", version: "2.0.0", requires: [] },
];

const wheelName = ({ name, version }) => `${name.replaceAll("-", "_")}-${version}-py3-none-any.whl`;

function metadata({ name, version, requires }) {
  const lines = [
    "Metadata-Version: 2.3",
    `Name: ${name}`,
    `Version: ${version}`,
    "Requires-Python: >=3.8",
    ...requires.map((requirement) => `Requires-Dist: ${requirement}`),
    "",
    "",
  ];
  return lines.join("\n");
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const responses = {};

function record(path, body, contentType) {
  responses[path] = {
    status: 200,
    headers: { "content-type": contentType },
    body: Buffer.from(body, "utf8").toString("base64"),
  };
}

const byName = new Map();
for (const entry of packages) {
  const list = byName.get(entry.name) ?? [];
  list.push(entry);
  byName.set(entry.name, list);
}

for (const [name, entries] of byName) {
  const links = entries.map((entry) => {
    const file = wheelName(entry);
    const core = metadata(entry);
    const digest = sha256(core);
    record(`/files/${file}.metadata`, core, "text/plain");
    record(`/files/${file}`, "not a real wheel; metadata is served alongside it", "application/zip");
    return (
      `<a href="/files/${file}#sha256=${sha256(file)}" ` +
      `data-core-metadata="sha256=${digest}" ` +
      `data-dist-info-metadata="sha256=${digest}" ` +
      `data-requires-python="&gt;=3.8">${file}</a><br/>`
    );
  });
  const page = [
    "<!DOCTYPE html>",
    '<html><head><meta name="pypi:repository-version" content="1.0"></head><body>',
    `<h1>Links for ${name}</h1>`,
    ...links,
    "</body></html>",
    "",
  ].join("\n");
  record(`/simple/${name}/`, page, "text/html; charset=utf-8");
}

const snapshot = {
  recordedAt: new Date().toISOString(),
  requirements: ["uv-wasm-left==1.0.0", "uv-wasm-right==1.0.0"],
  args: ["pip", "compile", "requirements.in", "--no-cache", "--no-header"],
  failing: true,
  responses,
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(
  `conflicts: ${Object.keys(responses).length} responses across ${byName.size} packages, hand-authored`,
);
