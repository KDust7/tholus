import { PROTOCOL_VERSION, type WorkerMessage } from "@uv-wasm/engine-protocol";
import { describe, expect, it } from "vitest";
import {
  createEngineWorker,
  type EngineExports,
  type EngineHandle,
  type EngineWorker,
} from "./engine-worker.js";

const encoder = new TextEncoder();

interface FakeOptions {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  throws?: string;
}

class FakeEngine implements EngineHandle {
  columns = 0;
  rows = 0;
  cleared = false;
  readonly environments: string[][] = [];

  constructor(private readonly options: FakeOptions) {}

  envReplace(entries: string[]): void {
    this.environments.push(entries);
  }

  async invoke(
    _argv: string[],
    onOutput: (stream: string, data: Uint8Array) => void,
  ): Promise<number> {
    if (this.options.throws) {
      throw new Error(this.options.throws);
    }
    if (this.options.stdout) {
      onOutput("stdout", encoder.encode(this.options.stdout));
    }
    if (this.options.stderr) {
      onOutput("stderr", encoder.encode(this.options.stderr));
    }
    return this.options.exitCode ?? 0;
  }

  setTermSize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
  }

  clearTerm(): void {
    this.cleared = true;
  }

  isRunning(): boolean {
    return false;
  }
}

interface Harness {
  worker: EngineWorker;
  emitted: WorkerMessage[];
  engines: FakeEngine[];
}

function harness(options: FakeOptions = {}): Harness {
  const emitted: WorkerMessage[] = [];
  const engines: FakeEngine[] = [];
  const exports = {
    default: async () => undefined,
    version: () => "uv-wasm 0.0.0 (uv 0.12.3)",
    buildInfo: () => `{"engine":"0.0.0","uv":"0.12.3","protocol":"${PROTOCOL_VERSION}"}`,
    Engine: class extends FakeEngine {
      constructor() {
        super(options);
        engines.push(this);
      }
    },
  } satisfies EngineExports;

  const worker = createEngineWorker({
    load: async () => exports,
    emit: (message) => emitted.push(message),
    now: () => 0,
  });
  return { worker, emitted, engines };
}

async function init(test: Harness, config: Record<string, unknown> = {}): Promise<void> {
  test.worker.receive({ type: "init", id: "i1", protocolVersion: PROTOCOL_VERSION, config });
  await test.worker.settled;
}

function typesOf(emitted: WorkerMessage[]): string[] {
  return emitted.map((message) => message.type);
}

