import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
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
  close: () => Promise<void>;
}

export interface ReplayOptions {
  failFirst?: number;
}

const NOT_RECORDED = 599;
const SERVICE_UNAVAILABLE = 503;

export async function startReplayServer(
  snapshotDir: string,
  options: ReplayOptions = {},
): Promise<ReplayServer> {
  const snapshot = JSON.parse(
    await readFile(resolve(snapshotDir, "snapshot.json"), "utf8"),
  ) as Snapshot;

  const requested: string[] = [];
  const misses: string[] = [];
  const rejected: string[] = [];
  const failures = new Map<string, number>();
  const failFirst = options.failFirst ?? 0;
  let origin = FIXTURE_ORIGIN;

  const server: Server = createServer((request, response) => {
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
    const encoded = Buffer.from(recorded.body, "base64");
    const raw = recorded.gzip ? gunzipSync(encoded) : encoded;
    const body = recorded.rewrite
      ? Buffer.from(raw.toString("utf8").split(FIXTURE_ORIGIN).join(origin), "utf8")
      : raw;
    response.writeHead(recorded.status, {
      ...recorded.headers,
      "content-length": String(body.byteLength),
    });
    response.end(body);
  });

  await new Promise<void>((ready) => {
    server.listen(0, "127.0.0.1", ready);
  });
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    requested,
    misses,
    rejected,
    close: () =>
      new Promise<void>((done, fail) => {
        server.close((error) => (error ? fail(error) : done()));
      }),
  };
}
