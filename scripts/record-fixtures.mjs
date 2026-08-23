import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
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
  "pure-python": {
    requirements: ["idna==3.11"],
    extraArgs: [],
    variants: [
      { name: "no-annotate", args: ["--no-annotate"] },
      { name: "annotation-line", args: ["--annotation-style", "line"] },
      { name: "no-deps", args: ["--no-deps"] },
      { name: "quiet", args: ["--quiet"] },
      { name: "platform-linux", args: ["--python-platform", "linux"] },
    ],
  },
  markers: {
    requirements: ["idna==3.11; python_version >= '3.10'"],
    extraArgs: [],
    variants: [{ name: "no-annotate", args: ["--no-annotate"] }],
  },
  transitive: {
    requirements: ["requests==2.32.5"],
    extraArgs: [],
    variants: [
      { name: "no-annotate", args: ["--no-annotate"] },
      { name: "annotation-line", args: ["--annotation-style", "line"] },
      { name: "no-deps", args: ["--no-deps"] },
      { name: "generate-hashes", args: ["--generate-hashes"] },
      { name: "platform-linux", args: ["--python-platform", "linux"] },
      { name: "no-emit-idna", args: ["--no-emit-package", "idna"] },
    ],
  },
  extras: {
    requirements: ["requests[socks]==2.32.5"],
    extraArgs: [],
    variants: [
      { name: "strip-extras", args: ["--strip-extras"] },
      { name: "no-strip-extras", args: ["--no-strip-extras"] },
      { name: "no-annotate", args: ["--no-annotate"] },
      { name: "no-deps", args: ["--no-deps"] },
    ],
  },
  hashes: {
    requirements: ["idna==3.11"],
    extraArgs: ["--generate-hashes"],
    variants: [
      { name: "no-annotate", args: ["--no-annotate"] },
      { name: "platform-linux", args: ["--python-platform", "linux"] },
    ],
  },
  universal: {
    requirements: ["requests==2.32.5"],
    extraArgs: ["--universal"],
    variants: [
      { name: "no-annotate", args: ["--no-annotate"] },
      { name: "no-deps", args: ["--no-deps"] },
      { name: "emit-marker-expression", args: ["--emit-marker-expression"] },
    ],
  },
  stdin: {
    requirements: ["idna==3.11"],
    extraArgs: [],
    stdin: true,
    variants: [{ name: "no-annotate", args: ["--no-annotate"] }],
  },
  "pyodide-wheel": {
    requirements: ["msgpack==1.1.2"],
    extraArgs: ["--python-platform", "wasm32-pyodide2026", "--python-version", "3.14"],
    index: PYODIDE_INDEX,
    excludeNewer: false,
    variants: [
      { name: "no-annotate", args: ["--no-annotate"] },
      { name: "no-deps", args: ["--no-deps"] },
    ],
  },
  install: {
    requirements: ["idna==3.11"],
    extraArgs: [],
    command: "install",
    followUps: [
      ["pip", "list"],
      ["pip", "freeze"],
      ["pip", "show", "idna"],
      ["pip", "check"],
      ["pip", "uninstall", "idna"],
      ["pip", "list"],
    ],
  },
  sync: { requirements: ["idna==3.11"], extraArgs: [], command: "sync" },
  "install-transitive": {
    requirements: ["requests==2.32.3"],
    extraArgs: [],
    command: "install",
    followUps: [
      ["pip", "list"],
      ["pip", "freeze"],
      ["pip", "show", "requests"],
      ["pip", "check"],
      ["pip", "uninstall", "requests"],
      ["pip", "list"],
    ],
  },
  sdist: {
    requirements: ["idna==3.11"],
    extraArgs: ["--no-binary", "idna"],
    command: "install",
    target: true,
    runtime: true,
  },
  "sdist-setuptools": {
    requirements: ["zipp==3.23.0"],
    extraArgs: ["--no-binary", "zipp"],
    command: "install",
    target: true,
    runtime: true,
  },
  "sdist-hatchling": {
    requirements: ["attrs==25.4.0"],
    extraArgs: ["--no-binary", "attrs"],
    command: "install",
    target: true,
    runtime: true,
  },
  "install-pyodide": {
    requirements: ["msgpack==1.1.2"],
    extraArgs: ["--python-platform", "wasm32-pyodide2026", "--python-version", "3.14"],
    command: "install",
    target: true,
    index: PYODIDE_INDEX,
    excludeNewer: false,
  },
};

