import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "test/fixtures/conflicts");
const nativeUv = resolve(
  root,
  "vendor/uv/target/debug",
  process.platform === "win32" ? "uv.exe" : "uv",
);

const packages = [
  { name: "uv-wasm-left", version: "1.0.0", requires: ["uv-wasm-shared==1.0.0"] },
  { name: "uv-wasm-right", version: "1.0.0", requires: ["uv-wasm-shared==2.0.0"] },
  { name: "uv-wasm-shared", version: "1.0.0", requires: [] },
  { name: "uv-wasm-shared", version: "2.0.0", requires: [] },
];

const requirements = ["uv-wasm-left==1.0.0", "uv-wasm-right==1.0.0"];
const commandArgs = [
  "pip",
  "compile",
  "requirements.in",
  "--python-version",
  "3.14",
  "--no-cache",
  "--no-header",
];

const wheelName = ({ name, version }) => `${name.replaceAll("-", "_")}-${version}-py3-none-any.whl`;

function metadata({ name, version, requires }) {
  return [
    "Metadata-Version: 2.3",
    `Name: ${name}`,
    `Version: ${version}`,
    "Requires-Python: >=3.8",
    ...requires.map((requirement) => `Requires-Dist: ${requirement}`),
    "",
    "",
  ].join("\n");
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
  byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
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

const server = createServer((request, response) => {
  const recorded = responses[request.url ?? ""];
  if (!recorded) {
    console.error(`  the fixture has no response for ${request.url}`);
    response.writeHead(599).end();
    return;
  }
  const body = Buffer.from(recorded.body, "base64");
  response.writeHead(recorded.status, {
    ...recorded.headers,
    "content-length": String(body.byteLength),
  });
  response.end(body);
});

const port = await new Promise((ready) => {
  server.listen(0, "127.0.0.1", () => ready(server.address().port));
});

const workspace = mkdtempSync(join(tmpdir(), "uv-wasm-conflict-"));
writeFileSync(join(workspace, "requirements.in"), `${requirements.join("\n")}\n`);

const native = await new Promise((done, fail) => {
  const child = spawn(nativeUv, [
    ...commandArgs,
    "--index-url",
    `http://127.0.0.1:${port}/simple`,
    "--directory",
    workspace,
  ]);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", fail);
  child.on("close", (status) => done({ status, stderr }));
});

rmSync(workspace, { recursive: true, force: true });
await new Promise((done) => server.close(done));

if (native.status === 0 || !native.stderr.includes("No solution found")) {
  throw new Error(`the fixture did not produce a conflict:\n${native.stderr}`);
}

const version = spawnSync(nativeUv, ["--version"], { encoding: "utf8" }).stdout ?? "";
const commit = /\(([0-9a-f]{7,40}) /.exec(version);

const snapshot = {
  recordedAt: new Date().toISOString(),
  recordedFrom: commit ? commit[1] : version.trim(),
  requirements,
  args: commandArgs,
  expected: native.stderr,
  failing: true,
  responses,
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(
  `conflicts: ${Object.keys(responses).length} responses across ${byName.size} packages, ` +
    `hand-authored, golden captured from ${snapshot.recordedFrom}`,
);
