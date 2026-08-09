import { describe, expect, it } from "vitest";
import { engineConfigSchema } from "./config.js";
import { engineEventSchema } from "./events.js";
import {
  EXIT_CODE_CANCELLED,
  HOST_MESSAGE_TYPES,
  hostMessageSchema,
  WORKER_MESSAGE_TYPES,
  workerMessageSchema,
} from "./messages.js";
import {
  assertCompatibleProtocol,
  ProtocolError,
  parseHostMessage,
  parseWorkerMessage,
} from "./parse.js";
import { PROTOCOL_VERSION } from "./version.js";

describe("host messages", () => {
  it("accepts an init message and applies config defaults", () => {
    const message = parseHostMessage({
      type: "init",
      id: "init-1",
      protocolVersion: PROTOCOL_VERSION,
      config: {},
    });

    expect(message.type).toBe("init");
    if (message.type !== "init") throw new Error("unreachable");
    expect(message.config.fs).toEqual({ kind: "memory" });
    expect(message.config.cwd).toBe("/work");
    expect(message.config.env).toEqual({});
  });

  it("defaults exec stdin to false", () => {
    const message = parseHostMessage({
      type: "exec",
      invocationId: "inv-1",
      argv: ["pip", "list"],
    });

    if (message.type !== "exec") throw new Error("unreachable");
    expect(message.stdin).toBe(false);
    expect(message.argv).toEqual(["pip", "list"]);
  });

  it("rejects a tty size of zero columns", () => {
    expect(() =>
      parseHostMessage({
        type: "exec",
        invocationId: "inv-1",
        argv: ["pip", "list"],
        tty: { cols: 0, rows: 24 },
      }),
    ).toThrow(ProtocolError);
  });

  it("rejects an unknown message type", () => {
    expect(() => parseHostMessage({ type: "teleport" })).toThrow(ProtocolError);
  });

  it("rejects a cancel message without an invocation id", () => {
    expect(() => parseHostMessage({ type: "cancel" })).toThrow(ProtocolError);
  });

  it("covers every declared host message type", () => {
    const declared = new Set(HOST_MESSAGE_TYPES);
    const parsed = new Set(hostMessageSchema.options.map((option) => option.shape.type.value));
    expect(parsed).toEqual(declared);
  });
});

describe("worker messages", () => {
  it("accepts a successful init result", () => {
    const message = parseWorkerMessage({
      type: "initResult",
      id: "init-1",
      outcome: {
        ok: true,
        build: { engine: "0.0.0", uv: "unvendored", protocol: PROTOCOL_VERSION },
      },
    });

    if (message.type !== "initResult") throw new Error("unreachable");
    expect(message.outcome.ok).toBe(true);
  });

  it("accepts a failed init result carrying a structured error", () => {
    const message = parseWorkerMessage({
      type: "initResult",
      id: "init-1",
      outcome: {
        ok: false,
        error: { code: "protocol-mismatch", message: "engine speaks 1" },
      },
    });

    if (message.type !== "initResult") throw new Error("unreachable");
    if (message.outcome.ok) throw new Error("expected failure outcome");
    expect(message.outcome.error.code).toBe("protocol-mismatch");
  });

  it("carries output as raw bytes", () => {
    const data = new TextEncoder().encode("Resolved 3 packages\n");
    const message = parseWorkerMessage({
      type: "output",
      invocationId: "inv-1",
      stream: "stdout",
      seq: 0,
      data,
    });

    if (message.type !== "output") throw new Error("unreachable");
    expect(message.data).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(message.data)).toBe("Resolved 3 packages\n");
  });

  it("rejects output whose payload is a string", () => {
    expect(() =>
      parseWorkerMessage({
        type: "output",
        invocationId: "inv-1",
        stream: "stdout",
        seq: 0,
        data: "Resolved 3 packages\n",
      }),
    ).toThrow(ProtocolError);
  });

  it("accepts a cancelled exit", () => {
    const message = parseWorkerMessage({
      type: "exit",
      invocationId: "inv-1",
      code: EXIT_CODE_CANCELLED,
      cancelled: true,
      durationMs: 12,
    });

    if (message.type !== "exit") throw new Error("unreachable");
    expect(message.code).toBe(130);
    expect(message.cancelled).toBe(true);
  });

  it("covers every declared worker message type", () => {
    const declared = new Set(WORKER_MESSAGE_TYPES);
    const parsed = new Set(workerMessageSchema.options.map((option) => option.shape.type.value));
    expect(parsed).toEqual(declared);
  });
});

describe("engine events", () => {
  it("accepts a download progress event", () => {
    const parsed = engineEventSchema.parse({
      type: "progress",
      invocationId: "inv-1",
      progressId: "p-1",
      kind: "download",
      subject: "rich-13.9.4-py3-none-any.whl",
      current: 1024,
      total: 4096,
      unit: "bytes",
    });

    expect(parsed.type).toBe("progress");
  });

  it("rejects negative progress", () => {
    const result = engineEventSchema.safeParse({
      type: "progress",
      invocationId: "inv-1",
      progressId: "p-1",
      kind: "download",
      current: -1,
      unit: "bytes",
    });

    expect(result.success).toBe(false);
  });

  it("requires a resolution count that is a whole number", () => {
    const result = engineEventSchema.safeParse({
      type: "resolution-complete",
      invocationId: "inv-1",
      packageCount: 1.5,
      durationMs: 10,
    });

    expect(result.success).toBe(false);
  });
});

describe("engine config", () => {
  it("keeps an explicit opfs cache scope", () => {
    const config = engineConfigSchema.parse({ cache: { kind: "opfs", scope: "demo" } });
    expect(config.cache).toEqual({ kind: "opfs", scope: "demo" });
  });

  it("rejects an unknown filesystem backend", () => {
    expect(() => engineConfigSchema.parse({ fs: { kind: "s3" } })).toThrow();
  });
});

describe("protocol version", () => {
  it("accepts a matching version", () => {
    expect(() => assertCompatibleProtocol(PROTOCOL_VERSION)).not.toThrow();
  });

  it("rejects a differing version", () => {
    expect(() => assertCompatibleProtocol("999")).toThrow(ProtocolError);
  });
});