const NATIVE_PYTHON = "3.14";
const ENVIRONMENT = /^Using (?:C?Python) .*$/gm;
const LOCATION = /^Location: .*$/gm;

const hostFree = (text) =>
  text.replace(ENVIRONMENT, "Using Python <ENVIRONMENT>").replace(LOCATION, "Location: <LOCATION>");

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

let runtimePromise;

async function pyodideRuntime() {
  runtimePromise ??= (async () => {
    const core = await import(
      pathToFileURL(resolve(root, "packages/core/dist/index.js")).href
    );
    const adapter = await import(
      pathToFileURL(resolve(root, "packages/pyodide/dist/index.js")).href
    );
    const { loadPyodide } = await import(
      pathToFileURL(resolve(root, "test/parity/node_modules/pyodide/pyodide.mjs")).href
    );
    const pyodide = await loadPyodide();
    return { core, adapter, pyodide };
  })();
  return runtimePromise;
}

async function attachRuntime(engine) {
  const { core, adapter, pyodide } = await pyodideRuntime();
  const runtime = adapter.attachPyodide(
    { exportTree: async (path) => core.exportTree(engine, path) },
    pyodide,
  );
  engine.attachRuntime(async (request) => {
    const outcome = await runtime.hook({
      script: request.script,
      cwd: request.sourceTree,
      env: request.env,
      sitePackages: core.sitePackagesOf(engine, request.venv),
      trees: core.hookTrees(engine, request),
    });
    core.applyHookWrites(engine, outcome.writes);
    return { stdout: outcome.stdout, stderr: outcome.stderr, code: outcome.code };
  });
}

async function browserEngine(withRuntime = false) {
  enginePromise ??= loadEngine();
  const mod = await enginePromise;
  const engine = new mod.Engine();
  if (withRuntime) {
    await attachRuntime(engine);
  }
  return engine;
}

function invokeBrowser(engine, args) {
  const decoder = new TextDecoder();
  let stdout = "";
  let stderr = "";
  return engine
    .invoke(["uv", ...args], (stream, data) => {
      if (stream === "stdout") {
        stdout += decoder.decode(data);
      } else {
        stderr += decoder.decode(data);
      }
    })
    .then((status) => ({ status, stdout, stderr }));
}

async function runBrowser(name, requirements, args, stdin) {
  const engine = await browserEngine();
  const directory = `/record-${name}`;
  engine.fsMkdirp(directory);
  engine.fsWrite(`${directory}/requirements.in`, new TextEncoder().encode(requirements));
  if (stdin === undefined) {
    engine.clearStdin();
  } else {
    engine.setStdin(new TextEncoder().encode(stdin));
  }
  return invokeBrowser(engine, [...args, "--directory", directory]);
}

async function runBrowserInstall(name, args, intoTarget, requirements, withRuntime = false) {
  const engine = await browserEngine(withRuntime);
  const directory = `/record-${name}`;
  engine.clearStdin();
  engine.fsMkdirp(directory);
  engine.fsWrite(`${directory}/requirements.in`, new TextEncoder().encode(requirements));
  if (intoTarget) {
    return invokeBrowser(engine, [...args, "--target", `${directory}/target`]);
  }
  const venv = `${directory}/.venv`;
  const created = await invokeBrowser(engine, ["venv", venv, "--python", "/bin/python3"]);
  if (created.status !== 0) {
    throw new Error(`the engine could not create a venv for ${name}:\n${created.stderr}`);
  }
  return invokeBrowser(engine, [...args, "--python", venv, "--directory", directory]);
}

