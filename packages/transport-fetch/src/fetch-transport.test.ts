import { describe, expect, it } from "vitest";
import {
  createFetchTransport,
  decodedHeaders,
  stripForbidden,
  totalFromContentRange,
  wasDecoded,
} from "./fetch-transport.js";

interface Seen {
  url: string;
  method: string;
  headers: Headers;
}

function recorder(reply: (seen: Seen) => Response): {
  fetch: typeof globalThis.fetch;
  calls: Seen[];
} {
  const calls: Seen[] = [];
  const fetch = (async (input: string | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const seen: Seen = {
      url: request.url,
      method: request.method,
      headers: request.headers,
    };
    calls.push(seen);
    return reply(seen);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("uv calls fetch the way reqwest does: one Request, no init", () => {
  it("keeps the method and headers of a Request handed over on its own", async () => {
    const { fetch, calls } = recorder(() => new Response("ok"));
    const transport = createFetchTransport({ fetch, rewriteHead: false });

    await transport.fetch(
      new Request("https://files.example/a.whl", {
        method: "HEAD",
        headers: { accept: "application/vnd.pypi.simple.v1+json" },
      }),
    );

    expect(
      calls[0]?.method,
      "reqwest's wasm client calls fetch(request); reading init instead turns every request into a GET",
    ).toBe("HEAD");
    expect(calls[0]?.headers.get("accept")).toBe("application/vnd.pypi.simple.v1+json");
  });

  it("still rewrites a Request-shaped HEAD when asked to", async () => {
    const { fetch, calls } = recorder(
      () => new Response("x", { status: 206, headers: { "content-range": "bytes 0-0/99" } }),
    );
    const transport = createFetchTransport({ fetch });

    const response = await transport.fetch(
      new Request("https://files.example/a.whl", { method: "HEAD" }),
    );

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.get("range")).toBe("bytes=0-0");
    expect(response.headers.get("content-length")).toBe("99");
  });
});

describe("headers a browser would refuse are dropped before the request is made", () => {
  it("keeps ordinary headers and drops the ones fetch forbids", () => {
    const kept = stripForbidden(
      new Headers({
        authorization: "Bearer x",
        "user-agent": "uv/0.12.3",
        host: "pypi.org",
        cookie: "session=1",
        accept: "application/vnd.pypi.simple.v1+json",
        "sec-fetch-mode": "cors",
      }),
    );
    expect([...kept.keys()].sort()).toEqual(["accept", "authorization"]);
  });
});

describe("a content-encoding the browser already undid must not be reported", () => {
  it("recognizes a body the platform decoded", () => {
    expect(wasDecoded(new Headers({ "content-encoding": "gzip" }))).toBe(true);
    expect(wasDecoded(new Headers({ "content-encoding": "identity" }))).toBe(false);
    expect(wasDecoded(new Headers())).toBe(false);
  });

  it("drops the stale encoding and the length that described the compressed bytes", () => {
    const cleaned = decodedHeaders(
      new Headers({ "content-encoding": "gzip", "content-length": "40", etag: "abc" }),
    );
    expect(cleaned.get("content-encoding")).toBeNull();
    expect(cleaned.get("content-length")).toBeNull();
    expect(cleaned.get("etag")).toBe("abc");
  });

  it("leaves an undecoded response completely alone", () => {
    const cleaned = decodedHeaders(new Headers({ "content-length": "40" }));
    expect(cleaned.get("content-length")).toBe("40");
  });
});

describe("a content-range names the size of the whole file", () => {
  it("reads the total off a range response", () => {
    expect(totalFromContentRange("bytes 0-0/12345")).toBe(12345);
    expect(totalFromContentRange("bytes */12345")).toBe(12345);
  });

  it("refuses a range whose total is unknown", () => {
    expect(totalFromContentRange("bytes 0-0/*")).toBeUndefined();
    expect(totalFromContentRange(null)).toBeUndefined();
    expect(totalFromContentRange("nonsense")).toBeUndefined();
  });
});

describe("HEAD becomes a one-byte GET, because CORS preflight often refuses HEAD", () => {
  it("asks for a single byte and reports the size the range disclosed", async () => {
    const { fetch, calls } = recorder(
      () =>
        new Response("x", {
          status: 206,
          headers: { "content-range": "bytes 0-0/98765", "content-length": "1" },
        }),
    );
    const transport = createFetchTransport({ fetch });
    const response = await transport.fetch("https://files.example/a.whl", { method: "HEAD" });

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.get("range")).toBe("bytes=0-0");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("98765");
    expect(
      response.headers.get("content-range"),
      "a synthesized HEAD must not claim to be a partial response",
    ).toBeNull();
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(await response.text()).toBe("");
  });

  it("measures the body itself when the server ignores the range", async () => {
    const { fetch } = recorder(() => new Response("0123456789", { status: 200 }));
    const transport = createFetchTransport({ fetch });
    const response = await transport.fetch("https://files.example/a.whl", { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("10");
    expect(await response.text()).toBe("");
  });

  it("passes a failure through rather than inventing a size", async () => {
    const { fetch } = recorder(() => new Response("nope", { status: 404 }));
    const transport = createFetchTransport({ fetch });
    const response = await transport.fetch("https://files.example/a.whl", { method: "HEAD" });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-length")).toBeNull();
  });

  it("can be told to leave HEAD alone, for a transport that supports it", async () => {
    const { fetch, calls } = recorder(() => new Response(null, { status: 200 }));
    const transport = createFetchTransport({ fetch, rewriteHead: false });
    await transport.fetch("https://files.example/a.whl", { method: "HEAD" });
    expect(calls[0]?.method).toBe("HEAD");
  });
});

describe("a range request is uv's own, and passes through untouched", () => {
  it("forwards the range and returns the partial response as it came", async () => {
    const { fetch, calls } = recorder(
      () =>
        new Response("PK", {
          status: 206,
          headers: { "content-range": "bytes 100-101/98765" },
        }),
    );
    const transport = createFetchTransport({ fetch });
    const response = await transport.fetch("https://files.example/a.whl", {
      headers: { range: "bytes=100-101" },
    });

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.get("range")).toBe("bytes=100-101");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 100-101/98765");
    expect(await response.text()).toBe("PK");
  });

  it("does not retry, because uv owns retry policy", async () => {
    const { fetch, calls } = recorder(() => new Response("", { status: 503 }));
    const transport = createFetchTransport({ fetch });
    const response = await transport.fetch("https://files.example/a.whl");

    expect(response.status).toBe(503);
    expect(calls.length, "one attempt, so uv's own backoff is the only one").toBe(1);
  });

  it("keeps a body streaming rather than buffering it to fix headers", async () => {
    const { fetch } = recorder(
      () => new Response("hello", { status: 200, headers: { "content-length": "5" } }),
    );
    const transport = createFetchTransport({ fetch });
    const response = await transport.fetch("https://files.example/a.whl");
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe("hello");
  });
});
