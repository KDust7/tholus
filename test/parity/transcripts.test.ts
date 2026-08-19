import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type EngineEndpoint,
  loadTranscript,
  replayTranscript,
  transcriptNames,
} from "@uv-wasm/contract-transcripts";
import type { WorkerMessage } from "@uv-wasm/engine-protocol";
import { describe, expect, it } from "vitest";
import { createEngineWorker, type EngineExports } from "../../packages/core/src/engine-worker.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const assets = resolve(root, "packages/core/assets");
const jsPath = resolve(assets, "engine.js");
const isBuilt = existsSync(resolve(assets, "engine_bg.wasm")) && existsSync(jsPath);

const OUT_OF_REACH: Record<string, string> = {
  "exec-cancel": "asserts the mock's scripted progress line, and its pause is the mock's",
  "exec-progress-events": "engine emits no reporter events",
  "exec-resize-and-ack": "engine has no ack flow control, and the output is the mock's script",
  "exec-stdin-buffer": "asserts the mock's scripted compile output, not uv's",
  "exec-stdout-exit": "asserts the mock's scripted `pip list` output, not uv's",
  "exec-structured-error": "asserts the mock's scripted resolver error, not uv's",
};

function realEngineEndpoint(): EngineEndpoint {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const worker = createEngineWorker({
    load: async (): Promise<EngineExports> =>
      (await import(pathToFileURL(jsPath).href)) as EngineExports,
    wasm: () => readFile(resolve(assets, "engine_bg.wasm")),
    emit: (message: WorkerMessage) => {
      for (const listener of listeners) {
        listener({ data: message });
      }
    },
  });
  return {
    postMessage: (message: unknown) => worker.receive(message),
    addEventListener: (_type: "message", listener: (event: { data: unknown }) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: "message", listener: (event: { data: unknown }) => void) => {
      listeners.delete(listener);
    },
    terminate: () => {
      worker.receive({ type: "dispose" });
    },
  };
}

describe.skipIf(!isBuilt)("the real engine against the golden transcripts", () => {
  for (const name of transcriptNames()) {
    const reason = OUT_OF_REACH[name];
    if (reason !== undefined) {
      it.skip(`replays ${name}, out of reach: ${reason}`, () => {});
      continue;
    }
    it(`replays ${name}`, async () => {
      const result = await replayTranscript(realEngineEndpoint(), loadTranscript(name), {
        timeoutMs: 180_000,
      });
      expect(result.mismatches, JSON.stringify(result.mismatches, null, 2)).toEqual([]);
    }, 240_000);
  }
});
