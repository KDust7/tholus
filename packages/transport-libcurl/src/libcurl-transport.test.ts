import { describe, expect, it, vi } from "vitest";

import {
  assertLibcurlShape,
  assertRelayUrl,
  createLibcurlTransport,
  DEFAULT_CONNECTION_CACHE,
  DEFAULT_CONNECTIONS_PER_HOST,
  DEFAULT_MAX_CONNECTIONS,
  type LibcurlModule,
  type LibcurlSession,
  withUserAgent,
} from "./libcurl-transport.js";

const RELAY = "wss://relay.example/ws/";

interface Recorded {
  input: string;
  init: RequestInit;
}

interface Fake {
  module: LibcurlModule;
  loads: number;
  relays: string[];
  connections: number[][];
  requests: Recorded[];
  closed: number;
  wasmUrls: (string | undefined)[];
}

function fakeLibcurl(respond: () => Response = () => new Response("ok")): Fake {
  const fake: Fake = {
    loads: 0,
    relays: [],
    connections: [],
    requests: [],
    closed: 0,
    wasmUrls: [],
    module: undefined as unknown as LibcurlModule,
  };

  class Session implements LibcurlSession {
    fetch(input: string, init: RequestInit = {}): Promise<Response> {
      fake.requests.push({ input, init });
      return Promise.resolve(respond());
    }

    set_connections(total: number, cache: number, perHost: number): void {
      fake.connections.push([total, cache, perHost]);
    }

    close(): void {
      fake.closed += 1;
    }
  }

  fake.module = {
    set_websocket: (url: string) => {
      fake.relays.push(url);
    },
    load_wasm: (url?: string) => {
      fake.loads += 1;
      fake.wasmUrls.push(url);
      return Promise.resolve(undefined);
    },
    HTTPSession: Session,
  };
  return fake;
}

describe("a relay URL is checked before anything is loaded", () => {
  it("accepts ws and wss", () => {
    expect(() => assertRelayUrl("ws://localhost:6001/")).not.toThrow();
    expect(() => assertRelayUrl(RELAY)).not.toThrow();
  });

  it("refuses a scheme that is not a WebSocket", () => {
    expect(() => assertRelayUrl("https://relay.example/ws/")).toThrow(/ws: or wss:/);
  });

  it("refuses something that is not a URL at all", () => {
    expect(() => assertRelayUrl("relay.example")).toThrow(/is not a URL/);
  });

  it("refuses one with no trailing slash, because libcurl appends the destination to it", () => {
    expect(() => assertRelayUrl("wss://relay.example/ws")).toThrow(/trailing slash/);
  });

  it("refuses before the module is ever asked for", () => {
    const load = vi.fn();
    expect(() => createLibcurlTransport({ load, relayUrl: "http://relay.example" })).toThrow();
    expect(load).not.toHaveBeenCalled();
  });
});

describe("the module a host hands over is checked for the shape this adapter uses", () => {
  it("names every method it could not find", () => {
    expect(() => assertLibcurlShape({}, false)).toThrow(/set_websocket, HTTPSession/);
  });

  it("asks for load_wasm only when a wasm URL was given", () => {
    const withoutLoader = { set_websocket: () => {}, HTTPSession: class {} };
    expect(() => assertLibcurlShape(withoutLoader, false)).not.toThrow();
    expect(() => assertLibcurlShape(withoutLoader, true)).toThrow(/load_wasm/);
  });

  it("explains the mistake of returning the module namespace", () => {
    expect(() => assertLibcurlShape(null, false)).toThrow(/named export `libcurl`/);
  });
});

