import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FIXTURE_ORIGIN = "http://uv-wasm-fixture.invalid";
const UPSTREAM_INDEX = "https://pypi.org/simple";
const PYODIDE_INDEX = "https://index.pyodide.org/314.0.5";
const REWRITABLE = /json|html|text/i;
const HOSTED_FILES = /https:\/\/(?:files\.pythonhosted\.org|cdn\.jsdelivr\.net)\/[^"'\s<>]+/g;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeUv = resolve(
  root,
  "vendor/uv/target/debug",
  process.platform === "win32" ? "uv.exe" : "uv",
);

const EXCLUDE_NEWER = "2026-08-01T00:00:00Z";

const scenarios = {
  "pure-python": { requirements: ["idna==3.11"], extraArgs: [] },
  markers: {
    requirements: ["idna==3.11; python_version >= '3.10'"],
    extraArgs: [],
  },
  transitive: { requirements: ["requests==2.32.5"], extraArgs: [] },
  universal: { requirements: ["requests==2.32.5"], extraArgs: ["--universal"] },
  "pyodide-wheel": {
    requirements: ["msgpack==1.1.2"],
    extraArgs: ["--python-platform", "wasm32-pyodide2026", "--python-version", "3.14"],
    index: PYODIDE_INDEX,
    excludeNewer: false,
  },
};

const METADATA_SUFFIX = ".metadata";

const encodeFileUrl = (url) => {
  const [bare, fragment] = url.split("#");
  const filename = bare.split("/").pop();
  const encoded = Buffer.from(url, "utf8").toString("base64url");
  return `/files/${encoded}/${filename}${fragment ? `#${fragment}` : ""}`;
};

function decodeFileUrl(path) {
  const rest = path.slice("/files/".length);
  const slash = rest.indexOf("/");
  const encoded = slash === -1 ? rest : rest.slice(0, slash);
  const last = slash === -1 ? encoded : rest.slice(slash + 1);
  const suffix = last.endsWith(METADATA_SUFFIX) ? METADATA_SUFFIX : "";
  const segment =
    slash === -1 && suffix ? encoded.slice(0, -METADATA_SUFFIX.length) : encoded;
  return `${Buffer.from(segment, "base64url").toString("utf8")}${suffix}`;
}

function rewriteFileUrls(body, contentType, origin) {
  if (!REWRITABLE.test(contentType)) {
    return { stored: body, served: body, rewrite: false };
  }
  const text = body.toString("utf8");
  const stored = text.replace(
    HOSTED_FILES,
    (match) => `${FIXTURE_ORIGIN}${encodeFileUrl(match)}`,
  );
  const rewrite = stored !== text;
  const served = rewrite ? stored.split(FIXTURE_ORIGIN).join(origin) : text;
  return {
    stored: Buffer.from(stored, "utf8"),
    served: Buffer.from(served, "utf8"),
    rewrite,
  };
}

let enginePromise;

async function loadEngine() {
  const assets = resolve(root, "packages/core/assets");
  const mod = await import(pathToFileURL(resolve(assets, "engine.js")).href);
  await mod.default({
    module_or_path: new Uint8Array(await readFile(resolve(assets, "engine_bg.wasm"))),
  });
  return mod;
}

async function runBrowser(name, requirements, args) {
  enginePromise ??= loadEngine();
  const mod = await enginePromise;
  const engine = new mod.Engine();
  const directory = `/record-${name}`;
  engine.fsMkdirp(directory);
  engine.fsWrite(`${directory}/requirements.in`, new TextEncoder().encode(requirements));
  const decoder = new TextDecoder();
  let stderr = "";
  const status = await engine.invoke(
    ["uv", ...args, "--directory", directory],
    (stream, data) => {
      if (stream !== "stdout") {
        stderr += decoder.decode(data);
      }
    },
  );
  return { status, stderr };
}

