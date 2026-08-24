import {
  EXIT_CODE_CANCELLED,
  PROTOCOL_VERSION,
  type WorkerMessage,
} from "@tholus/engine-protocol";
import { describe, expect, it } from "vitest";
import { createMockEngine } from "./index.js";
import { matchCommand } from "./script.js";

function collect(engine: ReturnType<typeof createMockEngine>): WorkerMessage[] {
  const seen: WorkerMessage[] = [];
  engine.addEventListener("message", (event) => seen.push(event.data as WorkerMessage));
  return seen;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("initialization", () => {
  it("reports its build identity on a matching protocol", () => {
    const engine = createMockEngine();
    const seen = collect(engine);
    engine.postMessage({ type: "init", id: "i1", protocolVersion: PROTOCOL_VERSION, config: {} });

    const first = seen.find((message) => message.type === "initResult");
    expect(first?.type).toBe("initResult");
    if (first?.type !== "initResult") throw new Error("unreachable");
    expect(first.outcome.ok).toBe(true);
  });

  it("reports boot progress before the build identity", () => {
    const engine = createMockEngine();
    const seen = collect(engine);
    engine.postMessage({ type: "init", id: "i1", protocolVersion: PROTOCOL_VERSION, config: {} });

    expect(seen.map((message) => message.type)).toEqual([
      "bootProgress",
      "bootProgress",
      "bootProgress",
      "bootProgress",
      "initResult",
    ]);
    expect(
      seen.flatMap((message) => (message.type === "bootProgress" ? [message.phase] : [])),
    ).toEqual(["compile-start", "compile-done", "init-start", "ready"]);
  });

  it("does not boot for a host it is about to reject", () => {
    const engine = createMockEngine();
    const seen = collect(engine);
    engine.postMessage({ type: "init", id: "i1", protocolVersion: "999", config: {} });

    expect(seen.map((message) => message.type)).toEqual(["initResult"]);
  });

  it("boots once per engine, not once per handshake", () => {
    const engine = createMockEngine();
    const seen = collect(engine);
    engine.postMessage({ type: "init", id: "i1", protocolVersion: PROTOCOL_VERSION, config: {} });
    engine.postMessage({ type: "init", id: "i2", protocolVersion: PROTOCOL_VERSION, config: {} });

    expect(seen.filter((message) => message.type === "bootProgress")).toHaveLength(4);
    expect(seen.filter((message) => message.type === "initResult")).toHaveLength(2);
  });

  it("refuses a handshake from a different protocol", () => {
    const engine = createMockEngine();
    const seen = collect(engine);
    engine.postMessage({ type: "init", id: "i1", protocolVersion: "999", config: {} });

    const first = seen[0];
    if (first?.type !== "initResult") throw new Error("unreachable");
    if (first.outcome.ok) throw new Error("expected refusal");
    expect(first.outcome.error.code).toBe("protocol-mismatch");
  });

  it("honors a scripted build identity", () => {
    const build = { engine: "1.2.3", uv: "0.12.3", protocol: PROTOCOL_VERSION };
    const engine = createMockEngine({ build });
    const seen = collect(engine);
    engine.postMessage({ type: "init", id: "i1", protocolVersion: PROTOCOL_VERSION, config: {} });

    const first = seen.find((message) => message.type === "initResult");
    if (first?.type !== "initResult" || !first.outcome.ok) throw new Error("unreachable");
    expect(first.outcome.build).toEqual(build);
  });
});

describe("command execution", () => {
  it("streams scripted output then exits", async () => {
    const engine = createMockEngine({
      commands: [{ argv: ["pip", "list"], steps: [{ kind: "stdout", text: "ok\n" }] }],
    });
    const seen = collect(engine);
    engine.postMessage({ type: "exec", invocationId: "inv-1", argv: ["pip", "list"] });
    await settle();

    expect(seen.map((message) => message.type)).toEqual(["output", "exit"]);
  });

  it("increments the sequence number per output chunk", async () => {
    const engine = createMockEngine({
      commands: [
        {
          argv: ["a"],
          steps: [
            { kind: "stdout", text: "one" },
            { kind: "stderr", text: "two" },
          ],
        },
      ],
    });
    const seen = collect(engine);
    engine.postMessage({ type: "exec", invocationId: "inv-1", argv: ["a"] });
    await settle();

    const outputs = seen.filter((message) => message.type === "output");
    expect(outputs.map((message) => message.seq)).toEqual([0, 1]);
  });

  it("falls back to a non-zero exit for an unscripted command", async () => {
    const engine = createMockEngine({ commands: [] });
    const seen = collect(engine);
    engine.postMessage({ type: "exec", invocationId: "inv-1", argv: ["nope"] });
    await settle();

    const exit = seen.find((message) => message.type === "exit");
    expect(exit?.type === "exit" && exit.code).toBe(1);
  });

  it("uses the scripted fallback for an unscripted command", async () => {
    const engine = createMockEngine({
      unknownCommand: {
        exitCode: 127,
        steps: [{ kind: "stderr", text: "unknown command\n" }],
        error: { code: "unsupported", message: "unknown command" },
      },
    });
    const seen = collect(engine);
    engine.postMessage({ type: "exec", invocationId: "inv-1", argv: ["nope"] });
    await settle();

    const exit = seen.find((message) => message.type === "exit");
    if (exit?.type !== "exit") throw new Error("unreachable");
    expect(exit.code).toBe(127);
    expect(exit.error?.code).toBe("unsupported");
  });

  it("attaches a structured error to a failing command", async () => {
    const engine = createMockEngine({
      commands: [
        {
          argv: ["boom"],
          exitCode: 1,
          error: { code: "network", message: "offline" },
        },
      ],
    });
    const seen = collect(engine);
    engine.postMessage({ type: "exec", invocationId: "inv-1", argv: ["boom"] });
    await settle();

    const exit = seen.find((message) => message.type === "exit");
    expect(exit?.type === "exit" && exit.error?.code).toBe("network");
  });

  it("emits events alongside output", async () => {
    const engine = createMockEngine({
      commands: [
        {
          argv: ["a"],
          steps: [
            {
              kind: "event",
              event: { type: "log", level: "info", message: "hello" },
            },
          ],
        },
      ],
    });
    const seen = collect(engine);
    engine.postMessage({ type: "exec", invocationId: "inv-1", argv: ["a"] });
    await settle();

    expect(seen[0]?.type).toBe("event");
  });
});

describe("stdin", () => {
  it("carries a buffer on the exec message", async () => {
    const engine = createMockEngine({
      commands: [{ argv: ["read"], steps: [{ kind: "stdout", text: "done\n" }] }],
    });
    const seen = collect(engine);
    const stdin = new TextEncoder().encode("anyio\n");
    engine.postMessage({ type: "exec", invocationId: "inv-1", argv: ["read"], stdin });
    await settle();

    expect(seen.map((message) => message.type)).toEqual(["output", "exit"]);
    const received = engine.received.at(-1);
    expect(received?.type === "exec" && received.stdin).toEqual(stdin);
  });

  it("leaves stdin absent when the host supplies none", async () => {
    const engine = createMockEngine({
      commands: [{ argv: ["read"], steps: [] }],
    });
    engine.postMessage({ type: "exec", invocationId: "inv-1", argv: ["read"] });
    await settle();

    const received = engine.received.at(-1);
    expect(received?.type === "exec" && received.stdin).toBeUndefined();
  });

  it("distinguishes an empty buffer from an absent one", async () => {
    const engine = createMockEngine({
      commands: [{ argv: ["read"], steps: [] }],
    });
    engine.postMessage({
      type: "exec",
      invocationId: "inv-1",
      argv: ["read"],
      stdin: new Uint8Array(0),
    });
    await settle();

    const received = engine.received.at(-1);
    expect(received?.type === "exec" && received.stdin).toEqual(new Uint8Array(0));
  });
});

describe("cancellation", () => {
  it("ends a waiting invocation with the interrupt code", async () => {
    const engine = createMockEngine({
      commands: [{ argv: ["slow"], steps: [{ kind: "pause" }] }],
    });
    const seen = collect(engine);
    engine.postMessage({ type: "exec", invocationId: "inv-1", argv: ["slow"] });
    await settle();
    engine.postMessage({ type: "cancel", invocationId: "inv-1" });
    await settle();

    const exits = seen.filter((message) => message.type === "exit");
    expect(exits).toHaveLength(1);
    expect(exits[0]?.type === "exit" && exits[0].code).toBe(EXIT_CODE_CANCELLED);
  });

  it("ignores cancellation of an unknown invocation", async () => {
    const engine = createMockEngine();
    const seen = collect(engine);
    engine.postMessage({ type: "cancel", invocationId: "ghost" });
    await settle();

    expect(seen).toEqual([]);
  });
});

describe("lifecycle", () => {
  it("absorbs resize and ack without replying", async () => {
    const engine = createMockEngine();
    const seen = collect(engine);
    engine.postMessage({ type: "resize", invocationId: "inv-1", size: { cols: 80, rows: 24 } });
    engine.postMessage({ type: "ack", invocationId: "inv-1", stream: "stdout", bytes: 10 });
    await settle();

    expect(seen).toEqual([]);
  });

  it("stops responding after dispose", async () => {
    const engine = createMockEngine();
    const seen = collect(engine);
    engine.postMessage({ type: "dispose" });
    engine.postMessage({ type: "init", id: "i1", protocolVersion: PROTOCOL_VERSION, config: {} });
    await settle();

    expect(seen).toEqual([]);
  });

  it("drops listeners on terminate", () => {
    const engine = createMockEngine();
    const seen = collect(engine);
    engine.terminate();
    engine.postMessage({ type: "init", id: "i1", protocolVersion: PROTOCOL_VERSION, config: {} });

    expect(seen).toEqual([]);
  });

  it("supports removing a listener", () => {
    const engine = createMockEngine();
    const seen: WorkerMessage[] = [];
    const listener = (event: { data: unknown }) => seen.push(event.data as WorkerMessage);
    engine.addEventListener("message", listener);
    engine.removeEventListener("message", listener);
    engine.postMessage({ type: "init", id: "i1", protocolVersion: PROTOCOL_VERSION, config: {} });

    expect(seen).toEqual([]);
  });

  it("records the host messages it received", () => {
    const engine = createMockEngine();
    engine.postMessage({ type: "init", id: "i1", protocolVersion: PROTOCOL_VERSION, config: {} });

    expect(engine.received).toHaveLength(1);
    expect(engine.emitted).toHaveLength(5);
  });

  it("rejects a malformed host message", () => {
    const engine = createMockEngine();
    expect(() => engine.postMessage({ type: "nonsense" })).toThrow();
  });
});

describe("matchCommand", () => {
  it("matches on exact argv", () => {
    const script = { commands: [{ argv: ["pip", "list"] }] };
    expect(matchCommand(script, ["pip", "list"])).toBeDefined();
  });

  it("rejects a different length", () => {
    const script = { commands: [{ argv: ["pip", "list"] }] };
    expect(matchCommand(script, ["pip"])).toBeUndefined();
  });

  it("rejects a different token", () => {
    const script = { commands: [{ argv: ["pip", "list"] }] };
    expect(matchCommand(script, ["pip", "show"])).toBeUndefined();
  });

  it("handles a script with no commands", () => {
    expect(matchCommand({}, ["pip"])).toBeUndefined();
  });
});
