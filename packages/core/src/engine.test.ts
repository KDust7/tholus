import { MAX_STDIN_BYTES, PROTOCOL_VERSION } from "@uv-wasm/engine-protocol";
import { createMockEngine, type MockScript } from "@uv-wasm/mock-engine";
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

  it("times out on a silent engine", async () => {
    const endpoint = () => ({
      postMessage: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      terminate: () => {},
    });

    await expect(createEngine({ endpoint, handshakeTimeoutMs: 20 })).rejects.toBeInstanceOf(
      EngineCrashedError,
    );
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
