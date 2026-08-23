import type { ProxyTransport } from "@uv-wasm/engine-protocol";

export type { ProxyTransport };

export interface LibcurlSession {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
  set_connections(total: number, cache: number, perHost: number): void;
  close(): void;
}

export interface LibcurlModule {
  set_websocket(url: string): void;
  load_wasm?(url?: string): Promise<unknown>;
  HTTPSession: new (options?: { enable_cookies?: boolean; proxy?: string }) => LibcurlSession;
}

export interface LibcurlTransportOptions {
  load: () => Promise<LibcurlModule>;
  relayUrl: string;
  wasmUrl?: string;
  userAgent?: string;
  maxConnections?: number;
  connectionCache?: number;
  connectionsPerHost?: number;
}

export interface LibcurlTransport extends ProxyTransport {
  dispose(): Promise<void>;
}

export const DEFAULT_MAX_CONNECTIONS = 60;
export const DEFAULT_CONNECTION_CACHE = 50;
export const DEFAULT_CONNECTIONS_PER_HOST = 16;

const RELAY_SCHEMES = ["ws:", "wss:"];

export function assertRelayUrl(relayUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(relayUrl);
  } catch {
    throw new Error(
      `the libcurl transport needs a WebSocket relay URL, and \`${relayUrl}\` is not a URL`,
    );
  }
  if (!RELAY_SCHEMES.includes(parsed.protocol)) {
    throw new Error(
      `the libcurl transport reaches the network through a Wisp relay, so its URL has to be ws: ` +
        `or wss:, not \`${parsed.protocol}\``,
    );
  }
  if (!relayUrl.endsWith("/")) {
    throw new Error(
      `libcurl appends the destination to the relay URL, so \`${relayUrl}\` has to end with a ` +
        "trailing slash",
    );
  }
}

export function assertLibcurlShape(module: unknown, wantsWasmUrl: boolean): LibcurlModule {
  const candidate = module as Partial<LibcurlModule> | null;
  const missing: string[] = [];
  if (typeof candidate?.set_websocket !== "function") {
    missing.push("set_websocket");
  }
  if (typeof candidate?.HTTPSession !== "function") {
    missing.push("HTTPSession");
  }
  if (wantsWasmUrl && typeof candidate?.load_wasm !== "function") {
    missing.push("load_wasm");
  }
  if (missing.length > 0) {
    throw new Error(
      `the module the host loaded is not libcurl.js: it has no ${missing.join(", ")}. ` +
        "libcurl.js exports its API as the named export `libcurl`, so a loader has to return " +
        "that object rather than the module namespace.",
    );
  }
  return candidate as LibcurlModule;
}

export function withUserAgent(headers: Headers, userAgent: string | undefined): Headers {
  if (userAgent === undefined || headers.has("user-agent")) {
    return headers;
  }
  const carrying = new Headers(headers);
  carrying.set("user-agent", userAgent);
  return carrying;
}

export function plainHeaders(headers: Headers): Record<string, string> {
  const plain: Record<string, string> = {};
  headers.forEach((value, name) => {
    plain[name] = value;
  });
  return plain;
}

export function requestOf(input: string | Request, init?: RequestInit): Request {
  if (init === undefined) {
    return input instanceof Request ? input : new Request(input);
  }
  return new Request(input as RequestInfo, init);
}

export function createLibcurlTransport(options: LibcurlTransportOptions): LibcurlTransport {
  assertRelayUrl(options.relayUrl);

  const perHost = options.connectionsPerHost ?? DEFAULT_CONNECTIONS_PER_HOST;
  const total = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const cache = options.connectionCache ?? DEFAULT_CONNECTION_CACHE;

  let opening: Promise<LibcurlSession> | undefined;

  const open = async (): Promise<LibcurlSession> => {
    const module = assertLibcurlShape(await options.load(), options.wasmUrl !== undefined);
    if (module.load_wasm !== undefined) {
      await module.load_wasm(options.wasmUrl);
    }
    module.set_websocket(options.relayUrl);
    const session = new module.HTTPSession();
    session.set_connections(total, cache, perHost);
    return session;
  };

  const ready = (): Promise<LibcurlSession> => {
    if (opening === undefined) {
      opening = open().catch((error: unknown) => {
        opening = undefined;
        throw error;
      });
    }
    return opening;
  };

  return {
    async fetch(input: string | Request, init?: RequestInit): Promise<Response> {
      const session = await ready();
      const request = requestOf(input, init);
      const carrying = withUserAgent(new Headers(request.headers), options.userAgent);
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer();
      return session.fetch(request.url, {
        method: request.method,
        headers: plainHeaders(carrying),
        ...(body === undefined ? {} : { body }),
      });
    },

    async dispose(): Promise<void> {
      const pending = opening;
      if (pending === undefined) {
        return;
      }
      opening = undefined;
      const session = await pending.catch(() => undefined);
      session?.close();
    },
  };
}
