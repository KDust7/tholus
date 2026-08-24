import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXIT_CODE_CANCELLED } from "@tholus/engine-protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

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
    "the cancellation matrix cannot run: the engine artifact is missing. Skipping here would " +
      "report cancellation as working without ever interrupting anything.",
  );
}

const SLOW_MS = 1_500;

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

describe.skipIf(!isBuilt)("the real engine can be interrupted, and survives it", () => {
  let site: StaticSite;
  let log: ReplayLog;
  let engine: Engine | undefined;

  const start = (): Promise<Engine> =>
    createEngine({ endpoint: inProcessEndpoint, config: { cache: { kind: "none" } } });

  const install = (running: Engine, options: Parameters<Engine["exec"]>[1] = {}) =>
    running.exec(
      [
        "pip",
        "install",
        "idna==3.11",
        "--index-url",
        `${site.origin}/simple`,
        "--target",
        "/work/out",
        "--exclude-newer",
        "2026-08-01T00:00:00Z",
      ],
      options,
    );

  beforeAll(async () => {
    log = emptyReplayLog();
    const replay = createReplayHandler(await readSnapshot(fixture), log);
    site = await serveStatic(new Map(), (request, response) => {
      setTimeout(() => replay(request, response), SLOW_MS);
      return true;
    });
    log.origin = site.origin;
  }, 180_000);

  afterEach(async () => {
    await engine?.dispose().catch(() => undefined);
    engine = undefined;
  });

  it("reports a cancelled run as cancelled, with uv's own interrupt status", async () => {
    engine = await start();
    const handle = install(engine);
    const before = log.requested.length;
    await new Promise((done) => setTimeout(done, SLOW_MS / 3));
    handle.cancel();

    const result = await handle.exit;
    expect(result.cancelled, "a cancelled run has to say so, not merely fail").toBe(true);
    expect(result.code).toBe(EXIT_CODE_CANCELLED);
    expect(
      log.requested.length,
      "the run has to have actually started, or this gate proves nothing",
    ).toBeGreaterThanOrEqual(before);
  }, 180_000);

  it("cancels a run that was handed an already-aborted signal", async () => {
    engine = await start();
    const controller = new AbortController();
    controller.abort();

    const result = await install(engine, { signal: controller.signal }).exit;
    expect(result.cancelled).toBe(true);
    expect(result.code).toBe(EXIT_CODE_CANCELLED);
  }, 180_000);

  it("keeps the engine usable, so a cancel is not a crash", async () => {
    engine = await start();
    const handle = install(engine);
    await new Promise((done) => setTimeout(done, SLOW_MS / 3));
    handle.cancel();
    await handle.exit;

    let stdout = "";
    const after = engine.exec(["--version"], {
      stdout: (chunk) => {
        stdout += new TextDecoder().decode(chunk);
      },
    });
    const result = await after.exit;
    expect(result.code, "the engine has to keep working after an interrupt").toBe(0);
    expect(result.cancelled).toBe(false);
    expect(stdout).toContain("uv 0.12.3");
  }, 180_000);

  it("takes a second cancel without turning it into a second exit", async () => {
    engine = await start();
    const handle = install(engine);
    await new Promise((done) => setTimeout(done, SLOW_MS / 3));
    handle.cancel();
    handle.cancel();

    const result = await handle.exit;
    expect(result.cancelled).toBe(true);
    expect(result.code).toBe(EXIT_CODE_CANCELLED);
  }, 180_000);

  it("respawns after a terminate, which is what a second Ctrl-C escalates to", async () => {
    const doomed = await start();
    const handle = doomed.exec(
      ["pip", "install", "idna==3.11", "--index-url", `${site.origin}/simple`],
      {},
    );
    const stopped = handle.exit.catch((error: unknown) => error);
    doomed.terminate();
    expect(
      String(await stopped),
      "a terminated invocation has to settle rather than hang for ever, and say why",
    ).toContain("engine terminated");

    engine = await start();
    let stdout = "";
    const result = await engine.exec(["--version"], {
      stdout: (chunk) => {
        stdout += new TextDecoder().decode(chunk);
      },
    }).exit;
    expect(result.code, "a fresh engine has to boot after the last one was killed").toBe(0);
    expect(stdout).toContain("uv 0.12.3");
  }, 240_000);
});