function runNative(args) {
  return new Promise((done, fail) => {
    const child = spawn(nativeUv, args, { encoding: "utf8" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", fail);
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

const BYTE_RANGE = /^bytes=(\d*)-(\d*)$/;

function sliceForRange(header, size) {
  const match = header === undefined ? null : BYTE_RANGE.exec(header.trim());
  if (!match) {
    return undefined;
  }
  const [, rawStart, rawEnd] = match;
  if (rawStart === "") {
    const length = Number(rawEnd);
    if (rawEnd === "" || !Number.isFinite(length) || length <= 0) {
      return undefined;
    }
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(start) || start > end) {
    return undefined;
  }
  return { start, end };
}

function respond(response, rangeHeader, status, headers, body) {
  const range = status === 200 ? sliceForRange(rangeHeader, body.byteLength) : undefined;
  if (!range) {
    response.writeHead(status, {
      ...headers,
      "accept-ranges": "bytes",
      "content-length": String(body.byteLength),
    });
    response.end(body);
    return;
  }
  const slice = body.subarray(range.start, range.end + 1);
  response.writeHead(206, {
    ...headers,
    "accept-ranges": "bytes",
    "content-range": `bytes ${range.start}-${range.end}/${body.byteLength}`,
    "content-length": String(slice.byteLength),
  });
  response.end(slice);
}

async function record(name, scenario) {
  const responses = {};
  let origin = FIXTURE_ORIGIN;

  const server = createServer((request, response) => {
    const key = request.url ?? "/";
    const upstream = key.startsWith("/files/")
      ? decodeFileUrl(key)
      : `${scenario.index ?? UPSTREAM_INDEX}${key.replace(/^\/simple/, "")}`;

    const accept = request.headers.accept;
    fetch(upstream, { headers: accept ? { accept } : {} })
      .then(async (upstreamResponse) => {
        const raw = Buffer.from(await upstreamResponse.arrayBuffer());
        const contentType = upstreamResponse.headers.get("content-type") ?? "";
        const { stored, served, rewrite } = rewriteFileUrls(raw, contentType, origin);
        const headers = { "content-type": contentType };
        for (const header of ["etag", "last-modified", "x-pypi-last-serial"]) {
          const value = upstreamResponse.headers.get(header);
          if (value) {
            headers[header] = value;
          }
        }
        responses[key] = {
          status: upstreamResponse.status,
          headers,
          gzip: true,
          body: gzipSync(stored, { level: 9 }).toString("base64"),
          ...(rewrite ? { rewrite: true } : {}),
        };
        respond(response, request.headers.range, upstreamResponse.status, headers, served);
      })
      .catch((error) => {
        console.error(`  upstream failed for ${key}: ${error.message}`);
        response.writeHead(502).end();
      });
  });

  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address();
  origin = `http://127.0.0.1:${port}`;

  const requirements = `${scenario.requirements.join("\n")}\n`;
  const workspace = mkdtempSync(join(tmpdir(), `uv-wasm-record-${name}-`));
  writeFileSync(join(workspace, "requirements.in"), requirements);

  const args = [
    "pip",
    "compile",
    "requirements.in",
    ...(scenario.excludeNewer === false ? [] : ["--exclude-newer", EXCLUDE_NEWER]),
    "--no-cache",
    "--no-header",
    ...scenario.extraArgs,
  ];
  const indexed = [...args, "--index-url", `${origin}/simple`];

  const native = await runNative([...indexed, "--directory", workspace]);
  rmSync(workspace, { recursive: true, force: true });
  if (native.status !== 0) {
    await new Promise((done) => server.close(done));
    throw new Error(`native uv failed for ${name}:\n${native.stderr}`);
  }
  const afterNative = Object.keys(responses).length;

  const browser = await runBrowser(name, requirements, indexed);
  await new Promise((done) => server.close(done));
  if (browser.status !== 0) {
    throw new Error(`the engine failed for ${name}:\n${browser.stderr}`);
  }
  const added = Object.keys(responses).length - afterNative;

  const outDir = resolve(root, "test/fixtures", name);
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "snapshot.json"),
    `${JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        requirements: scenario.requirements,
        args,
        responses,
      },
      null,
      2,
    )}\n`,
  );

  const bytes = Object.values(responses).reduce(
    (total, entry) => total + Buffer.from(entry.body, "base64").byteLength,
    0,
  );
  console.log(
    `${name}: ${Object.keys(responses).length} responses (${added} only the browser asked for), ${(bytes / 1024).toFixed(1)} KiB gzipped`,
  );
}

const wanted = process.argv.slice(2);
const selected = wanted.length > 0 ? wanted : Object.keys(scenarios);
for (const name of selected) {
  const scenario = scenarios[name];
  if (!scenario) {
    throw new Error(`unknown scenario: ${name}`);
  }
  await record(name, scenario);
}
