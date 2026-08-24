import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { HookVfs, RuntimeHookRequest } from "@tholus/core";
import { beforeAll, describe, expect, it } from "vitest";

import { jsPath, PROGRAM, wasmPath } from "./cli-goldens.js";

const canRun = existsSync(wasmPath) && existsSync(jsPath);

if (process.env.CI && !canRun) {
  throw new Error(
    "the runtime-refusal gate cannot run: the engine artifact is missing. Skipping here would " +
      "report phase 5's `no-adapter error exact` criterion as green while never asking uv.",
  );
}

const SOURCE = "/work/demo";

const PYPROJECT = `[build-system]
requires = []
build-backend = "demo_backend"
backend-path = ["."]

[project]
name = "demo"
version = "0.1.0"
`;

interface EngineInstance extends HookVfs {
  fsWrite(path: string, contents: Uint8Array): void;
  clearStdin(): void;
  hasRuntime(): boolean;
  attachRuntime(
    run: (request: RuntimeHookRequest) => Promise<{
      stdout: string[];
      stderr: string[];
      code: number;
    }>,
  ): void;
  detachRuntime(): void;
  cancel(): boolean;
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
}

describe.skipIf(!canRun)("a build without a runtime, and a build cut short", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let makeEngine: () => EngineInstance;

  const seeded = (): EngineInstance => {
    const engine = makeEngine();
    engine.clearStdin();
    engine.fsWrite(`${SOURCE}/pyproject.toml`, encoder.encode(PYPROJECT));
    engine.fsWrite(
      `${SOURCE}/demo_backend.py`,
      encoder.encode("def build_wheel(*args, **kwargs):\n    return 'demo.whl'\n"),
    );
    return engine;
  };

  const install = async (engine: EngineInstance): Promise<{ code: number; log: string }> => {
    let log = "";
    const code = await engine.invoke(
      [PROGRAM, "pip", "install", "--no-index", "--target", "/out", SOURCE],
      (_stream, data) => {
        log += decoder.decode(data);
      },
    );
    return { code, log };
  };

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as {
      default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
      Engine: new () => EngineInstance;
    };
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    makeEngine = () => new mod.Engine();
  }, 600_000);

  it("refuses in uv's own voice when no runtime is attached, rather than crashing", async () => {
    const engine = seeded();
    expect(engine.hasRuntime()).toBe(false);

    const { code, log } = await install(engine);

    expect(code, "a refused build is a failed command, not a crash").toBe(1);
    expect(log).toContain("Failed to build `demo @ file:///work/demo`");
    expect(log.replace(/\s+/g, " ")).toContain(
      "Building a source distribution requires a Python runtime, and none is attached to the engine",
    );
    expect(log, "uv should own the message; a panic would name a rust location").not.toContain(
      "panicked",
    );
  });

  it("refuses again after a runtime is detached, so detaching really detaches", async () => {
    const engine = seeded();
    engine.attachRuntime(async () => ({ stdout: [], stderr: [], code: 0 }));
    expect(engine.hasRuntime()).toBe(true);
    engine.detachRuntime();
    expect(engine.hasRuntime()).toBe(false);

    const { code, log } = await install(engine);
    expect(code).toBe(1);
    expect(log).toContain("requires a Python runtime");
  });

  it("attributes a runtime that ran and failed to the backend, not to uv", async () => {
    const engine = seeded();
    engine.attachRuntime(async () => {
      throw new Error("the backend exploded");
    });

    const { code, log } = await install(engine);
    expect(code).toBe(1);
    expect(log.replace(/\s+/g, " ")).toContain(
      "The attached Python runtime could not run the build backend: the backend exploded",
    );
    expect(
      log,
      "a runtime that ran and failed is a build failure, never a missing-runtime one",
    ).not.toContain("requires a Python runtime");
  });

  it("comes back cleanly when the build is cancelled while a hook is in flight", async () => {
    const engine = seeded();
    let entered: () => void = () => {};
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });

    engine.attachRuntime(() => {
      entered();
      return new Promise(() => {});
    });

    let log = "";
    const running = engine.invoke(
      [PROGRAM, "pip", "install", "--no-index", "--target", "/out", SOURCE],
      (_stream, data) => {
        log += decoder.decode(data);
      },
    );

    await reached;
    expect(engine.cancel(), "cancel should find a running invocation").toBe(true);

    const code = await running;
    expect(code, "a cancelled command exits 130, the same as a native ^C").toBe(130);
    expect(log).not.toContain("panicked");
  });
});
