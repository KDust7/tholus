import { createEngine, type Engine, type EngineConfigInput, type ExecOptions } from "@uv-wasm/core";
import type { EngineEvent } from "@uv-wasm/engine-protocol";

export interface TestbedResult {
  code: number;
  cancelled: boolean;
  stdout: string;
  stderr: string;
}

export interface TestbedFailure {
  failed: true;
  message: string;
}

export interface TestbedDriver {
  init(config?: EngineConfigInput): Promise<{ ok: boolean; build?: unknown; message?: string }>;
  exec(argv: string[], options?: Omit<ExecOptions, "stdout" | "stderr">): Promise<TestbedResult>;
  call(method: string, request?: unknown): Promise<unknown | TestbedFailure>;
  tree(path: string): Promise<string[] | TestbedFailure>;
  events(): EngineEvent[];
  dispose(): Promise<void>;
}

const decoder = new TextDecoder();
const seen: EngineEvent[] = [];
let engine: Engine | undefined;

const note = (text: string): void => {
  const state = document.querySelector("#state");
  const log = document.querySelector("#log");
  if (state) {
    state.textContent = text;
  }
  if (log) {
    log.textContent = `${log.textContent ?? ""}${text}\n`;
  }
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const running = (): Engine => {
  if (!engine) {
    throw new Error("the testbed engine has not been initialized");
  }
  return engine;
};

const driver: TestbedDriver = {
  async init(config: EngineConfigInput = {}) {
    seen.length = 0;
    try {
      engine = await createEngine({
        config,
        workerUrl: new URL("/dist/worker.js", location.origin),
        onEvent: (event) => {
          seen.push(event);
        },
      });
      note(`ready: ${engine.build.uv}`);
      return { ok: true, build: engine.build };
    } catch (error) {
      note(`failed: ${describe(error)}`);
      return { ok: false, message: describe(error) };
    }
  },

  async exec(argv, options = {}) {
    let stdout = "";
    let stderr = "";
    const handle = running().exec(argv, {
      ...options,
      stdout: (chunk) => {
        stdout += decoder.decode(chunk, { stream: true });
      },
      stderr: (chunk) => {
        stderr += decoder.decode(chunk, { stream: true });
      },
    });
    const result = await handle.exit;
    note(`${argv.join(" ")} -> ${result.code}`);
    return { code: result.code, cancelled: result.cancelled, stdout, stderr };
  },

  async call(method, request) {
    const [namespace, name] = method.split(".");
    const api = (running() as unknown as Record<string, Record<string, unknown>>)[namespace ?? ""];
    const call = api?.[name ?? ""];
    if (typeof call !== "function") {
      return { failed: true, message: `the testbed has no \`${method}\`` };
    }
    try {
      return (await (call as (input?: unknown) => Promise<unknown>).call(api, request)) ?? null;
    } catch (error) {
      return { failed: true, message: describe(error) };
    }
  },

  async tree(path) {
    try {
      const exported = await running().exportTree(path);
      return exported.entries.map((entry) => entry.path);
    } catch (error) {
      return { failed: true, message: describe(error) };
    }
  },

  events() {
    return seen.slice();
  },

  async dispose() {
    await engine?.dispose();
    engine = undefined;
    note("disposed");
  },
};

(globalThis as unknown as { __uv: TestbedDriver }).__uv = driver;
note("loaded");
