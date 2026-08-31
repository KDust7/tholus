import { MAX_STDIN_BYTES, PROTOCOL_VERSION } from "@tholus/engine-protocol";
import { createMockEngine, type MockScript } from "@tholus/mock-engine";
import { describe, expect, it } from "vitest";
import { createEngine } from "./engine.js";
import { EngineCrashedError, ProtocolMismatchError, toEngineError } from "./errors.js";
import { collectText } from "./text.js";

function engineWith(script: MockScript = {}) {
  const mock = createMockEngine(script);
  return { mock, endpoint: () => mock };
}

const listScript: MockScript = {
  commands: [
    {
      argv: ["pip", "list"],
      steps: [{ kind: "stdout", text: "rich    13.9.4\n" }],
      exitCode: 0,
    },
  ],
};

describe("handshake", () => {
  it("exposes the engine build identity", async () => {
    const { endpoint } = engineWith();
    const engine = await createEngine({ endpoint });

    expect(engine.build.protocol).toBe(PROTOCOL_VERSION);
    engine.terminate();
  });

  it("rejects when the engine speaks another protocol", async () => {
    const { endpoint } = engineWith({ protocolVersion: "999" });
    await expect(createEngine({ endpoint })).rejects.toBeInstanceOf(ProtocolMismatchError);
  });

  it("rejects when the engine reports a mismatched protocol in its build identity", async () => {
    const { endpoint } = engineWith({
      build: { engine: "1.0.0", uv: "0.12.3", protocol: "42" },
    });
    await expect(createEngine({ endpoint })).rejects.toBeInstanceOf(ProtocolMismatchError);
  });

  it("times out on a silent engine, and does not leave the worker running", async () => {
    let terminated = 0;
    const endpoint = () => ({
      postMessage: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      terminate: () => {
        terminated += 1;
      },
    });

    await expect(createEngine({ endpoint, handshakeTimeoutMs: 20 })).rejects.toBeInstanceOf(
      EngineCrashedError,
    );
    expect(
      terminated,
      "a worker left running holds the cache lock for the whole origin, so the next boot in any tab waits forever",
    ).toBe(1);
  });

  it("does not leave the worker running when the engine reports a bad protocol", async () => {
    const mock = createMockEngine({ build: { engine: "1.0.0", uv: "0.12.3", protocol: "42" } });
    let terminated = 0;
    const endpoint = () => ({
      postMessage: (message: unknown) => mock.postMessage(message),
      addEventListener: (type: "message", listener: (event: { data: unknown }) => void) =>
        mock.addEventListener(type, listener),
      removeEventListener: (type: "message", listener: (event: { data: unknown }) => void) =>
        mock.removeEventListener(type, listener),
      terminate: () => {
        terminated += 1;
      },
    });

    await expect(createEngine({ endpoint })).rejects.toBeInstanceOf(ProtocolMismatchError);
    expect(terminated).toBe(1);
  });
});

describe("boot progress", () => {
  it("reports every phase the engine announces, in order", async () => {
    const { endpoint } = engineWith();
    const seen: string[] = [];

    const engine = await createEngine({
      endpoint,
      onBootProgress: (progress) => seen.push(progress.phase),
    });

    expect(
      seen,
      "boot progress is emitted before the handshake settles, so a listener registered after it sees nothing",
    ).toEqual(["compile-start", "compile-done", "init-start", "ready"]);
    engine.terminate();
  });

  it("carries the timing the engine measured", async () => {
    const { endpoint } = engineWith();
    const timed: (number | undefined)[] = [];

    const engine = await createEngine({
      endpoint,
      onBootProgress: (progress) => timed.push(progress.ms),
    });

    expect(timed.filter((ms) => ms !== undefined).length).toBeGreaterThan(0);
    engine.terminate();
  });

  it("boots for a host that does not watch, and for one whose listener throws", async () => {
    const quiet = await createEngine({ endpoint: engineWith().endpoint });
    expect(quiet.build.protocol).toBe(PROTOCOL_VERSION);
    quiet.terminate();

    const noisy = await createEngine({
      endpoint: engineWith().endpoint,
      onBootProgress: () => {
        throw new Error("the host is unhappy");
      },
    });
    expect(noisy.build.protocol).toBe(PROTOCOL_VERSION);
    noisy.terminate();
  });
});

