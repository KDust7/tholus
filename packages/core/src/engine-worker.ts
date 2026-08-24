import {
  type CacheSpec,
  type EngineEvent,
  EXIT_CODE_CANCELLED,
  type HostMessage,
  PROTOCOL_VERSION,
  type ProxyTransport,
  parseHostMessage,
  type StructuredErrorInfo,
  type WorkerMessage,
} from "@tholus/engine-protocol";
import { createFetchTransport } from "@tholus/transport-fetch";
import { createLibcurlTransport, type LibcurlModule } from "@tholus/transport-libcurl";
import { PROGRAM_NAME } from "./brand.js";
import { cacheRoot, resolveEnvironment } from "./config-env.js";
import { exportTree } from "./export-tree.js";
import {
  applyHookWrites,
  hookTrees,
  type RuntimeHookRequest,
  sitePackagesOf,
} from "./hook-bridge.js";
import { assertInterpreter, interpreterAbiTag } from "./interpreter.js";
import { type ColdStore, openColdStore } from "./opfs-store.js";
import {
  createPersistence,
  type LockRunner,
  originQuota,
  type Persistence,
  type StorageRoom,
  webLocks,
} from "./persistence.js";
import { createReportReader } from "./report-events.js";

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
  fsRemove(path: string): void;
  fsRemoveDir(path: string): void;
  attachRuntime(runHook: (request: RuntimeHookRequest) => Promise<RuntimeHookOutput>): void;
  detachRuntime(): void;
  hasRuntime(): boolean;
}

