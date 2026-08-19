import {
  EXIT_CODE_CANCELLED,
  PROTOCOL_VERSION,
  type WorkerMessage,
} from "@uv-wasm/engine-protocol";
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
  blocks?: boolean;
  rejectsCwd?: boolean;
}

class FakeEngine implements EngineHandle {
  columns = 0;
  rows = 0;
  cleared = false;
  cancels = 0;
  readonly environments: string[][] = [];
  readonly directories: string[] = [];
  readonly stdins: (Uint8Array | undefined)[] = [];
  private release: ((code: number) => void) | undefined;

  constructor(private readonly options: FakeOptions) {}

  envReplace(entries: string[]): void {
    this.environments.push(entries);
  }

  setStdin(bytes: Uint8Array): void {
    this.stdins.push(bytes);
  }

  clearStdin(): void {
    this.stdins.push(undefined);
  }

  setCwd(path: string): void {
    if (this.options.rejectsCwd) {
      throw new Error(`uv-wasm: could not enter \`${path}\``);
    }
    this.directories.push(path);
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
    if (this.options.blocks) {
      return new Promise<number>((resolve) => {
        this.release = resolve;
      });
    }
    return this.options.exitCode ?? 0;
  }

  cancel(): boolean {
    this.cancels += 1;
    if (!this.release) {
      return false;
    }
    this.release(EXIT_CODE_CANCELLED);
    this.release = undefined;
    return true;
  }

  setTermSize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
  }

  clearTerm(): void {
    this.cleared = true;
  }

  isRunning(): boolean {
    return this.release !== undefined;
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
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv", "--help"] });
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
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
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

  it("hands the engine the standard input the host supplied", async () => {
    const test = harness();
    await init(test);
    const stdin = encoder.encode("anyio\n");
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"], stdin });
    await test.worker.settled;
    expect(test.engines[0]?.stdins).toEqual([stdin]);
  });

  it("clears standard input when the host supplies none, so it cannot leak forward", async () => {
    const test = harness();
    await init(test);
    test.worker.receive({
      type: "exec",
      invocationId: "x1",
      argv: ["uv"],
      stdin: encoder.encode("a"),
    });
    await test.worker.settled;
    test.worker.receive({ type: "exec", invocationId: "x2", argv: ["uv"] });
    await test.worker.settled;
    expect(test.engines[0]?.stdins).toEqual([encoder.encode("a"), undefined]);
  });

  it("passes an empty buffer through rather than treating it as absent", async () => {
    const test = harness();
    await init(test);
    test.worker.receive({
      type: "exec",
      invocationId: "x1",
      argv: ["uv"],
      stdin: new Uint8Array(0),
    });
    await test.worker.settled;
    expect(test.engines[0]?.stdins).toEqual([new Uint8Array(0)]);
  });

  it("declares a terminal when the host attaches one", async () => {
    const test = harness();
    await init(test);
    test.worker.receive({
      type: "exec",
      invocationId: "x1",
      argv: ["uv"],
      tty: { cols: 120, rows: 40 },
    });
    await test.worker.settled;
    expect(test.engines[0]).toMatchObject({ columns: 120, rows: 40 });
  });

  it("clears the terminal when the host attaches none", async () => {
    const test = harness();
    await init(test);
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
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
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
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
    test.worker.receive({ type: "exec", invocationId: "a", argv: ["uv"] });
    test.worker.receive({ type: "exec", invocationId: "b", argv: ["uv"] });
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

  it("enters the working directory the config named", async () => {
    const test = harness();
    await init(test, { cwd: "/work" });
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
    await test.worker.settled;
    expect(test.engines[0]?.directories).toEqual(["/work"]);
  });

  it("lets an invocation name a working directory of its own", async () => {
    const test = harness();
    await init(test, { cwd: "/work" });
    test.worker.receive({
      type: "exec",
      invocationId: "x1",
      argv: ["uv"],
      cwd: "/elsewhere",
    });
    test.worker.receive({ type: "exec", invocationId: "x2", argv: ["uv"] });
    await test.worker.settled;
    expect(test.engines[0]?.directories).toEqual(["/elsewhere", "/work"]);
  });

  it("reports a working directory it cannot enter as a failed invocation", async () => {
    const test = harness({ rejectsCwd: true });
    await init(test, { cwd: "/missing" });
    test.emitted.length = 0;
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
    await test.worker.settled;
    expect(test.emitted).toHaveLength(1);
    const [exit] = test.emitted;
    expect(exit?.type).toBe("exit");
    expect(exit).toMatchObject({ code: 1, cancelled: false });
  });

  it("interrupts an invocation that is already running", async () => {
    const test = harness({ blocks: true, stdout: "started" });
    await init(test);
    test.emitted.length = 0;
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
    await Promise.resolve();
    expect(test.engines[0]?.isRunning()).toBe(true);
    test.worker.receive({ type: "cancel", invocationId: "x1" });
    await test.worker.settled;
    expect(test.engines[0]?.cancels).toBe(1);
    expect(test.emitted).toEqual([
      {
        type: "output",
        invocationId: "x1",
        stream: "stdout",
        seq: 0,
        data: encoder.encode("started"),
      },
      {
        type: "exit",
        invocationId: "x1",
        code: EXIT_CODE_CANCELLED,
        cancelled: true,
        durationMs: 0,
      },
    ]);
  });

  it("does not reach for the engine when the cancelled invocation is only queued", async () => {
    const test = harness({ stdout: "partial" });
    await init(test);
    test.worker.receive({ type: "cancel", invocationId: "never-sent" });
    await test.worker.settled;
    expect(test.engines[0]?.cancels).toBe(0);
  });

  it("turns an engine crash into an exit and a fatal", async () => {
    const test = harness({ throws: "unreachable executed" });
    await init(test);
    test.emitted.length = 0;
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
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
    test.worker.receive({ type: "exec", invocationId: "a", argv: ["uv"] });
    test.worker.receive({ type: "exec", invocationId: "b", argv: ["uv"] });
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
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
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
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
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
    });
    test.worker.receive({ type: "exec", invocationId: "x2", argv: ["uv"] });
    await test.worker.settled;
    expect(test.engines[0]?.environments.at(-1)).toEqual(["HOME", "/home/browser"]);
  });
});
