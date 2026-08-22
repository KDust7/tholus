import {
  type BuildIdentity,
  type EngineEvent,
  EXIT_CODE_CANCELLED,
  type ExportTreeResultMessage,
  type HookRequestMessage,
  type HookTree,
  type HookWrite,
  MAX_STDIN_BYTES,
  PROTOCOL_VERSION,
  type PromptPolicy,
  parseWorkerMessage,
  type StructuredErrorInfo,
  type TtyConfig,
  type TtySize,
  type WorkerMessage,
} from "@uv-wasm/engine-protocol";
import { DEFAULT_CWD } from "./brand.js";
import { createPipApi, createVenvApi } from "./commands.js";
import { type EndpointFactory, workerEndpoint } from "./endpoint.js";
import { EngineCrashedError, ProtocolMismatchError, toEngineError } from "./errors.js";
import type { ExportedTree } from "./export-tree.js";

export interface EngineConfigInput {
  fs?: { kind: "memory" } | { kind: "opfs"; root?: string } | { kind: "delegate" };
  cache?:
    | { kind: "opfs"; scope?: string; abiTag?: string; budgetBytes?: number }
    | { kind: "memory" }
    | { kind: "none" };
  transport?: { kind: "platform" } | { kind: "fetch"; rewriteHead?: boolean };
  index?: {
    indexUrl?: string;
    extraIndexUrls?: string[];
    indexStrategy?: "first-index" | "unsafe-first-match" | "unsafe-best-match";
    pyodideIndex?: string;
  };
  env?: Record<string, string>;
  cwd?: string;
  logFilter?: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  tty?: TtyConfig;
  stdout?: (chunk: Uint8Array) => void;
  stderr?: (chunk: Uint8Array) => void;
  stdin?: Uint8Array | string;
  promptPolicy?: PromptPolicy;
  signal?: AbortSignal;
  onEvent?: (event: EngineEvent) => void;
}

export interface ExecResult {
  code: number;
  cancelled: boolean;
  durationMs: number;
  error?: StructuredErrorInfo;
}

export interface ExecHandle {
  readonly id: string;
  readonly exit: Promise<ExecResult>;
  resize(size: TtySize): void;
  cancel(reason?: string): void;
}

export interface EngineOptions {
  endpoint?: EndpointFactory;
  config?: EngineConfigInput;
  onEvent?: (event: EngineEvent) => void;
  handshakeTimeoutMs?: number;
  workerUrl?: URL | string;
}

export interface HookInvocation {
  script: string;
  cwd: string;
  env: Record<string, string>;
  sitePackages: string[];
  trees: HookTree[];
}

export interface HookOutcome {
  stdout: string[];
  stderr: string[];
  code: number;
  writes: HookWrite[];
}

export type RuntimeHandler = (invocation: HookInvocation) => Promise<HookOutcome>;

export interface Engine {
  readonly build: BuildIdentity;
  readonly pip: ReturnType<typeof createPipApi>;
  readonly venv: ReturnType<typeof createVenvApi>;
  exec(argv: string[], options?: ExecOptions): ExecHandle;
  exportTree(path: string): Promise<ExportedTree>;
  attachRuntime(handler: RuntimeHandler): () => void;
  onEvent(listener: (event: EngineEvent) => void): () => void;
  dispose(): Promise<void>;
  terminate(): void;
}

