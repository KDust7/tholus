import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchBrowser } from "./browser-harness.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const assets = resolve(root, "packages/core/assets");
const wasmPath = resolve(assets, "engine_bg.wasm");
const jsPath = resolve(assets, "engine.js");
const isBuilt = existsSync(wasmPath) && existsSync(jsPath);
const nativePath = resolve(
  root,
  "vendor/uv/target/debug",
  process.platform === "win32" ? "uv.exe" : "uv",
);
const hasNative = existsSync(nativePath);
const PROGRAM = basename(nativePath);
const TARGET_TRIPLE = /\b[a-z0-9_]+(?:-[a-z0-9_]+){2,3}\)/;

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>uv-wasm engine</title>
<script type="module">
import init, { Engine, version, buildInfo } from "./engine.js";
globalThis.__ready = (async () => {
  await init({ module_or_path: new URL("./engine_bg.wasm", import.meta.url) });
  globalThis.__engine = new Engine();
  globalThis.__version = version();
  globalThis.__buildInfo = buildInfo();
})();
</script>`;

interface EngineWindow {
  __ready: Promise<void>;
  __engine: {
    invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  };
  __version: string;
}

interface Captured {
  code: number;
  stdout: number[];
  stderr: number[];
}

interface Output {
  code: number;
  stdout: string;
  stderr: string;
}

describe.skipIf(!isBuilt)("the engine runs in headless chromium", () => {
  let server: Server;
  let browser: Browser;
  let page: Page;
  let origin: string;

  beforeAll(async () => {
    const js = await readFile(jsPath);
    const wasm = await readFile(wasmPath);
    server = createServer((request, response) => {
      if (request.url === "/engine.js") {
        response.writeHead(200, { "content-type": "text/javascript" }).end(js);
      } else if (request.url === "/engine_bg.wasm") {
        response.writeHead(200, { "content-type": "application/wasm" }).end(wasm);
      } else {
        response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    browser = await launchBrowser();
    page = await browser.newPage();
    await page.goto(`${origin}/index.html`);
    await page.evaluate(() => (globalThis as unknown as EngineWindow).__ready);
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => server?.close(() => done()));
  }, 180_000);

  async function invoke(argv: string[]): Promise<Output> {
    const captured = await page.evaluate(async (args): Promise<Captured> => {
      const stdout: number[] = [];
      const stderr: number[] = [];
      const code = await (globalThis as unknown as EngineWindow).__engine.invoke(
        args,
        (stream, data) => {
          const sink = stream === "stdout" ? stdout : stderr;
          for (const byte of data) {
            sink.push(byte);
          }
        },
      );
      return { code, stdout, stderr };
    }, argv);
    return {
      code: captured.code,
      stdout: Buffer.from(captured.stdout).toString("utf8"),
      stderr: Buffer.from(captured.stderr).toString("utf8"),
    };
  }

  it("boots and reports the vendored uv version", async () => {
    const reported = await page.evaluate(() => (globalThis as unknown as EngineWindow).__version);
    expect(reported).toContain("uv 0.12.3");
  });

  it("prints --version to stdout naming the wasm target", async () => {
    const result = await invoke(["uv", "--version"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^uv \d+\.\d+\.\d+/);
    expect(result.stdout).toContain("wasm32-unknown-unknown");
  });

  it("prints --help to stdout", async () => {
    const result = await invoke(["uv", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: uv [OPTIONS] <COMMAND>");
  });

  it("prints a subcommand's help to stdout", async () => {
    const result = await invoke(["uv", "pip", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: uv pip");
  });

  it("sends a usage error to stderr with clap's exit code", async () => {
    const result = await invoke(["uv", "--nonesuch"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unexpected argument '--nonesuch'");
  });

  it("keeps uv's subcommand suggestions", async () => {
    const result = await invoke(["uv", "install"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("uv pip install");
  });

  describe.skipIf(!hasNative)("matches native uv byte for byte", () => {
    function native(args: string[]): Output {
      const result = spawnSync(nativePath, args, { encoding: "buffer" });
      return {
        code: result.status ?? -1,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
      };
    }

    it.each([["--help"], ["pip", "--help"], ["python", "--help"], ["--nonesuch"], ["install"]])(
      "`uv %s`",
      async (...args: string[]) => {
        const [there, here] = [native(args), await invoke([PROGRAM, ...args])];
        expect(here.stdout).toBe(there.stdout);
        expect(here.stderr).toBe(there.stderr);
        expect(here.code).toBe(there.code);
      },
      120_000,
    );

    it("`uv --version`, once the target triple is normalized", async () => {
      const [there, here] = [native(["--version"]), await invoke([PROGRAM, "--version"])];
      const strip = (text: string): string => text.replace(TARGET_TRIPLE, "<target>)");
      expect(strip(here.stdout)).toBe(strip(there.stdout));
      expect(here.stdout).toContain("wasm32-unknown-unknown");
      expect(here.code).toBe(there.code);
    });
  });
});