function runNative(args, stdin) {
  return new Promise((done, fail) => {
    const child = spawn(nativeUv, args, { encoding: "utf8" });
    child.stdin.end(stdin ?? "");
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

function nativeStamp() {
  const version = spawnSync(nativeUv, ["--version"], { encoding: "utf8" }).stdout ?? "";
  const commit = /\(([0-9a-f]{7,40}) /.exec(version);
  return commit ? commit[1] : version.trim();
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

  const syncing = scenario.command === "sync";
  const installing = scenario.command === "install" || syncing;
  const args = installing
    ? [
        "pip",
        syncing ? "sync" : "install",
        ...(syncing ? ["requirements.in"] : scenario.requirements),
        ...(scenario.excludeNewer === false ? [] : ["--exclude-newer", EXCLUDE_NEWER]),
        "--no-cache",
        ...scenario.extraArgs,
      ]
    : [
        "pip",
        "compile",
        scenario.stdin ? "-" : "requirements.in",
        ...(scenario.excludeNewer === false ? [] : ["--exclude-newer", EXCLUDE_NEWER]),
        "--no-cache",
        "--no-header",
        ...scenario.extraArgs,
      ];
  const indexed = [...args, "--index-url", `${origin}/simple`];

  const stdin = scenario.stdin ? requirements : undefined;
  let native;
  const followUps = [];
  const variants = [];
  if (installing && scenario.target) {
    native = await runNative([...indexed, "--target", join(workspace, "target")]);
  } else if (installing) {
    const venv = join(workspace, ".venv");
    const created = await runNative(["venv", venv, "--python", NATIVE_PYTHON]);
    if (created.status !== 0) {
      await new Promise((done) => server.close(done));
      throw new Error(`native uv could not create a venv for ${name}:\n${created.stderr}`);
    }
    native = await runNative([
      ...indexed,
      "--python",
      venv,
      ...(syncing ? ["--directory", workspace] : []),
    ]);
    for (const args of scenario.followUps ?? []) {
      const run = await runNative([...args, "--python", venv]);
      followUps.push({
        args,
        status: run.status,
        stdout: hostFree(run.stdout),
        stderr: hostFree(run.stderr),
      });
    }
  } else {
    native = await runNative([...indexed, "--directory", workspace], stdin);
  }
  if (native.status !== 0) {
    rmSync(workspace, { recursive: true, force: true });
    await new Promise((done) => server.close(done));
    throw new Error(`native uv failed for ${name}:\n${native.stderr}`);
  }
  for (const variant of scenario.variants ?? []) {
    const run = await runNative([...indexed, ...variant.args, "--directory", workspace], stdin);
    if (run.status !== 0) {
      rmSync(workspace, { recursive: true, force: true });
      await new Promise((done) => server.close(done));
      throw new Error(`native uv failed for ${name}/${variant.name}:\n${run.stderr}`);
    }
    if (run.stdout.trim().length === 0) {
      rmSync(workspace, { recursive: true, force: true });
      await new Promise((done) => server.close(done));
      throw new Error(
        `${name}/${variant.name} recorded nothing, so the golden would agree with anything`,
      );
    }
    variants.push({
      name: variant.name,
      args: variant.args,
      expected: run.stdout,
      expectedReport: hostFree(run.stderr),
    });
  }
  rmSync(workspace, { recursive: true, force: true });
  const afterNative = Object.keys(responses).length;

  const browser = installing
    ? await runBrowserInstall(
        name,
        indexed,
        scenario.target === true,
        requirements,
        scenario.runtime === true,
      )
    : await runBrowser(name, requirements, indexed, stdin);
  if (browser.status !== 0) {
    await new Promise((done) => server.close(done));
    throw new Error(`the engine failed for ${name}:\n${browser.stderr}`);
  }
  for (const variant of scenario.variants ?? []) {
    const run = await runBrowser(name, requirements, [...indexed, ...variant.args], stdin);
    if (run.status !== 0) {
      await new Promise((done) => server.close(done));
      throw new Error(`the engine failed for ${name}/${variant.name}:\n${run.stderr}`);
    }
  }
  await new Promise((done) => server.close(done));
  const added = Object.keys(responses).length - afterNative;

  const outDir = resolve(root, "test/fixtures", name);
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "snapshot.json"),
    `${JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        recordedFrom: nativeStamp(),
        requirements: scenario.requirements,
        args,
        ...(installing
          ? {
              command: "install",
              ...(scenario.target === true ? { target: true } : {}),
              ...(followUps.length > 0 ? { followUps } : {}),
              expectedReport: hostFree(native.stderr),
            }
          : {
              expected: native.stdout,
              expectedReport: hostFree(native.stderr),
              ...(variants.length > 0 ? { variants } : {}),
            }),
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
    `${name}: ${Object.keys(responses).length} responses (${added} only the browser asked for), ${(bytes / 1024).toFixed(1)} KiB gzipped${variants.length > 0 ? `, ${variants.length} variants` : ""}`,
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
