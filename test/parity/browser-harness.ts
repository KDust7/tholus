import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve } from "node:path";
import { type Browser, type BrowserType, chromium, firefox, webkit } from "playwright";

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
};

export function contentTypeOf(path: string): string {
  return TYPES[extname(path)] ?? "application/octet-stream";
}

const ENGINES: Record<string, BrowserType> = { chromium, firefox, webkit };

export function chosenBrowser(): string {
  const named = process.env["UV_WASM_BROWSER"] ?? "chromium";
  if (!(named in ENGINES)) {
    throw new Error(
      `UV_WASM_BROWSER is \`${named}\`, which is not one of ${Object.keys(ENGINES).join(", ")}`,
    );
  }
  return named;
}

export async function launchBrowser(): Promise<Browser> {
  const named = chosenBrowser();
  const engine = ENGINES[named] as BrowserType;
  try {
    return await engine.launch();
  } catch (error) {
    if (named !== "chromium" || !String(error).includes("Executable doesn't exist")) {
      throw error;
    }
    return await chromium.launch({ channel: "chrome" });
  }
}

export type Fallback = (request: IncomingMessage, response: ServerResponse) => boolean;

export interface StaticSite {
  server: Server;
  origin: string;
  close(): Promise<void>;
}

export interface DirectoryMount {
  prefix: string;
  directory: string;
}

export async function serveStatic(
  files: Map<string, string>,
  fallback?: Fallback,
  mounts: readonly DirectoryMount[] = [],
): Promise<StaticSite> {
  const cache = new Map<string, Buffer>();
  const server = createServer((request, response) => {
    const url = (request.url ?? "").split("?")[0] ?? "";
    let path = files.get(url);
    if (path === undefined) {
      const mount = mounts.find((candidate) => url.startsWith(candidate.prefix));
      if (mount && !url.slice(mount.prefix.length).includes("..")) {
        path = resolve(mount.directory, url.slice(mount.prefix.length));
      }
    }
    if (path === undefined) {
      if (fallback?.(request, response)) {
        return;
      }
      response.writeHead(404).end();
      return;
    }
    const cached = cache.get(path);
    if (cached) {
      response.writeHead(200, { "content-type": contentTypeOf(path) }).end(cached);
      return;
    }
    readFile(path).then(
      (bytes) => {
        cache.set(path, bytes);
        response.writeHead(200, { "content-type": contentTypeOf(path) }).end(bytes);
      },
      () => response.writeHead(404).end(),
    );
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

export function testbedFiles(root: string): Map<string, string> {
  return new Map<string, string>([
    ["/", resolve(root, "apps/testbed/index.html")],
    ["/index.html", resolve(root, "apps/testbed/index.html")],
    ["/testbed/main.js", resolve(root, "apps/testbed/dist/main.js")],
    ["/dist/worker.js", resolve(root, "packages/core/dist/worker.js")],
    ["/assets/engine.js", resolve(root, "packages/core/assets/engine.js")],
    ["/assets/engine_bg.wasm", resolve(root, "packages/core/assets/engine_bg.wasm")],
  ]);
}
