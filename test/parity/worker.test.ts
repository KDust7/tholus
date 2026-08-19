import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROTOCOL_VERSION, type WorkerMessage } from "@uv-wasm/engine-protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { createEngineWorker, type EngineExports } from "../../packages/core/src/engine-worker.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const assets = resolve(root, "packages/core/assets");
const jsPath = resolve(assets, "engine.js");
const isBuilt = existsSync(resolve(assets, "engine_bg.wasm")) && existsSync(jsPath);
const nativePath = resolve(
  root,
  "vendor/uv/target/debug",
  process.platform === "win32" ? "uv.exe" : "uv",
);
const PROGRAM = basename(nativePath);

interface Transcript {
  messages: WorkerMessage[];
  stdout: string;
  stderr: string;
  exit: Extract<WorkerMessage, { type: "exit" }> | undefined;
}

describe.skipIf(!isBuilt)("the worker drives the real engine over the protocol", () => {
  let emitted: WorkerMessage[];
  let worker: ReturnType<typeof createEngineWorker>;

  beforeAll(async () => {
    emitted = [];
    worker = createEngineWorker({
      load: async (): Promise<EngineExports> =>
        (await import(pathToFileURL(jsPath).href)) as EngineExports,
      wasm: () => readFile(resolve(assets, "engine_bg.wasm")),
      emit: (message) => emitted.push(message),
    });
    worker.receive({
      type: "init",
      id: "init-1",
      protocolVersion: PROTOCOL_VERSION,
      config: {},
    });
    await worker.settled;
  }, 180_000);

  async function exec(invocationId: string, args: string[]): Promise<Transcript> {
    const before = emitted.length;
    worker.receive({
      type: "exec",
      invocationId,
      argv: [PROGRAM, ...args],
    });
    await worker.settled;
    const messages = emitted.slice(before);
    const decode = (stream: "stdout" | "stderr"): string =>
      Buffer.concat(
        messages
          .filter((message) => message.type === "output" && message.stream === stream)
          .map((message) => Buffer.from((message as { data: Uint8Array }).data)),
      ).toString("utf8");
    return {
      messages,
      stdout: decode("stdout"),
      stderr: decode("stderr"),
      exit: messages.find((message) => message.type === "exit") as Transcript["exit"],
    };
  }

  it("boots and reports the vendored build identity", () => {
    const result = emitted.find((message) => message.type === "initResult");
    expect(result).toMatchObject({
      type: "initResult",
      id: "init-1",
      outcome: { ok: true, build: { uv: "0.12.3", protocol: PROTOCOL_VERSION } },
    });
  });

  it("announces boot progress before it is ready", () => {
    const phases = emitted
      .filter((message) => message.type === "bootProgress")
      .map((message) => (message as { phase: string }).phase);
    expect(phases).toEqual(["compile-start", "compile-done", "init-start", "ready"]);
  });

  it("delivers --help as sequenced output and a zero exit", async () => {
    const result = await exec("help-1", ["--help"]);
    expect(result.exit).toMatchObject({ invocationId: "help-1", code: 0, cancelled: false });
    expect(result.stdout).toContain("Usage: uv");
    expect(result.stderr).toBe("");

    const seqs = result.messages
      .filter((message) => message.type === "output")
      .map((message) => (message as { seq: number }).seq);
    expect(seqs).toEqual(seqs.map((_, index) => index));
  });

  it.skipIf(!existsSync(nativePath))("matches native uv through the protocol", async () => {
    const result = await exec("help-2", ["--help"]);
    const native = spawnSync(nativePath, ["--help"], { encoding: "buffer" });
    expect(result.stdout).toBe(native.stdout.toString("utf8"));
    expect(result.exit?.code).toBe(native.status ?? -1);
  });

  it("routes a usage error to stderr with the usage exit code", async () => {
    const result = await exec("bad-1", ["--nonesuch"]);
    expect(result.exit).toMatchObject({ code: 2, cancelled: false });
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unexpected argument '--nonesuch'");
  });

  it("reports a duration for each invocation", async () => {
    const result = await exec("version-1", ["--version"]);
    expect(result.exit?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