describe("exec", () => {
  it("streams stdout and resolves with the exit code", async () => {
    const { endpoint } = engineWith(listScript);
    const engine = await createEngine({ endpoint });
    const out = collectText();

    const handle = engine.exec(["pip", "list"], { stdout: out.sink });
    const result = await handle.exit;

    expect(result.code).toBe(0);
    expect(result.cancelled).toBe(false);
    expect(out.text()).toBe("rich    13.9.4\n");
    engine.terminate();
  });

  it("numbers invocations so concurrent commands stay distinct", async () => {
    const { endpoint } = engineWith(listScript);
    const engine = await createEngine({ endpoint });

    const first = engine.exec(["pip", "list"]);
    const second = engine.exec(["pip", "list"]);

    expect(first.id).toBe("inv-1");
    expect(second.id).toBe("inv-2");
    await Promise.all([first.exit, second.exit]);
    engine.terminate();
  });

  it("acknowledges output so the engine can apply backpressure", async () => {
    const { mock, endpoint } = engineWith(listScript);
    const engine = await createEngine({ endpoint });

    await engine.exec(["pip", "list"], { stdout: () => {} }).exit;

    const acks = mock.received.filter((message) => message.type === "ack");
    expect(acks).toHaveLength(1);
    expect(acks[0]?.type === "ack" && acks[0].bytes).toBe(15);
    engine.terminate();
  });

  it("routes stderr separately from stdout", async () => {
    const { endpoint } = engineWith({
      commands: [
        {
          argv: ["a"],
          steps: [
            { kind: "stdout", text: "out" },
            { kind: "stderr", text: "err" },
          ],
        },
      ],
    });
    const engine = await createEngine({ endpoint });
    const out = collectText();
    const err = collectText();

    await engine.exec(["a"], { stdout: out.sink, stderr: err.sink }).exit;

    expect(out.text()).toBe("out");
    expect(err.text()).toBe("err");
    engine.terminate();
  });

  it("surfaces a structured error alongside the exit code", async () => {
    const { endpoint } = engineWith({
      commands: [
        {
          argv: ["boom"],
          exitCode: 1,
          error: { code: "resolution-conflict", message: "no solution" },
        },
      ],
    });
    const engine = await createEngine({ endpoint });

    const result = await engine.exec(["boom"]).exit;

    expect(result.code).toBe(1);
    expect(result.error?.code).toBe("resolution-conflict");
    engine.terminate();
  });

  it("refuses to run after disposal", async () => {
    const { endpoint } = engineWith(listScript);
    const engine = await createEngine({ endpoint });
    await engine.dispose();

    expect(() => engine.exec(["pip", "list"])).toThrow(EngineCrashedError);
  });
});

describe("events", () => {
  const eventScript: MockScript = {
    commands: [
      {
        argv: ["a"],
        steps: [
          {
            kind: "event",
            event: { type: "phase", invocationId: "inv-1", phase: "resolving", state: "start" },
          },
        ],
      },
    ],
  };

  it("delivers events to the engine-level listener", async () => {
    const { endpoint } = engineWith(eventScript);
    const engine = await createEngine({ endpoint });
    const seen: string[] = [];
    engine.onEvent((event) => seen.push(event.type));

    await engine.exec(["a"]).exit;

    expect(seen).toContain("phase");
    engine.terminate();
  });

  it("delivers events to the per-invocation listener", async () => {
    const { endpoint } = engineWith(eventScript);
    const engine = await createEngine({ endpoint });
    const seen: string[] = [];

    await engine.exec(["a"], { onEvent: (event) => seen.push(event.type) }).exit;

    expect(seen).toEqual(["phase"]);
    engine.terminate();
  });

  it("delivers events to a constructor-level listener", async () => {
    const { endpoint } = engineWith(eventScript);
    const seen: string[] = [];
    const engine = await createEngine({ endpoint, onEvent: (event) => seen.push(event.type) });

    await engine.exec(["a"]).exit;

    expect(seen).toEqual(["phase"]);
    engine.terminate();
  });

  it("stops delivering after unsubscribing", async () => {
    const { endpoint } = engineWith(eventScript);
    const engine = await createEngine({ endpoint });
    const seen: string[] = [];
    const off = engine.onEvent((event) => seen.push(event.type));
    off();

    await engine.exec(["a"]).exit;

    expect(seen).toEqual([]);
    engine.terminate();
  });
});