describe("the module is loaded lazily, once, and only when a request is made", () => {
  it("loads nothing until the first request", async () => {
    const fake = fakeLibcurl();
    const load = vi.fn(() => Promise.resolve(fake.module));
    const transport = createLibcurlTransport({ load, relayUrl: RELAY });

    expect(load).not.toHaveBeenCalled();
    await transport.fetch("https://example.invalid/");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("loads once even when requests race the first one", async () => {
    const fake = fakeLibcurl();
    const load = vi.fn(() => Promise.resolve(fake.module));
    const transport = createLibcurlTransport({ load, relayUrl: RELAY });

    await Promise.all([
      transport.fetch("https://example.invalid/a"),
      transport.fetch("https://example.invalid/b"),
      transport.fetch("https://example.invalid/c"),
    ]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(fake.connections).toHaveLength(1);
    expect(fake.requests).toHaveLength(3);
  });

  it("lets a later request retry after a load that failed", async () => {
    const fake = fakeLibcurl();
    const load = vi
      .fn<() => Promise<LibcurlModule>>()
      .mockRejectedValueOnce(new Error("relay unreachable"))
      .mockResolvedValue(fake.module);
    const transport = createLibcurlTransport({ load, relayUrl: RELAY });

    await expect(transport.fetch("https://example.invalid/")).rejects.toThrow("relay unreachable");
    await expect(transport.fetch("https://example.invalid/")).resolves.toBeInstanceOf(Response);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("the session is configured the way a package index wants it", () => {
  it("points libcurl at the relay before the first request goes out", async () => {
    const fake = fakeLibcurl();
    const transport = createLibcurlTransport({
      load: () => Promise.resolve(fake.module),
      relayUrl: RELAY,
    });

    await transport.fetch("https://example.invalid/");
    expect(fake.relays).toEqual([RELAY]);
  });

  it("raises the per-host connection limit above libcurl's default of six", async () => {
    const fake = fakeLibcurl();
    const transport = createLibcurlTransport({
      load: () => Promise.resolve(fake.module),
      relayUrl: RELAY,
    });

    await transport.fetch("https://example.invalid/");
    expect(fake.connections).toEqual([
      [DEFAULT_MAX_CONNECTIONS, DEFAULT_CONNECTION_CACHE, DEFAULT_CONNECTIONS_PER_HOST],
    ]);
  });

  it("lets a host choose its own limits", async () => {
    const fake = fakeLibcurl();
    const transport = createLibcurlTransport({
      load: () => Promise.resolve(fake.module),
      relayUrl: RELAY,
      maxConnections: 8,
      connectionCache: 4,
      connectionsPerHost: 2,
    });

    await transport.fetch("https://example.invalid/");
    expect(fake.connections).toEqual([[8, 4, 2]]);
  });

  it("loads the wasm from the URL the host named, and skips it otherwise", async () => {
    const named = fakeLibcurl();
    await createLibcurlTransport({
      load: () => Promise.resolve(named.module),
      relayUrl: RELAY,
      wasmUrl: "https://cdn.example/libcurl.wasm",
    }).fetch("https://example.invalid/");
    expect(named.wasmUrls).toEqual(["https://cdn.example/libcurl.wasm"]);

    const unnamed = fakeLibcurl();
    await createLibcurlTransport({
      load: () => Promise.resolve(unnamed.module),
      relayUrl: RELAY,
    }).fetch("https://example.invalid/");
    expect(unnamed.wasmUrls).toEqual([undefined]);
  });
});

describe("a real User-Agent is the reason to reach for this transport at all", () => {
  it("adds the one the host chose", () => {
    const carrying = withUserAgent(new Headers(), "uv/0.12.3");
    expect(carrying.get("user-agent")).toBe("uv/0.12.3");
  });

  it("never overwrites a User-Agent the request already carries", () => {
    const carrying = withUserAgent(new Headers({ "user-agent": "uv/0.12.3" }), "something-else");
    expect(carrying.get("user-agent")).toBe("uv/0.12.3");
  });

  it("leaves the headers alone when the host named no User-Agent", () => {
    const carrying = withUserAgent(new Headers({ accept: "*/*" }), undefined);
    expect(carrying.get("user-agent")).toBeNull();
  });

  it("carries it through to the session, unlike the platform's fetch", async () => {
    const fake = fakeLibcurl();
    const transport = createLibcurlTransport({
      load: () => Promise.resolve(fake.module),
      relayUrl: RELAY,
      userAgent: "uv/0.12.3",
    });

    await transport.fetch("https://example.invalid/", { headers: { accept: "*/*" } });
    const sent = new Headers(fake.requests[0]?.init.headers);
    expect(sent.get("user-agent")).toBe("uv/0.12.3");
    expect(sent.get("accept")).toBe("*/*");
  });
});

describe("the method and body reach libcurl unchanged, because it needs no rewrites", () => {
  it("passes HEAD straight through rather than turning it into a ranged GET", async () => {
    const fake = fakeLibcurl();
    const transport = createLibcurlTransport({
      load: () => Promise.resolve(fake.module),
      relayUrl: RELAY,
    });

    await transport.fetch("https://example.invalid/x.whl", { method: "HEAD" });
    expect(fake.requests[0]?.init.method).toBe("HEAD");
    expect(new Headers(fake.requests[0]?.init.headers).get("range")).toBeNull();
  });

  it("passes a Range request through as written", async () => {
    const fake = fakeLibcurl();
    const transport = createLibcurlTransport({
      load: () => Promise.resolve(fake.module),
      relayUrl: RELAY,
    });

    await transport.fetch("https://example.invalid/x.whl", { headers: { range: "bytes=0-1023" } });
    expect(new Headers(fake.requests[0]?.init.headers).get("range")).toBe("bytes=0-1023");
  });

  it("returns what libcurl returned, without retrying, because uv owns retry policy", async () => {
    const fake = fakeLibcurl(() => new Response("nope", { status: 503 }));
    const transport = createLibcurlTransport({
      load: () => Promise.resolve(fake.module),
      relayUrl: RELAY,
    });

    const response = await transport.fetch("https://example.invalid/");
    expect(response.status).toBe(503);
    expect(fake.requests).toHaveLength(1);
  });
});

describe("the session is closed, because libcurl leaks it otherwise", () => {
  it("closes what it opened", async () => {
    const fake = fakeLibcurl();
    const transport = createLibcurlTransport({
      load: () => Promise.resolve(fake.module),
      relayUrl: RELAY,
    });

    await transport.fetch("https://example.invalid/");
    await transport.dispose();
    expect(fake.closed).toBe(1);
  });

  it("has nothing to close when no request was ever made", async () => {
    const fake = fakeLibcurl();
    const load = vi.fn(() => Promise.resolve(fake.module));
    await createLibcurlTransport({ load, relayUrl: RELAY }).dispose();
    expect(load).not.toHaveBeenCalled();
    expect(fake.closed).toBe(0);
  });

  it("opens again after being disposed", async () => {
    const fake = fakeLibcurl();
    const load = vi.fn(() => Promise.resolve(fake.module));
    const transport = createLibcurlTransport({ load, relayUrl: RELAY });

    await transport.fetch("https://example.invalid/");
    await transport.dispose();
    await transport.fetch("https://example.invalid/");

    expect(load).toHaveBeenCalledTimes(2);
    expect(fake.closed).toBe(1);
  });
});