interface PendingInvocation {
  options: ExecOptions;
  resolve(result: ExecResult): void;
  reject(error: unknown): void;
  detach(): void;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;

function encodeStdin(stdin: Uint8Array | string): Uint8Array {
  const bytes = typeof stdin === "string" ? new TextEncoder().encode(stdin) : stdin;
  if (bytes.byteLength > MAX_STDIN_BYTES) {
    throw new RangeError(
      `standard input is ${bytes.byteLength} bytes, which exceeds the ${MAX_STDIN_BYTES}-byte limit`,
    );
  }
  return bytes;
}

export async function createEngine(options: EngineOptions = {}): Promise<Engine> {
  const factory: EndpointFactory =
    options.endpoint ??
    (() => workerEndpoint(options.workerUrl ?? new URL("./worker.js", import.meta.url)));

  const endpoint = await factory();
  const listeners = new Set<(event: EngineEvent) => void>();
  const invocations = new Map<string, PendingInvocation>();
  const exports = new Map<string, (outcome: ExportTreeResultMessage["outcome"]) => void>();

  let invocationCounter = 0;
  let exportCounter = 0;
  let disposed = false;
  let runtimeHandler: RuntimeHandler | undefined;

  const describe = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  const answerHook = async (message: HookRequestMessage): Promise<void> => {
    const handler = runtimeHandler;
    if (!handler) {
      endpoint.postMessage({
        type: "hookResult",
        id: message.id,
        outcome: {
          ok: false,
          error: {
            code: "no-runtime-attached",
            message: "no Python runtime is attached to this engine",
          },
        },
      });
      return;
    }
    try {
      const outcome = await handler({
        script: message.script,
        cwd: message.cwd,
        env: message.env,
        sitePackages: message.sitePackages,
        trees: message.trees,
      });
      endpoint.postMessage({
        type: "hookResult",
        id: message.id,
        outcome: { ok: true, ...outcome },
      });
    } catch (error) {
      endpoint.postMessage({
        type: "hookResult",
        id: message.id,
        outcome: { ok: false, error: { code: "build-failed", message: describe(error) } },
      });
    }
  };

  const dispatchEvent = (event: EngineEvent, scoped?: (event: EngineEvent) => void): void => {
    scoped?.(event);
    options.onEvent?.(event);
    for (const listener of listeners) {
      listener(event);
    }
  };

  const failAll = (error: Error): void => {
    for (const invocation of [...invocations.values()]) {
      invocation.detach();
      invocation.reject(error);
    }
    invocations.clear();
    for (const settle of [...exports.values()]) {
      settle({ ok: false, error: { code: "engine-crashed", message: error.message } });
    }
    exports.clear();
  };

  const handshake = new Promise<BuildIdentity>((resolve, reject) => {
    const timer = setTimeout(() => {
      endpoint.removeEventListener("message", onMessage);
      reject(new EngineCrashedError("engine did not complete the handshake in time"));
    }, options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);

    function onMessage(event: { data: unknown }): void {
      let message: WorkerMessage;
      try {
        message = parseWorkerMessage(event.data);
      } catch {
        return;
      }
      if (message.type !== "initResult") {
        return;
      }
      clearTimeout(timer);
      endpoint.removeEventListener("message", onMessage);
      if (!message.outcome.ok) {
        reject(toEngineError(message.outcome.error));
        return;
      }
      if (message.outcome.build.protocol !== PROTOCOL_VERSION) {
        reject(
          new ProtocolMismatchError(
            `host speaks protocol ${PROTOCOL_VERSION}, engine speaks ${message.outcome.build.protocol}`,
          ),
        );
        return;
      }
      resolve(message.outcome.build);
    }

    endpoint.addEventListener("message", onMessage);
    endpoint.postMessage({
      type: "init",
      id: "init-1",
      protocolVersion: PROTOCOL_VERSION,
      config: options.config ?? {},
    });
  });

  const build = await handshake;

  const routeMessage = (event: { data: unknown }): void => {
    let message: WorkerMessage;
    try {
      message = parseWorkerMessage(event.data);
    } catch {
      return;
    }

    if (message.type === "fatal") {
      failAll(new EngineCrashedError(message.message, message.stack));
      return;
    }

    if (message.type === "event") {
      const invocationId = (message.event as { invocationId?: string }).invocationId;
      const scoped = invocationId ? invocations.get(invocationId)?.options.onEvent : undefined;
      dispatchEvent(message.event, scoped);
      return;
    }

    if (message.type === "bootProgress" || message.type === "initResult") {
      return;
    }

    if (message.type === "exportTreeResult") {
      exports.get(message.id)?.(message.outcome);
      exports.delete(message.id);
      return;
    }

    if (message.type === "hookRequest") {
      void answerHook(message);
      return;
    }

    const invocation = invocations.get(message.invocationId);
    if (!invocation) {
      return;
    }

    switch (message.type) {
      case "output": {
        const sink =
          message.stream === "stdout" ? invocation.options.stdout : invocation.options.stderr;
        sink?.(message.data);
        endpoint.postMessage({
          type: "ack",
          invocationId: message.invocationId,
          stream: message.stream,
          bytes: message.data.byteLength,
        });
        return;
      }
      case "exit": {
        invocation.detach();
        invocations.delete(message.invocationId);
        invocation.resolve({
          code: message.code,
          cancelled: message.cancelled,
          durationMs: message.durationMs,
          ...(message.error === undefined ? {} : { error: message.error }),
        });
        return;
      }
    }
  };

  endpoint.addEventListener("message", routeMessage);

  const exec = (argv: string[], execOptions: ExecOptions = {}): ExecHandle => {
    if (disposed) {
      throw new EngineCrashedError("engine has been disposed");
    }

    const stdin = execOptions.stdin === undefined ? undefined : encodeStdin(execOptions.stdin);

    invocationCounter += 1;
    const invocationId = `inv-${invocationCounter}`;

    let settle: (result: ExecResult) => void = () => {};
    let fail: (error: unknown) => void = () => {};
    const exit = new Promise<ExecResult>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });

    const cancel = (reason?: string): void => {
      endpoint.postMessage({
        type: "cancel",
        invocationId,
        ...(reason === undefined ? {} : { reason }),
      });
    };

    const onAbort = () => cancel(String(execOptions.signal?.reason ?? "aborted"));
    execOptions.signal?.addEventListener("abort", onAbort, { once: true });

    invocations.set(invocationId, {
      options: execOptions,
      resolve: settle,
      reject: fail,
      detach: () => execOptions.signal?.removeEventListener("abort", onAbort),
    });

    endpoint.postMessage({
      type: "exec",
      invocationId,
      argv,
      cwd: execOptions.cwd ?? options.config?.cwd ?? DEFAULT_CWD,
      ...(execOptions.env === undefined ? {} : { env: execOptions.env }),
      ...(execOptions.tty === undefined ? {} : { tty: execOptions.tty }),
      ...(stdin === undefined ? {} : { stdin }),
      ...(execOptions.promptPolicy === undefined ? {} : { promptPolicy: execOptions.promptPolicy }),
    });

    if (execOptions.signal?.aborted) {
      cancel("aborted");
    }

    return {
      id: invocationId,
      exit,
      resize(size: TtySize) {
        endpoint.postMessage({ type: "resize", invocationId, size });
      },
      cancel,
    };
  };

  const engine: Engine = {
    build,
    get pip() {
      return createPipApi(engine);
    },
    get venv() {
      return createVenvApi(engine);
    },
    exec,
    exportTree(path) {
      if (disposed) {
        return Promise.reject(new EngineCrashedError("engine disposed"));
      }
      exportCounter += 1;
      const id = `x${exportCounter}`;
      return new Promise<ExportedTree>((resolve, reject) => {
        exports.set(id, (outcome) => {
          if (outcome.ok) {
            resolve({ entries: outcome.entries, bytes: outcome.bytes });
          } else {
            reject(toEngineError(outcome.error));
          }
        });
        endpoint.postMessage({ type: "exportTree", id, path });
      });
    },
    attachRuntime(handler) {
      runtimeHandler = handler;
      endpoint.postMessage({ type: "attachRuntime" });
      return () => {
        if (runtimeHandler !== handler) {
          return;
        }
        runtimeHandler = undefined;
        endpoint.postMessage({ type: "detachRuntime" });
      };
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const [invocationId] of invocations) {
        endpoint.postMessage({ type: "cancel", invocationId, reason: "engine disposed" });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      endpoint.postMessage({ type: "dispose" });
      endpoint.removeEventListener("message", routeMessage);
      endpoint.terminate();
      failAll(new EngineCrashedError("engine disposed while the command was still running"));
    },
    terminate() {
      disposed = true;
      endpoint.removeEventListener("message", routeMessage);
      endpoint.terminate();
      failAll(new EngineCrashedError("engine terminated"));
    },
  };

  return engine;
}

export type { EngineEndpoint } from "./endpoint.js";
export { EXIT_CODE_CANCELLED };