describe("stdin", () => {
  const readScript: MockScript = {
    commands: [{ argv: ["read"], steps: [{ kind: "stdout", text: "done\n" }] }],
  };

  it("sends a byte buffer with the invocation", async () => {
    const { mock, endpoint } = engineWith(readScript);
    const engine = await createEngine({ endpoint });

    await engine.exec(["read"], { stdin: new Uint8Array([0x61, 0x0a]) }).exit;

    const exec = mock.received.find((message) => message.type === "exec");
    expect(exec?.type === "exec" && exec.stdin).toEqual(new Uint8Array([0x61, 0x0a]));
    engine.terminate();
  });

  it("encodes a string as UTF-8", async () => {
    const { mock, endpoint } = engineWith(readScript);
    const engine = await createEngine({ endpoint });

    await engine.exec(["read"], { stdin: "café\n" }).exit;

    const exec = mock.received.find((message) => message.type === "exec");
    expect(exec?.type === "exec" && exec.stdin).toEqual(
      new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9, 0x0a]),
    );
    engine.terminate();
  });

  it("omits stdin entirely when none is supplied", async () => {
    const { mock, endpoint } = engineWith(readScript);
    const engine = await createEngine({ endpoint });

    await engine.exec(["read"]).exit;

    const exec = mock.received.find((message) => message.type === "exec");
    expect(exec?.type === "exec" && exec.stdin).toBeUndefined();
    engine.terminate();
  });

  it("sends an empty buffer rather than omitting it", async () => {
    const { mock, endpoint } = engineWith(readScript);
    const engine = await createEngine({ endpoint });

    await engine.exec(["read"], { stdin: "" }).exit;

    const exec = mock.received.find((message) => message.type === "exec");
    expect(exec?.type === "exec" && exec.stdin).toEqual(new Uint8Array(0));
    engine.terminate();
  });

  it("refuses a buffer past the size limit", async () => {
    const { endpoint } = engineWith(readScript);
    const engine = await createEngine({ endpoint });

    expect(() => engine.exec(["read"], { stdin: new Uint8Array(MAX_STDIN_BYTES + 1) })).toThrow(
      RangeError,
    );
    engine.terminate();
  });
});

describe("cancellation", () => {
  const slowScript: MockScript = {
    commands: [{ argv: ["slow"], steps: [{ kind: "pause" }] }],
  };

  it("cancels through the handle", async () => {
    const { endpoint } = engineWith(slowScript);
    const engine = await createEngine({ endpoint });

    const handle = engine.exec(["slow"]);
    handle.cancel("user interrupt");
    const result = await handle.exit;

    expect(result.cancelled).toBe(true);
    expect(result.code).toBe(130);
    engine.terminate();
  });

  it("cancels through an abort signal", async () => {
    const { endpoint } = engineWith(slowScript);
    const engine = await createEngine({ endpoint });
    const controller = new AbortController();

    const handle = engine.exec(["slow"], { signal: controller.signal });
    controller.abort("stop");
    const result = await handle.exit;

    expect(result.cancelled).toBe(true);
    engine.terminate();
  });

  it("cancels immediately when handed an already-aborted signal", async () => {
    const { endpoint } = engineWith(slowScript);
    const engine = await createEngine({ endpoint });

    const result = await engine.exec(["slow"], {
      signal: AbortSignal.abort("too late"),
    }).exit;

    expect(result.cancelled).toBe(true);
    engine.terminate();
  });
});

describe("terminal size", () => {
  it("forwards a resize to the engine", async () => {
    const { mock, endpoint } = engineWith(listScript);
    const engine = await createEngine({ endpoint });

    const handle = engine.exec(["pip", "list"], { tty: { cols: 80, rows: 24 } });
    handle.resize({ cols: 120, rows: 40 });
    await handle.exit;

    const resize = mock.received.find((message) => message.type === "resize");
    expect(resize?.type === "resize" && resize.size).toEqual({ cols: 120, rows: 40 });
    engine.terminate();
  });
});

describe("lifecycle", () => {
  it("is safe to dispose twice", async () => {
    const { endpoint } = engineWith(listScript);
    const engine = await createEngine({ endpoint });

    await engine.dispose();
    await expect(engine.dispose()).resolves.toBeUndefined();
  });

  it("fails an in-flight command when terminated", async () => {
    const { endpoint } = engineWith({
      commands: [{ argv: ["slow"], steps: [{ kind: "pause" }] }],
    });
    const engine = await createEngine({ endpoint });

    const handle = engine.exec(["slow"]);
    engine.terminate();

    await expect(handle.exit).rejects.toBeInstanceOf(EngineCrashedError);
  });
});

describe("error mapping", () => {
  it("maps every structured code to a typed error", () => {
    const codes = [
      "network",
      "resolution-conflict",
      "package-not-found",
      "hash-mismatch",
      "no-runtime-attached",
      "sdist-needs-runtime",
      "runtime-required",
      "build-failed",
      "unsupported",
      "cancelled",
      "engine-crashed",
      "protocol-mismatch",
    ] as const;

    for (const code of codes) {
      const error = toEngineError({ code, message: `${code} happened` });
      expect(error.code).toBe(code);
      expect(error.message).toBe(`${code} happened`);
    }
  });

  it("carries structured data through", () => {
    const error = toEngineError({
      code: "build-failed",
      message: "backend exploded",
      data: { stderr: "traceback" },
    });
    expect(error.data).toEqual({ stderr: "traceback" });
  });
});

