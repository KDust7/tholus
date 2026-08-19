import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@uv-wasm/engine-protocol";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const assets = resolve(root, "packages/core/assets");
const dist = resolve(root, "packages/core/dist");
const wasmPath = resolve(assets, "engine_bg.wasm");
const enginePath = resolve(assets, "engine.js");
const workerPath = resolve(dist, "worker.js");
const isBuilt = [wasmPath, enginePath, workerPath].every((path) => existsSync(path));

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>uv-wasm worker</title>
<script type="module">
const worker = new Worker("/dist/worker.js", { type: "module" });
globalThis.__failure = undefined;
worker.addEventListener("error", (event) => {
  globalThis.__failure = event.message ?? "worker failed to load";
});
globalThis.__send = (message) => worker.postMessage(message);
globalThis.__seen = [];
worker.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "output") {
    message.data = Array.from(message.data);
  }
  globalThis.__seen.push(message);
});
</script>`;

interface WorkerWindow {
  __failure: string | undefined;
  __send: (message: unknown) => void;
  __seen: { type: string; [key: string]: unknown }[];
}

async function launchChromium(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (error) {
    if (!String(error).includes("Executable doesn't exist")) {
      throw error;
    }
    return await chromium.launch({ channel: "chrome" });
  }
}

describe.skipIf(!isBuilt)("a real browser Worker drives the engine", () => {
  let server: Server;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    const files = new Map<string, [string, Buffer]>([
      ["/dist/worker.js", ["text/javascript", await readFile(workerPath)]],
      ["/assets/engine.js", ["text/javascript", await readFile(enginePath)]],
      ["/assets/engine_bg.wasm", ["application/wasm", await readFile(wasmPath)]],
    ]);
    server = createServer((request, response) => {
      const file = files.get(request.url ?? "");
      if (file) {
        response.writeHead(200, { "content-type": file[0] }).end(file[1]);
        return;
      }
      response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    browser = await launchChromium();
    page = await browser.newPage();
    await page.goto(`${origin}/index.html`);
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => server?.close(() => done()));
  }, 60_000);

  async function drain(until: string, timeoutMs: number): Promise<Record<string, unknown>[]> {
    return page.evaluate(
      async ([type, budget]) => {
        const scope = globalThis as unknown as WorkerWindow;
        const deadline = Date.now() + (budget as number);
        while (Date.now() < deadline) {
          if (scope.__failure !== undefined) {
            throw new Error(scope.__failure);
          }
          if (scope.__seen.some((message) => message.type === type)) {
            return scope.__seen.splice(0, scope.__seen.length) as Record<string, unknown>[];
          }
          await new Promise((done) => setTimeout(done, 50));
        }
        throw new Error(`timed out waiting for ${type}; saw ${JSON.stringify(scope.__seen)}`);
      },
      [until, timeoutMs] as const,
    );
  }

  it("loads the bundled worker without an import map", async () => {
    const failure = await page.evaluate(
      () => (globalThis as unknown as WorkerWindow).__failure ?? null,
    );
    expect(failure).toBeNull();
  });

  it("completes the handshake and reports boot progress", async () => {
    await page.evaluate(
      ([version]) =>
        (globalThis as unknown as WorkerWindow).__send({
          type: "init",
          id: "init-1",
          protocolVersion: version,
          config: {},
        }),
      [PROTOCOL_VERSION] as const,
    );

    const seen = await drain("initResult", 180_000);
    expect(seen.filter((message) => message.type === "bootProgress")).toHaveLength(4);
    const result = seen.find((message) => message.type === "initResult");
    expect(result?.outcome).toMatchObject({ ok: true });
  }, 240_000);

  it("runs uv through the worker and resolves the wasm by relative url", async () => {
    await page.evaluate(() =>
      (globalThis as unknown as WorkerWindow).__send({
        type: "exec",
        invocationId: "inv-1",
        argv: ["uv", "--version"],
        stdin: false,
      }),
    );

    const seen = await drain("exit", 120_000);
    const exit = seen.find((message) => message.type === "exit");
    expect(exit).toMatchObject({ code: 0, cancelled: false });

    const stdout = seen
      .filter((message) => message.type === "output" && message.stream === "stdout")
      .flatMap((message) => message.data as number[]);
    expect(Buffer.from(stdout).toString("utf8")).toContain("uv 0.12.3");
  }, 180_000);
});
