import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { jsPath, PROGRAM, wasmPath } from "./cli-goldens.js";

const hasEngine = existsSync(wasmPath) && existsSync(jsPath);

if (process.env.CI && !hasEngine) {
  throw new Error(
    "the process-global gate cannot run: the engine artifact is missing. " +
      "Skipping here would report a gate that never ran.",
  );
}

interface EngineInstance {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  fsMkdirp(path: string): void;
  clearStdin(): void;
}

interface EngineModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  Engine: new () => EngineInstance;
}

describe.skipIf(!hasEngine)("process globals survive an invocation that exits early", () => {
  let engine: EngineInstance;

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as EngineModule;
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    engine = new mod.Engine();
  }, 300_000);

  async function run(args: string[]): Promise<{ code: number; err: string }> {
    engine.clearStdin();
    let err = "";
    const decoder = new TextDecoder();
    const code = await engine.invoke([PROGRAM, ...args], (stream, data) => {
      if (stream !== "stdout") {
        err += decoder.decode(data);
      }
    });
    return { code, err };
  }

  it.each([["--help"], ["--version"], ["--nonesuch"]])(
    "still runs a real command after `uv %s`",
    async (...first: string[]) => {
      await run(first);

      const directory = `/globals-${first.join("-").replace(/[^a-z0-9-]/gi, "")}`;
      engine.fsMkdirp(directory);
      const created = await run(["venv", `${directory}/.venv`, "--python", "/bin/python3"]);

      expect(
        created.err,
        "the earlier invocation claimed the process-global initialization and never performed it",
      ).not.toContain("preview configuration has not been initialized");
      expect(created.code, created.err).toBe(0);
    },
    300_000,
  );

  it("initializes the globals only once across many real commands", async () => {
    engine.fsMkdirp("/globals-repeat");
    for (const index of [0, 1, 2]) {
      const created = await run(["venv", `/globals-repeat/${index}`, "--python", "/bin/python3"]);
      expect(created.code, created.err).toBe(0);
      expect(created.err, "a repeat invocation re-finalized a process-global").not.toContain(
        "already finalized",
      );
    }
  }, 300_000);
});
