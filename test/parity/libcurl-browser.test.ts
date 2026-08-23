import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { connect, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { launchBrowser } from "./browser-harness.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const transportPackage = resolve(root, "packages/transport-libcurl/package.json");
const transportDist = resolve(root, "packages/transport-libcurl/dist/index.js");

const libcurlDir = ((): string | undefined => {
  try {
    return dirname(createRequire(transportPackage).resolve("libcurl.js/libcurl.wasm"));
  } catch {
    return undefined;
  }
})();

const canRun = libcurlDir !== undefined && existsSync(transportDist);

if (process.env.CI && !canRun) {
  throw new Error(
    "the libcurl transport gate cannot run: `libcurl.js` or the built transport is missing. " +
      "Skipping here would leave the adapter tested only against its own fake, which agrees " +
      "with any equally wrong implementation.",
  );
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>uv-wasm libcurl transport</title>
<script type="module">
import { createLibcurlTransport } from "/transport/index.js";

globalThis.__run = async (origin, relayUrl) => {
  const transport = createLibcurlTransport({
    load: async () => {
      const { libcurl } = await import("/libcurl/libcurl.mjs");
      libcurl.transport = "wsproxy";
      return libcurl;
    },
    relayUrl,
    wasmUrl: "/libcurl/libcurl.wasm",
    userAgent: "uv/0.12.3 (+https://github.com/astral-sh/uv)",
  });
  try {
    const response = await transport.fetch(origin + "/echo", {
      headers: { accept: "application/json" },
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.text(),
    };
  } finally {
    await transport.dispose();
  }
};
</script>`;

interface RunResult {
  status: number;
  contentType: string | null;
  body: string;
}

interface LibcurlWindow {
  __run: (origin: string, relayUrl: string) => Promise<RunResult>;
}

function startOrigin(): Promise<{ server: Server; origin: string; port: number }> {
  const server = createServer((request, response) => {
    if (request.url === "/echo") {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          userAgent: request.headers["user-agent"] ?? null,
          accept: request.headers.accept ?? null,
          method: request.method,
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      done({ server, origin: `http://127.0.0.1:${port}`, port });
    });
  });
}

describe.skipIf(!canRun)(
  "the libcurl transport carries a real request through a relay, User-Agent and all",
  () => {
    let pageServer: Server;
    let relay: WebSocketServer;
    let originServer: Server;
    let browser: Browser;
    let page: Page;
    let result: RunResult;
    let dialled: string[];

    beforeAll(async () => {
      const origin = await startOrigin();
      originServer = origin.server;

      const files = new Map<string, [string, Buffer]>([
        ["/transport/index.js", ["text/javascript", await readFile(transportDist)]],
        [
          "/transport/libcurl-transport.js",
          [
            "text/javascript",
            await readFile(resolve(root, "packages/transport-libcurl/dist/libcurl-transport.js")),
          ],
        ],
        [
          "/libcurl/libcurl.mjs",
          ["text/javascript", await readFile(resolve(libcurlDir as string, "libcurl.mjs"))],
        ],
        [
          "/libcurl/libcurl.wasm",
          ["application/wasm", await readFile(resolve(libcurlDir as string, "libcurl.wasm"))],
        ],
      ]);

      pageServer = createServer((request, response) => {
        const file = files.get(request.url ?? "");
        if (file) {
          response.writeHead(200, { "content-type": file[0] }).end(file[1]);
          return;
        }
        response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
      });
      await new Promise<void>((done) => pageServer.listen(0, "127.0.0.1", done));
      const pagePort = (pageServer.address() as AddressInfo).port;

      dialled = [];
      relay = new WebSocketServer({ server: pageServer, path: undefined });
      relay.on("connection", (socket, request) => {
        const destination = (request.url ?? "").replace(/^\/ws\//, "");
        dialled.push(destination);
        const [host, port] = destination.split(":");
        const upstream: Socket = connect(Number(port), host);
        const pending: Buffer[] = [];
        let open = false;

        upstream.on("connect", () => {
          open = true;
          for (const chunk of pending) {
            upstream.write(chunk);
          }
          pending.length = 0;
        });
        upstream.on("data", (chunk: Buffer) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(chunk);
          }
        });
        upstream.on("close", () => socket.close());
        upstream.on("error", () => socket.close());

        socket.on("message", (data: Buffer) => {
          const chunk = Buffer.from(data);
          if (open) {
            upstream.write(chunk);
          } else {
            pending.push(chunk);
          }
        });
        socket.on("close", () => upstream.destroy());
      });

      browser = await launchBrowser();
      page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${pagePort}/index.html`);

      result = await page.evaluate(
        ([target, relayUrl]) => (globalThis as unknown as LibcurlWindow).__run(target, relayUrl),
        [origin.origin, `ws://127.0.0.1:${pagePort}/ws/`] as const,
      );
    }, 300_000);

    afterAll(async () => {
      await browser?.close();
      await new Promise<void>((done) => relay?.close(() => done()));
      await new Promise<void>((done) => pageServer?.close(() => done()));
      await new Promise<void>((done) => originServer?.close(() => done()));
    }, 180_000);

    it("completes a real HTTP request through the relay", () => {
      expect(result.status).toBe(200);
      expect(result.contentType).toBe("application/json");
    });

    it("dialled the origin through the relay rather than going direct", () => {
      expect(dialled).toHaveLength(1);
      expect(dialled[0]).toMatch(/^127\.0\.0\.1:\d+$/);
    });

    it("delivered the User-Agent the platform's own fetch silently drops", () => {
      const echoed = JSON.parse(result.body) as { userAgent: string | null; accept: string | null };
      expect(
        echoed.userAgent,
        "this is the whole reason the transport exists: a browser Request drops User-Agent",
      ).toBe("uv/0.12.3 (+https://github.com/astral-sh/uv)");
      expect(echoed.accept).toBe("application/json");
    });
  },
);
