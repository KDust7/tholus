import {
  type CacheSpec,
  EXIT_CODE_CANCELLED,
  type HostMessage,
  PROTOCOL_VERSION,
  parseHostMessage,
  type StructuredErrorInfo,
  type WorkerMessage,
} from "@uv-wasm/engine-protocol";
import { cacheRoot, resolveEnvironment } from "./config-env.js";
import { interpreterAbiTag } from "./interpreter.js";
import { type ColdStore, openColdStore } from "./opfs-store.js";
import { createPersistence, type LockRunner, type Persistence, webLocks } from "./persistence.js";

export interface EngineHandle {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  setTermSize(columns: number, rows: number): void;
  clearTerm(): void;
  isRunning(): boolean;
  envReplace(entries: string[]): void;
  cancel(): boolean;
  setCwd(path: string): void;
  setStdin(bytes: Uint8Array): void;
  clearStdin(): void;
  fsRead(path: string): Uint8Array;
  fsWrite(path: string, contents: Uint8Array): void;
  fsReadDir(path: string): string[];
  fsKind(path: string): string | undefined;
  fsSize(path: string): number;
  fsReadLink(path: string): string;
  fsSymlink(target: string, link: string): void;
  fsMkdirp(path: string): void;
}

export type OpfsCacheSpec = Extract<CacheSpec, { kind: "opfs" }>;

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
  coldStore?: (spec: OpfsCacheSpec) => Promise<ColdStore>;
  lock?: LockRunner;
}

const openOriginStore = async (spec: OpfsCacheSpec): Promise<ColdStore> =>
  openColdStore(await navigator.storage.getDirectory(), spec.scope);

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
  let persistence: Persistence | undefined;

  const emit = (message: WorkerMessage): void => {
    if (!disposed) {
      options.emit(message);
    }
  };

  const warn = (message: string): void => {
    emit({ type: "event", event: { type: "log", level: "warn", message } });
  };

  const attachPersistence = async (
    handle: EngineHandle,
    spec: OpfsCacheSpec,
    env: Record<string, string>,
  ): Promise<void> => {
    const store = await (options.coldStore ?? openOriginStore)(spec);
    persistence = createPersistence({
      store,
      vfs: handle,
      root: cacheRoot(env),
      abiTag: spec.abiTag ?? interpreterAbiTag(handle),
      lock: options.lock ?? webLocks,
      now,
      ...(spec.budgetBytes === undefined ? {} : { budgetBytes: spec.budgetBytes }),
    });
    const report = await persistence.hydrate();
    if (report.missing.length > 0) {
      warn(
        `the cold store had lost ${report.missing.length} cached file(s); uv will fetch them again`,
      );
    }
  };

  const flushCache = async (): Promise<void> => {
    if (!persistence) {
      return;
    }
    try {
      const report = await persistence.flush();
      if (report.failed.length > 0) {
        warn(
          `the cold store rejected ${report.failed.length} cached file(s); the cache is partial`,
        );
      }
    } catch (error) {
      warn(`the cache could not be saved: ${describe(error)}`);
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
    let resolvedEnv: Record<string, string>;
    try {
      resolvedEnv = resolveEnvironment(message.config);
    } catch (error) {
      emit({
        type: "initResult",
        id: message.id,
        outcome: {
          ok: false,
          error: { code: "invalid-config", message: describe(error) },
        },
      });
      return;
    }

    try {
      booting ??= boot();
      const handle = await booting;
      baseEnv = resolvedEnv;
      baseCwd = message.config.cwd;
      handle.envReplace(flatten(baseEnv));
      if (message.config.cache.kind === "opfs") {
        try {
          await attachPersistence(handle, message.config.cache, resolvedEnv);
        } catch (error) {
          persistence = undefined;
          warn(`the cache could not be restored: ${describe(error)}`);
        }
      }
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
    if (message.stdin === undefined) {
      engine.clearStdin();
    } else {
      engine.setStdin(message.stdin);
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
      if (code === 0 && !invocation.cancelled) {
        await flushCache();
      }
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