describe("the engine worker speaks the host protocol", () => {
  it("reports the build identity after booting", async () => {
    const test = harness();
    await init(test);
    expect(typesOf(test.emitted)).toEqual([
      "bootProgress",
      "bootProgress",
      "bootProgress",
      "bootProgress",
      "initResult",
    ]);
    const result = test.emitted.at(-1);
    expect(result).toMatchObject({
      type: "initResult",
      id: "i1",
      outcome: { ok: true, build: { uv: "0.12.3", protocol: PROTOCOL_VERSION } },
    });
  });

  it("refuses a host that speaks a different protocol", async () => {
    const test = harness();
    test.worker.receive({ type: "init", id: "i1", protocolVersion: "99", config: {} });
    await test.worker.settled;
    expect(test.emitted).toEqual([
      {
        type: "initResult",
        id: "i1",
        outcome: {
          ok: false,
          error: {
            code: "protocol-mismatch",
            message: `engine speaks protocol ${PROTOCOL_VERSION}, host speaks 99`,
          },
        },
      },
    ]);
  });

  it("turns engine output into sequenced output messages and an exit", async () => {
    const test = harness({ stdout: "hello\n", stderr: "warn\n", exitCode: 2 });
    await init(test);
    test.emitted.length = 0;
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv", "--help"], stdin: false });
    await test.worker.settled;

    expect(test.emitted).toEqual([
      {
        type: "output",
        invocationId: "x1",
        stream: "stdout",
        seq: 0,
        data: encoder.encode("hello\n"),
      },
      {
        type: "output",
        invocationId: "x1",
        stream: "stderr",
        seq: 1,
        data: encoder.encode("warn\n"),
      },
      { type: "exit", invocationId: "x1", code: 2, cancelled: false, durationMs: 0 },
    ]);
  });

  it("refuses to exec before init rather than crashing", async () => {
    const test = harness();
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"], stdin: false });
    await test.worker.settled;
    expect(test.emitted).toEqual([
      {
        type: "exit",
        invocationId: "x1",
        code: 1,
        cancelled: false,
        durationMs: 0,
        error: { code: "unsupported", message: "the engine is not initialized; send `init` first" },
      },
    ]);
  });

  it("declines stdin, which this engine build cannot provide", async () => {
    const test = harness();
    await init(test);
    test.emitted.length = 0;
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"], stdin: true });
    await test.worker.settled;
    expect(test.emitted.at(-1)).toMatchObject({
      type: "exit",
      error: { code: "unsupported" },
    });
  });

  it("declares a terminal when the host attaches one", async () => {
    const test = harness();
    await init(test);
    test.worker.receive({
      type: "exec",
      invocationId: "x1",
      argv: ["uv"],
      stdin: false,
      tty: { cols: 120, rows: 40 },
    });
    await test.worker.settled;
    expect(test.engines[0]).toMatchObject({ columns: 120, rows: 40 });
  });

  it("clears the terminal when the host attaches none", async () => {
    const test = harness();
    await init(test);
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"], stdin: false });
    await test.worker.settled;
    expect(test.engines[0]?.cleared).toBe(true);
  });

  it("resizes an attached terminal", async () => {
    const test = harness();
    await init(test);
    test.worker.receive({ type: "resize", invocationId: "x1", size: { cols: 200, rows: 50 } });
    expect(test.engines[0]).toMatchObject({ columns: 200, rows: 50 });
  });

  it("never starts an invocation cancelled before it ran", async () => {
    const test = harness({ stdout: "partial" });
    await init(test);
    test.emitted.length = 0;
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"], stdin: false });
    test.worker.receive({ type: "cancel", invocationId: "x1" });
    await test.worker.settled;
    expect(test.emitted).toEqual([
      { type: "exit", invocationId: "x1", code: 130, cancelled: true, durationMs: 0 },
    ]);
  });

  it("cancels only the invocation it names", async () => {
    const test = harness({ stdout: "partial" });
    await init(test);
    test.emitted.length = 0;
    test.worker.receive({ type: "exec", invocationId: "a", argv: ["uv"], stdin: false });
    test.worker.receive({ type: "exec", invocationId: "b", argv: ["uv"], stdin: false });
    test.worker.receive({ type: "cancel", invocationId: "b" });
    await test.worker.settled;
    expect(test.emitted).toEqual([
      {
        type: "output",
        invocationId: "a",
        stream: "stdout",
        seq: 0,
        data: encoder.encode("partial"),
      },
      { type: "exit", invocationId: "a", code: 0, cancelled: false, durationMs: 0 },
      { type: "exit", invocationId: "b", code: 130, cancelled: true, durationMs: 0 },
    ]);
  });

  it("turns an engine crash into an exit and a fatal", async () => {
    const test = harness({ throws: "unreachable executed" });
    await init(test);
    test.emitted.length = 0;
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"], stdin: false });
    await test.worker.settled;
    expect(typesOf(test.emitted)).toEqual(["exit", "fatal"]);
    expect(test.emitted.at(-1)).toMatchObject({
      type: "fatal",
      message: "unreachable executed",
    });
  });

  it("serializes invocations rather than interleaving them", async () => {
    const test = harness({ stdout: "one" });
    await init(test);
    test.emitted.length = 0;
    test.worker.receive({ type: "exec", invocationId: "a", argv: ["uv"], stdin: false });
    test.worker.receive({ type: "exec", invocationId: "b", argv: ["uv"], stdin: false });
    await test.worker.settled;
    const order = test.emitted.map((message) =>
      "invocationId" in message ? message.invocationId : "",
    );
    expect(order).toEqual(["a", "a", "b", "b"]);
  });

  it("reports a malformed host message as fatal rather than throwing", () => {
    const test = harness();
    test.worker.receive({ type: "nonsense" });
    expect(test.emitted.at(-1)?.type).toBe("fatal");
  });

  it("goes silent after dispose", async () => {
    const test = harness();
    await init(test);
    test.worker.receive({ type: "dispose" });
    test.emitted.length = 0;
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"], stdin: false });
    await test.worker.settled;
    expect(test.emitted).toEqual([]);
  });
});

describe("the engine worker hands the environment to the engine", () => {
  it("installs the configured environment when it initializes", async () => {
    const test = harness();
    await init(test, { env: { HOME: "/home/browser" } });
    expect(test.engines[0]?.environments).toEqual([["HOME", "/home/browser"]]);
  });

  it("re-applies the configured environment for an invocation that names none", async () => {
    const test = harness();
    await init(test, { env: { HOME: "/home/browser" } });
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"], stdin: false });
    await test.worker.settled;
    expect(test.engines[0]?.environments.at(-1)).toEqual(["HOME", "/home/browser"]);
  });

  it("overlays an invocation's environment onto the configured one", async () => {
    const test = harness();
    await init(test, { env: { HOME: "/home/browser", UV_CACHE_DIR: "/base" } });
    test.worker.receive({
      type: "exec",
      invocationId: "x1",
      argv: ["uv"],
      env: { UV_CACHE_DIR: "/override" },
      stdin: false,
    });
    await test.worker.settled;
    expect(test.engines[0]?.environments.at(-1)).toEqual([
      "HOME",
      "/home/browser",
      "UV_CACHE_DIR",
      "/override",
    ]);
  });

  it("does not let one invocation's environment reach the next", async () => {
    const test = harness();
    await init(test, { env: { HOME: "/home/browser" } });
    test.worker.receive({
      type: "exec",
      invocationId: "x1",
      argv: ["uv"],
      env: { UV_NO_CACHE: "1" },
      stdin: false,
    });
    test.worker.receive({ type: "exec", invocationId: "x2", argv: ["uv"], stdin: false });
    await test.worker.settled;
    expect(test.engines[0]?.environments.at(-1)).toEqual(["HOME", "/home/browser"]);
  });
});
