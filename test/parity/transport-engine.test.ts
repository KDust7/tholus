import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import type { EngineEndpoint } from "../../packages/core/src/endpoint.js";
import { createEngine, type Engine } from "../../packages/core/src/engine.js";
import { createEngineWorker, type EngineExports } from "../../packages/core/src/engine-worker.js";
import { type StaticSite, serveStatic } from "./browser-harness.js";
import {
  createReplayHandler,
  emptyReplayLog,
  type ReplayLog,
  readSnapshot,
} from "./replay-server.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const assets = resolve(root, "packages/core/assets");
const jsPath = resolve(assets, "engine.js");
const wasmPath = resolve(assets, "engine_bg.wasm");
const fixture = resolve(root, "test/fixtures/install");
const isBuilt = existsSync(wasmPath) && existsSync(jsPath);

if (process.env.CI && !isBuilt) {
  throw new Error(
    "the transport gate cannot run: the engine artifact is missing. Skipping here would leave " +
      "the transports tested only by callers that use a different calling convention than uv does.",
  );
}

interface InstallSnapshot {
  args: string[];
}

function inProcessEndpoint(): EngineEndpoint {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const worker = createEngineWorker({
    load: async (): Promise<EngineExports> =>
      (await import(pathToFileURL(jsPath).href)) as EngineExports,
    wasm: () => readFile(wasmPath),
    emit: (message) => {
      for (const listener of [...listeners]) {
        listener({ data: message });
      }
    },
  });

  return {
    postMessage(message: unknown): void {
      worker.receive(message);
    },
    addEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
      listeners.add(listener);
    },
    removeEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
      listeners.delete(listener);
    },
    terminate(): void {
      listeners.clear();
    },
  };
}

describe.skipIf(!isBuilt)("uv reaches an index through the transport a host chose", () => {
  let site: StaticSite;
  let log: ReplayLog;
  let args: string[];
  let engine: Engine;
  let code: number;
  let stderr: string;
  const requests: { method: string; url: string; status: number }[] = [];

  beforeAll(async () => {
    const snapshot = await readSnapshot(fixture);
    args = (snapshot as unknown as InstallSnapshot).args;
    log = emptyReplayLog();
    const replay = createReplayHandler(snapshot, log);
    site = await serveStatic(new Map(), (request, response) => {
      replay(request, response);
      return true;
    });
    log.origin = site.origin;

    engine = await createEngine({
      endpoint: inProcessEndpoint,
      config: { cache: { kind: "none" }, transport: { kind: "fetch" } },
      onEvent: (event) => {
        if (event.type === "request") {
          requests.push({ method: event.method, url: event.url, status: event.status ?? 0 });
        }
      },
    });

    stderr = "";
    const handle = engine.exec(
      [...args, "--index-url", `${site.origin}/simple`, "--target", "/work/out"],
      {
        stderr: (chunk) => {
          stderr += new TextDecoder().decode(chunk);
        },
      },
    );
    code = (await handle.exit).code;
  }, 600_000);

  it("installs through the fetch transport, which uv calls with a Request", () => {
    expect(
      code,
      `the install failed through the transport:\n$stderr.split("\n").slice(-20).join("\n")`,
    ).toBe(0);
    expect(stderr).toContain("+ idna==3.11");
  });

  it("served every request from the fixture, so the transport did not mangle any of them", () => {
    expect(log.misses, `the replay server was asked for ${log.misses.join(", ")}`).toEqual([]);
    expect(log.requested.length).toBeGreaterThan(0);
  });

  it("reported each request as an event a host can render", () => {
    expect(requests.length, "a transported request has to be observable").toBeGreaterThan(0);
    for (const request of requests) {
      expect(
        typeof request.url,
        "a Request-shaped call must still report a string url, or the event fails validation",
      ).toBe("string");
      expect(request.url).toContain("127.0.0.1");
      expect(request.method).toMatch(/^[A-Z]+$/);
    }
  });
});