describe("the parts of the handle a host reaches for after the first command", () => {
  interface Wire {
    sent: { type: string; [key: string]: unknown }[];
    reply(message: unknown): void;
    endpoint: () => {
      postMessage(message: unknown): void;
      addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
      removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
      terminate(): void;
    };
  }

  function wire(): Wire {
    const listeners = new Set<(event: { data: unknown }) => void>();
    const sent: { type: string; [key: string]: unknown }[] = [];
    const reply = (message: unknown): void => {
      for (const listener of [...listeners]) {
        listener({ data: message });
      }
    };
    return {
      sent,
      reply,
      endpoint: () => ({
        postMessage(message: unknown): void {
          const typed = message as { type: string; id?: string };
          sent.push(typed);
          if (typed.type === "init") {
            reply({
              type: "initResult",
              id: typed.id,
              outcome: {
                ok: true,
                build: { engine: "0.0.0", uv: "0.12.3", protocol: PROTOCOL_VERSION },
              },
            });
          }
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
      }),
    };
  }

  it("resolves an exported tree with its entries and its bytes", async () => {
    const test = wire();
    const engine = await createEngine({ endpoint: test.endpoint });

    const exported = engine.exportTree("/work/.venv");
    const request = test.sent.find((message) => message.type === "exportTree");
    expect(request).toMatchObject({ path: "/work/.venv" });

    const bytes = new Uint8Array([1, 2, 3]);
    test.reply({
      type: "exportTreeResult",
      id: request?.id,
      outcome: {
        ok: true,
        entries: [{ kind: "file", path: "a.txt", offset: 0, length: 3 }],
        bytes,
      },
    });

    await expect(exported).resolves.toMatchObject({ bytes });
    engine.terminate();
  });

  it("rejects an export the engine refused, with the engine's own error", async () => {
    const test = wire();
    const engine = await createEngine({ endpoint: test.endpoint });

    const exported = engine.exportTree("/nowhere");
    const request = test.sent.find((message) => message.type === "exportTree");
    test.reply({
      type: "exportTreeResult",
      id: request?.id,
      outcome: {
        ok: false,
        error: { code: "unsupported", message: "/nowhere is not a directory" },
      },
    });

    await expect(exported).rejects.toThrow("/nowhere is not a directory");
    engine.terminate();
  });

  it("refuses to export once the engine is disposed", async () => {
    const test = wire();
    const engine = await createEngine({ endpoint: test.endpoint });
    await engine.dispose();
    await expect(engine.exportTree("/work")).rejects.toBeInstanceOf(EngineCrashedError);
  });

  it("attaches a runtime and detaches it exactly once", async () => {
    const test = wire();
    const engine = await createEngine({ endpoint: test.endpoint });

    const detach = engine.attachRuntime(async () => ({
      stdout: [],
      stderr: [],
      code: 0,
      writes: [],
    }));
    expect(test.sent.filter((message) => message.type === "attachRuntime")).toHaveLength(1);

    detach();
    detach();
    expect(
      test.sent.filter((message) => message.type === "detachRuntime"),
      "a detach that already ran must not tell the engine twice",
    ).toHaveLength(1);
    engine.terminate();
  });

  it("stops delivering events once a listener unsubscribes", async () => {
    const test = wire();
    const engine = await createEngine({ endpoint: test.endpoint });

    const seen: string[] = [];
    const stop = engine.onEvent((event) => seen.push(event.type));
    test.reply({ type: "event", event: { type: "log", level: "warn", message: "first" } });
    stop();
    test.reply({ type: "event", event: { type: "log", level: "warn", message: "second" } });

    expect(seen).toEqual(["log"]);
    engine.terminate();
  });

  it("cancels what is still running when it is disposed", async () => {
    const test = wire();
    const engine = await createEngine({ endpoint: test.endpoint });

    const handle = engine.exec(["pip", "install", "slow"]);
    const settled = handle.exit.catch((error: unknown) => error);
    await engine.dispose();

    expect(
      test.sent.filter((message) => message.type === "cancel"),
      "disposing has to interrupt what is in flight rather than abandon it",
    ).toHaveLength(1);
    expect(String(await settled)).toContain("disposed");
  });
});
