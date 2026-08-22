export interface ProxyTransport {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface FetchTransportOptions {
  fetch?: typeof globalThis.fetch;
  rewriteHead?: boolean;
}

export const FORBIDDEN_HEADERS: readonly string[] = [
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "via",
];

const forbidden = new Set(FORBIDDEN_HEADERS);

export function stripForbidden(headers: Headers): Headers {
  const kept = new Headers();
  headers.forEach((value, name) => {
    const lowered = name.toLowerCase();
    if (!forbidden.has(lowered) && !lowered.startsWith("proxy-") && !lowered.startsWith("sec-")) {
      kept.append(name, value);
    }
  });
  return kept;
}

const NO_BODY = new Set([101, 103, 204, 205, 304]);

const CONTENT_RANGE = /^bytes\s+(?:\d+-\d+|\*)\/(\d+)$/i;

export function totalFromContentRange(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const matched = CONTENT_RANGE.exec(value.trim());
  return matched?.[1] === undefined ? undefined : Number(matched[1]);
}

export function wasDecoded(headers: Headers): boolean {
  const encoding = headers.get("content-encoding");
  return encoding !== null && encoding.toLowerCase() !== "identity";
}

export function decodedHeaders(headers: Headers): Headers {
  const cleaned = new Headers(headers);
  if (wasDecoded(headers)) {
    cleaned.delete("content-encoding");
    cleaned.delete("content-length");
  }
  return cleaned;
}

function headResponse(probe: Response): Response {
  const headers = decodedHeaders(probe.headers);
  headers.delete("content-range");
  const total = totalFromContentRange(probe.headers.get("content-range"));
  if (total === undefined) {
    headers.delete("content-length");
  } else {
    headers.set("content-length", String(total));
  }
  if (probe.headers.get("accept-ranges") === null) {
    headers.set("accept-ranges", "bytes");
  }
  return new Response(null, {
    status: 200,
    statusText: "OK",
    headers,
  });
}

export function createFetchTransport(options: FetchTransportOptions = {}): ProxyTransport {
  const underlying = options.fetch ?? globalThis.fetch.bind(globalThis);
  const rewriteHead = options.rewriteHead ?? true;

  return {
    async fetch(input: string, init: RequestInit = {}): Promise<Response> {
      const headers = stripForbidden(new Headers(init.headers));
      const method = (init.method ?? "GET").toUpperCase();

      if (method === "HEAD" && rewriteHead) {
        const probing = new Headers(headers);
        probing.set("range", "bytes=0-0");
        const probe = await underlying(input, { ...init, method: "GET", headers: probing });
        if (probe.status === 206) {
          await probe.body?.cancel();
          return headResponse(probe);
        }
        if (probe.ok) {
          const body = await probe.arrayBuffer();
          const settled = decodedHeaders(probe.headers);
          settled.set("content-length", String(body.byteLength));
          return new Response(null, {
            status: probe.status,
            statusText: probe.statusText,
            headers: settled,
          });
        }
        return new Response(null, {
          status: probe.status,
          statusText: probe.statusText,
          headers: decodedHeaders(probe.headers),
        });
      }

      const response = await underlying(input, { ...init, method, headers });
      if (!wasDecoded(response.headers)) {
        return response;
      }
      return new Response(NO_BODY.has(response.status) ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: decodedHeaders(response.headers),
      });
    },
  };
}
