import {
  EXIT_CODE_CANCELLED,
  type HostMessage,
  PROTOCOL_VERSION,
  parseHostMessage,
  type StructuredErrorInfo,
  type WorkerMessage,
} from "@uv-wasm/engine-protocol";

export interface EngineHandle {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  setTermSize(columns: number, rows: number): void;
  clearTerm(): void;
  isRunning(): boolean;
  envReplace(entries: string[]): void;
  cancel(): boolean;
  setCwd(path: string): void;
}

export interface EngineExports {
  default: (options?: unknown) => Promise<unknown>;
  version: () => string;
  buildInfo: () => string;
  Engine: new () => EngineHandle;
}

export interface EngineWorkerOptions {
  load: () => Promise<EngineExports>;
  emit: (message: WorkerMessage) => void;
  now?: () => number;
  wasm?: () => Promise<BufferSource | URL> | BufferSource | URL;
}

export interface EngineWorker {
  receive(raw: unknown): void;
  readonly settled: Promise<void>;
}

interface Running {
  cancelled: boolean;
  seq: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unsupported(message: string): StructuredErrorInfo {
  return { code: "unsupported", message };
}

function flatten(env: Record<string, string>): string[] {
  return Object.entries(env).flat();
}

export function createEngineWorker(options: EngineWorkerOptions): EngineWorker {
  const now = options.now ?? (() => Date.now());
  const running = new Map<string, Running>();
  const cancelled = new Set<string>();
  let engine: EngineHandle | undefined;
  let booting: Promise<EngineHandle> | undefined;
  let baseEnv: Record<string, string> = {};
  let baseCwd: string | undefined;
  let queue: Promise<void> = Promise.resolve();
  let disposed = false;

  const emit = (message: WorkerMessage): void => {
    if (!disposed) {
      options.emit(message);
    }
  };

  const boot = async (): Promise<EngineHandle> => {
    emit({ type: "bootProgress", phase: "compile-start" });
    const started = now();
    const exports = await options.load();
    emit({ type: "bootProgress", phase: "compile-done", ms: now() - started });
    emit({ type: "bootProgress", phase: "init-start" });
    await exports.default(options.wasm ? { module_or_path: await options.wasm() } : undefined);
    const handle = new exports.Engine();
    engine = handle;
    emit({ type: "bootProgress", phase: "ready", ms: now() - started });
    return handle;
  };

  const initialize = async (message: Extract<HostMessage, { type: "init" }>): Promise<void> => {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      emit({
        type: "initResult",
        id: message.id,
        outcome: {
          ok: false,
          error: {
            code: "protocol-mismatch",
            message: `engine speaks protocol ${PROTOCOL_VERSION}, host speaks ${message.protocolVersion}`,
          },
        },
      });
      return;
    }
    try {
      booting ??= boot();
      const handle = await booting;
      baseEnv = message.config.env;
      baseCwd = message.config.cwd;
      handle.envReplace(flatten(baseEnv));
      const exports = await options.load();
      const build = JSON.parse(exports.buildInfo()) as {
        engine: string;
        uv: string;
        protocol: string;
      };
      emit({ type: "initResult", id: message.id, outcome: { ok: true, build } });
    } catch (error) {
      booting = undefined;
      emit({
        type: "initResult",
        id: message.id,
        outcome: {
          ok: false,
          error: { code: "engine-crashed", message: describe(error) },
        },
      });
    }
  };

  const execute = async (message: Extract<HostMessage, { type: "exec" }>): Promise<void> => {
    const invocation: Running = { cancelled: cancelled.delete(message.invocationId), seq: 0 };
    running.set(message.invocationId, invocation);
    const started = now();

    const fail = (error: StructuredErrorInfo, code: number): void => {
      running.delete(message.invocationId);
      emit({
        type: "exit",
        invocationId: message.invocationId,
        code,
        cancelled: false,
        durationMs: now() - started,
        error,
      });
    };

    if (invocation.cancelled) {
      running.delete(message.invocationId);
      emit({
        type: "exit",
        invocationId: message.invocationId,
        code: EXIT_CODE_CANCELLED,
        cancelled: true,
        durationMs: now() - started,
      });
      return;
    }

    if (!engine) {
      fail(unsupported("the engine is not initialized; send `init` first"), 1);
      return;
    }
    if (message.stdin) {
      fail(unsupported("stdin is not implemented by this engine build"), 1);
      return;
    }

    if (message.tty) {
      engine.setTermSize(message.tty.cols, message.tty.rows);
    } else {
      engine.clearTerm();
    }

    engine.envReplace(
      flatten(message.env === undefined ? baseEnv : { ...baseEnv, ...message.env }),
    );

    const cwd = message.cwd ?? baseCwd;
    if (cwd !== undefined) {
      try {
        engine.setCwd(cwd);
      } catch (error) {
        fail(unsupported(describe(error)), 1);
        return;
      }
    }

    try {
      const code = await engine.invoke(message.argv, (stream, data) => {
        if (stream !== "stdout" && stream !== "stderr") {
          return;
        }
        emit({
          type: "output",
          invocationId: message.invocationId,
          stream,
          seq: invocation.seq,
          data,
        });
        invocation.seq += 1;
      });
      running.delete(message.invocationId);
      emit({
        type: "exit",
        invocationId: message.invocationId,
        code: invocation.cancelled ? EXIT_CODE_CANCELLED : code,
        cancelled: invocation.cancelled,
        durationMs: now() - started,
      });
    } catch (error) {
      fail({ code: "engine-crashed", message: describe(error) }, 1);
      emit({ type: "fatal", message: describe(error) });
    }
  };

  const enqueue = (task: () => Promise<void>): void => {
    queue = queue.then(task, task);
  };

  const handle = (message: HostMessage): void => {
    switch (message.type) {
      case "init":
        enqueue(() => initialize(message));
        return;
      case "exec":
        enqueue(() => execute(message));
        return;
      case "cancel": {
        const invocation = running.get(message.invocationId);
        if (invocation) {
          invocation.cancelled = true;
          engine?.cancel();
        } else {
          cancelled.add(message.invocationId);
        }
        return;
      }
      case "resize": {
        engine?.setTermSize(message.size.cols, message.size.rows);
        return;
      }
      case "stdinResponse":
      case "ack":
        return;
      case "dispose":
        disposed = true;
        return;
    }
  };

  return {
    receive(raw: unknown): void {
      if (disposed) {
        return;
      }
      try {
        handle(parseHostMessage(raw));
      } catch (error) {
        emit({ type: "fatal", message: describe(error) });
      }
    },
    get settled(): Promise<void> {
      return queue;
    },
  };
}
