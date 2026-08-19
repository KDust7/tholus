import {
  type BuildIdentity,
  EXIT_CODE_CANCELLED,
  type HostMessage,
  PROTOCOL_VERSION,
  parseHostMessage,
  type WorkerMessage,
} from "@uv-wasm/engine-protocol";
import { type MockScript, type MockStep, matchCommand } from "./script.js";

export * from "./script.js";

export interface MockEngineEndpoint {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  terminate(): void;
  readonly received: HostMessage[];
  readonly emitted: WorkerMessage[];
}

const DEFAULT_BUILD: BuildIdentity = {
  engine: "0.0.0-mock",
  uv: "unvendored",
  protocol: PROTOCOL_VERSION,
};

const encoder = new TextEncoder();

interface Invocation {
  cancelled: boolean;
  seq: number;
  pendingStdin?: (value: string | null) => void;
}

export function createMockEngine(script: MockScript = {}): MockEngineEndpoint {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const received: HostMessage[] = [];
  const emitted: WorkerMessage[] = [];
  const invocations = new Map<string, Invocation>();
  let terminated = false;
  let booted = false;
  let stdinRequestCounter = 0;

  const emit = (message: WorkerMessage): void => {
    if (terminated) {
      return;
    }
    emitted.push(message);
    for (const listener of listeners) {
      listener({ data: message });
    }
  };

  const boot = (): void => {
    if (booted) {
      return;
    }
    booted = true;
    emit({ type: "bootProgress", phase: "compile-start" });
    emit({ type: "bootProgress", phase: "compile-done", ms: 0 });
    emit({ type: "bootProgress", phase: "init-start" });
    emit({ type: "bootProgress", phase: "ready", ms: 0 });
  };

  const runStep = async (
    invocationId: string,
    invocation: Invocation,
    step: MockStep,
  ): Promise<void> => {
    if (invocation.cancelled) {
      return;
    }
    switch (step.kind) {
      case "stdout":
      case "stderr": {
        emit({
          type: "output",
          invocationId,
          stream: step.kind,
          seq: invocation.seq,
          data: encoder.encode(step.text),
        });
        invocation.seq += 1;
        return;
      }
      case "event": {
        emit({ type: "event", event: step.event });
        return;
      }
      case "prompt": {
        stdinRequestCounter += 1;
        const id = `stdin-${stdinRequestCounter}`;
        const answer = new Promise<string | null>((resolve) => {
          invocation.pendingStdin = resolve;
        });
        emit({
          type: "stdinRequest",
          id,
          invocationId,
          ...(step.prompt === undefined ? {} : { prompt: step.prompt }),
          echo: step.echo,
        });
        await answer;
        invocation.pendingStdin = undefined as unknown as (value: string | null) => void;
        return;
      }
    }
  };

  const runCommand = async (message: Extract<HostMessage, { type: "exec" }>): Promise<void> => {
    const invocation: Invocation = { cancelled: false, seq: 0 };
    invocations.set(message.invocationId, invocation);

    const command = matchCommand(script, message.argv);
    const plan = command ?? script.unknownCommand;
    const steps: MockStep[] = plan?.steps ?? [];

    for (const step of steps) {
      await runStep(message.invocationId, invocation, step);
      if (invocation.cancelled) {
        break;
      }
    }

    if (invocation.cancelled) {
      invocations.delete(message.invocationId);
      return;
    }

    const fallbackExit = command ? 0 : (script.unknownCommand?.exitCode ?? 1);
    const error = command?.error ?? (command ? undefined : script.unknownCommand?.error);

    emit({
      type: "exit",
      invocationId: message.invocationId,
      code: command?.exitCode ?? fallbackExit,
      cancelled: false,
      durationMs: 0,
      ...(error === undefined ? {} : { error }),
    });
    invocations.delete(message.invocationId);
  };

  const handle = (message: HostMessage): void => {
    switch (message.type) {
      case "init": {
        const speaks = script.protocolVersion ?? PROTOCOL_VERSION;
        if (message.protocolVersion !== speaks) {
          emit({
            type: "initResult",
            id: message.id,
            outcome: {
              ok: false,
              error: {
                code: "protocol-mismatch",
                message: `engine speaks protocol ${speaks}, host speaks ${message.protocolVersion}`,
              },
            },
          });
          return;
        }
        boot();
        emit({
          type: "initResult",
          id: message.id,
          outcome: { ok: true, build: script.build ?? DEFAULT_BUILD },
        });
        return;
      }
      case "exec": {
        void runCommand(message);
        return;
      }
      case "stdinResponse": {
        for (const invocation of invocations.values()) {
          if (invocation.pendingStdin) {
            const resolve = invocation.pendingStdin;
            invocation.pendingStdin = undefined as unknown as (value: string | null) => void;
            resolve(message.data);
            return;
          }
        }
        return;
      }
      case "cancel": {
        const invocation = invocations.get(message.invocationId);
        if (!invocation) {
          return;
        }
        invocation.cancelled = true;
        invocation.pendingStdin?.(null);
        emit({
          type: "exit",
          invocationId: message.invocationId,
          code: EXIT_CODE_CANCELLED,
          cancelled: true,
          durationMs: 0,
        });
        invocations.delete(message.invocationId);
        return;
      }
      case "resize":
      case "ack":
        return;
      case "dispose": {
        terminated = true;
        return;
      }
    }
  };

  return {
    postMessage(raw: unknown): void {
      if (terminated) {
        return;
      }
      const message = parseHostMessage(raw);
      received.push(message);
      handle(message);
    },
    addEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
      listeners.add(listener);
    },
    removeEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
      listeners.delete(listener);
    },
    terminate(): void {
      terminated = true;
      listeners.clear();
    },
    received,
    emitted,
  };
}
