import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";

export const FIXTURE_ORIGIN = "http://uv-wasm-fixture.invalid";

export interface RecordedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  gzip?: boolean;
  rewrite?: boolean;
}

export interface Snapshot {
  recordedAt: string;
  excludeNewer: string;
  responses: Record<string, RecordedResponse>;
}

export interface ReplayServer {
  origin: string;
  requested: readonly string[];
  misses: readonly string[];
  rejected: readonly string[];
  revalidated: readonly string[];
  close: () => Promise<void>;
}

export interface ReplayOptions {
  failFirst?: number;
}

const NOT_RECORDED = 599;
const SERVICE_UNAVAILABLE = 503;
const PARTIAL_CONTENT = 206;
const NOT_MODIFIED = 304;
const RANGE_NOT_SATISFIABLE = 416;

const BYTE_RANGE = /^bytes=(\d*)-(\d*)$/;

interface ByteRange {
  start: number;
  end: number;
}

export function parseByteRange(header: string | undefined, size: number): ByteRange | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = BYTE_RANGE.exec(header.trim());
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

export interface ReplayLog {
  requested: string[];
  misses: string[];
  rejected: string[];
  revalidated: string[];
  origin: string;
}

export function emptyReplayLog(): ReplayLog {
  return { requested: [], misses: [], rejected: [], revalidated: [], origin: FIXTURE_ORIGIN };
}

export async function readSnapshot(snapshotDir: string): Promise<Snapshot> {
  return JSON.parse(await readFile(resolve(snapshotDir, "snapshot.json"), "utf8")) as Snapshot;
}

export function createReplayHandler(
  snapshot: Snapshot,
  log: ReplayLog,
  options: ReplayOptions = {},
): (request: IncomingMessage, response: ServerResponse) => void {
  const { requested, misses, rejected, revalidated } = log;
  const failures = new Map<string, number>();
  const failFirst = options.failFirst ?? 0;

  return (request, response) => {
    const key = request.url ?? "/";
    requested.push(key);
    const recorded = snapshot.responses[key];
    if (!recorded) {
      misses.push(key);
      response.writeHead(NOT_RECORDED, { "content-type": "text/plain" });
      response.end(`no recorded response for ${key}`);
      return;
    }

    const failedSoFar = failures.get(key) ?? 0;
    if (failedSoFar < failFirst) {
      failures.set(key, failedSoFar + 1);
      rejected.push(key);
      response.writeHead(SERVICE_UNAVAILABLE, { "content-type": "text/plain" });
      response.end("the fixture is pretending to be unavailable");
      return;
    }
    const etag = recorded.headers.etag;
    if (etag !== undefined && request.headers["if-none-match"] === etag) {
      revalidated.push(key);
      response.writeHead(NOT_MODIFIED, { etag });
      response.end();
      return;
    }

    const encoded = Buffer.from(recorded.body, "base64");
    const raw = recorded.gzip ? gunzipSync(encoded) : encoded;
    const body = recorded.rewrite
      ? Buffer.from(raw.toString("utf8").split(FIXTURE_ORIGIN).join(log.origin), "utf8")
      : raw;
    const rangeHeader = request.headers.range;
    if (rangeHeader !== undefined && recorded.status === 200) {
      const range = parseByteRange(rangeHeader, body.byteLength);
      if (!range) {
        response.writeHead(RANGE_NOT_SATISFIABLE, {
          "content-range": `bytes */${body.byteLength}`,
        });
        response.end();
        return;
      }
      const slice = body.subarray(range.start, range.end + 1);
      response.writeHead(PARTIAL_CONTENT, {
        ...recorded.headers,
        "accept-ranges": "bytes",
        "content-range": `bytes ${range.start}-${range.end}/${body.byteLength}`,
        "content-length": String(slice.byteLength),
      });
      response.end(slice);
      return;
    }

    response.writeHead(recorded.status, {
      ...recorded.headers,
      "accept-ranges": "bytes",
      "content-length": String(body.byteLength),
    });
    response.end(body);
  };
}

export async function startReplayServer(
  snapshotDir: string,
  options: ReplayOptions = {},
): Promise<ReplayServer> {
  const log = emptyReplayLog();
  const handler = createReplayHandler(await readSnapshot(snapshotDir), log, options);
  const server: Server = createServer(handler);

  await new Promise<void>((ready) => {
    server.listen(0, "127.0.0.1", ready);
  });
  const { port } = server.address() as AddressInfo;
  log.origin = `http://127.0.0.1:${port}`;

  return {
    origin: log.origin,
    requested: log.requested,
    misses: log.misses,
    rejected: log.rejected,
    revalidated: log.revalidated,
    close: () =>
      new Promise<void>((done, fail) => {
        server.close((error) => (error ? fail(error) : done()));
      }),
  };
}