export interface RuntimeHookOutput {
  stdout: string[];
  stderr: string[];
  code: number;
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
  quota?: () => Promise<StorageRoom | undefined>;
  installFetch?: (fetch: typeof globalThis.fetch) => void;
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

interface PendingHook {
  resolve(output: RuntimeHookOutput): void;
  reject(error: unknown): void;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unsupported(message: string): StructuredErrorInfo {
  return { code: "unsupported", message };
}

async function loadLibcurl(moduleUrl: string): Promise<LibcurlModule> {
  const specifier = moduleUrl;
  const namespace = (await import(specifier)) as {
    libcurl?: LibcurlModule;
    default?: LibcurlModule;
  };
  return namespace.libcurl ?? namespace.default ?? (namespace as unknown as LibcurlModule);
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
  let runtimeWanted = false;
  let hookCounter = 0;
  let releaseTransport: (() => Promise<void>) | undefined;
  const hooks = new Map<string, PendingHook>();

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
      quota: options.quota ?? originQuota,
      now,
      ...(spec.budgetBytes === undefined ? {} : { budgetBytes: spec.budgetBytes }),
    });
    const report = await persistence.hydrate();
    if (report.missing.length > 0) {
      warn(
        `the cold store had lost ${report.missing.length} cached file(s); uv will fetch them again`,
      );
    }
    if (report.evicted.length > 0) {
      warn(
        `the stored cache was over its budget, so ${report.evicted.length} cached file(s) were ` +
          "given up; uv will fetch them again if it needs them",
      );
    }
    if (report.orphaned.length > 0) {
      warn(
        `the cold store would not delete ${report.orphaned.length} evicted file(s); they are no ` +
          "longer used but still take up room",
      );
    }
  };

  const flushCache = async (): Promise<void> => {
    if (!persistence) {
      return;
    }
    try {
      const report = await persistence.flush();
      if (report.quotaExceeded) {
        persistence = undefined;
        warn(
          "the browser is out of storage, so uv's cache will not be saved for the rest of this " +
            "session; it still works in memory",
        );
        return;
      }
      if (report.nearQuota) {
        warn("the origin is nearly out of storage; uv's cache may stop being saved");
      }
      if (report.failed.length > 0) {
        warn(
          `the cold store rejected ${report.failed.length} cached file(s); the packages they ` +
            "belong to were not saved",
        );
      }
    } catch (error) {
      warn(`the cache could not be saved: ${describe(error)}`);
    }
  };

  const runHook = (request: RuntimeHookRequest): Promise<RuntimeHookOutput> => {
    const handle = engine;
    if (!handle) {
      return Promise.reject(new Error("the engine is not initialized"));
    }
    hookCounter += 1;
    const id = `h${hookCounter}`;
    let trees: ReturnType<typeof hookTrees>;
    let sitePackages: string[];
    try {
      trees = hookTrees(handle, request);
      sitePackages = sitePackagesOf(handle, request.venv);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<RuntimeHookOutput>((resolve, reject) => {
      hooks.set(id, { resolve, reject });
      emit({
        type: "hookRequest",
        id,
        script: request.script,
        cwd: request.sourceTree,
        env: request.env,
        sitePackages,
        trees,
      });
    });
  };

  const settleHook = (message: Extract<HostMessage, { type: "hookResult" }>): void => {
    const waiter = hooks.get(message.id);
    if (!waiter) {
      return;
    }
    hooks.delete(message.id);
    if (!message.outcome.ok) {
      waiter.reject(new Error(message.outcome.error.message));
      return;
    }
    const handle = engine;
    if (!handle) {
      waiter.reject(new Error("the engine went away while the hook was running"));
      return;
    }
    try {
      applyHookWrites(handle, message.outcome.writes);
    } catch (error) {
      waiter.reject(error);
      return;
    }
    waiter.resolve({
      stdout: message.outcome.stdout,
      stderr: message.outcome.stderr,
      code: message.outcome.code,
    });
  };

  const setRuntime = (attached: boolean): void => {
    runtimeWanted = attached;
    if (!engine) {
      return;
    }
    if (attached) {
      engine.attachRuntime(runHook);
    } else {
      engine.detachRuntime();
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

    if (message.config.transport.kind !== "platform") {
      const spec = message.config.transport;
      let transport: ProxyTransport;
      try {
        transport =
          spec.kind === "fetch"
            ? createFetchTransport({
                fetch: globalThis.fetch.bind(globalThis),
                ...(spec.rewriteHead === undefined ? {} : { rewriteHead: spec.rewriteHead }),
              })
            : createLibcurlTransport({
                load: () => loadLibcurl(spec.moduleUrl),
                relayUrl: spec.relayUrl,
                ...(spec.wasmUrl === undefined ? {} : { wasmUrl: spec.wasmUrl }),
                ...(spec.userAgent === undefined ? {} : { userAgent: spec.userAgent }),
                ...(spec.maxConnections === undefined
                  ? {}
                  : { maxConnections: spec.maxConnections }),
                ...(spec.connectionCache === undefined
                  ? {}
                  : { connectionCache: spec.connectionCache }),
                ...(spec.connectionsPerHost === undefined
                  ? {}
                  : { connectionsPerHost: spec.connectionsPerHost }),
              });
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
      const disposable = transport as { dispose?: () => Promise<void> };
      if (typeof disposable.dispose === "function") {
        releaseTransport = () => disposable.dispose?.() ?? Promise.resolve();
      }
      const install =
        options.installFetch ??
        ((replacement: typeof globalThis.fetch) => {
          globalThis.fetch = replacement;
        });
      install((async (input: string | Request, init?: RequestInit) => {
        const response = await transport.fetch(input, init);
        const length = response.headers.get("content-length");
        emit({
          type: "event",
          event: {
            type: "request",
            method: (
              init?.method ?? (input instanceof Request ? input.method : "GET")
            ).toUpperCase(),
            url: input instanceof Request ? input.url : input,
            status: response.status,
            fromCache: false,
            ...(length === null || Number.isNaN(Number(length))
              ? {}
              : { bytes: Math.max(0, Number(length)) }),
          },
        });
        return response;
      }) as unknown as typeof globalThis.fetch);
    }

    try {
      booting ??= boot();
      const handle = await booting;
      baseEnv = resolvedEnv;
      baseCwd = message.config.cwd;
      handle.envReplace(flatten(baseEnv));
      if (runtimeWanted) {
        handle.attachRuntime(runHook);
      }
      try {
        assertInterpreter(handle);
      } catch (error) {
        emit({
          type: "initResult",
          id: message.id,
          outcome: { ok: false, error: { code: "invalid-config", message: describe(error) } },
        });
        return;
      }
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

    const reader = createReportReader(message.invocationId);
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const report = (events: EngineEvent[]): void => {
      for (const event of events) {
        emit({ type: "event", event });
      }
    };

    try {
      const code = await engine.invoke([PROGRAM_NAME, ...message.argv], (stream, data) => {
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
        if (stream === "stderr") {
          report(reader.push(decoder.decode(data, { stream: true })));
        }
      });
      report(reader.flush());
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
      case "attachRuntime":
        setRuntime(true);
        return;
      case "detachRuntime":
        setRuntime(false);
        return;
      case "hookResult":
        settleHook(message);
        return;
      case "dispose": {
        disposed = true;
        for (const [id, waiter] of [...hooks]) {
          hooks.delete(id);
          waiter.reject(new Error("the engine was disposed while a build hook was running"));
        }
        const release = releaseTransport;
        releaseTransport = undefined;
        void release?.().catch(() => undefined);
        return;
      }
      case "exportTree":
        enqueue(async () => {
          const handle = engine;
          if (!handle) {
            emit({
              type: "exportTreeResult",
              id: message.id,
              outcome: {
                ok: false,
                error: { code: "invalid-config", message: "the engine is not initialized" },
              },
            });
            return;
          }
          try {
            const { entries, bytes } = exportTree(handle, message.path);
            emit({
              type: "exportTreeResult",
              id: message.id,
              outcome: { ok: true, entries, bytes },
            });
          } catch (error) {
            emit({
              type: "exportTreeResult",
              id: message.id,
              outcome: { ok: false, error: { code: "unsupported", message: describe(error) } },
            });
          }
        });
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
