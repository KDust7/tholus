# @uv-wasm/core

123 public exports.

```ts
export declare function applyHookWrites(vfs: HookVfs, writes: readonly HookWrite[]): void;

export declare function assertInterpreter(vfs: ProfileReader, path?: string): void;

BROWSER_PYTHON = "/bin/python3"

export declare class BuildFailedError extends EngineError {
    readonly code: "build-failed";
}

CACHE_DIRECTORY = "cache"

CACHE_LOCK = "uv-wasm-cache"

export type CacheEntry = {
    kind: "file";
    path: string;
    size: number;
} | {
    kind: "symlink";
    path: string;
    target: string;
};

export declare function cacheUnit(path: string): string;

export interface CacheVfs {
    fsReadDir(path: string): string[];
    fsKind(path: string): string | undefined;
    fsSize(path: string): number;
    fsReadLink(path: string): string;
}

export declare class CancelledError extends EngineError {
    readonly code: "cancelled";
}

export declare function checkInterpreter(profile: InterpreterProfile): string[];

export interface ColdStore {
    readManifest(): Promise<string | undefined>;
    writeManifest(raw: string): Promise<void>;
    read(path: string): Promise<Uint8Array | undefined>;
    write(path: string, bytes: Uint8Array): Promise<void>;
    remove(path: string): Promise<void>;
}

export declare function collectText(): {
    sink: (chunk: Uint8Array) => void;
    text: () => string;
};

export interface CommandOptions {
    cwd?: string;
    env?: Record<string, string>;
    venv?: string;
    signal?: AbortSignal;
    onEvent?: (event: EngineEvent) => void;
}

export interface CommandOutcome {
    code: number;
    stdout: string;
    stderr: string;
    events: EngineEvent[];
}

export declare function commitFlush(manifest: Manifest, live: readonly CacheEntry[], written: readonly string[], now: number): Manifest;

export interface CompileRequest extends CommandOptions {
    requirements: string[];
    constraints?: string[];
    generateHashes?: boolean;
    universal?: boolean;
    pythonVersion?: string;
    pythonPlatform?: string;
}

export interface CompileResult {
    text: string;
    events: EngineEvent[];
}

export declare function createEngine(options?: EngineOptions): Promise<Engine>;

export declare function createEngineWorker(options: EngineWorkerOptions): EngineWorker;

export declare function createPersistence(options: PersistenceOptions): Persistence;

export declare function createPipApi(engine: Engine): {
    install(request?: InstallRequest): Promise<InstallReport>;
    uninstall(packages: string[], options?: CommandOptions): Promise<InstallReport>;
    list(options?: CommandOptions): Promise<InstalledPackage[]>;
    show(packages: string[], options?: CommandOptions): Promise<PackageDetail[]>;
    freeze(options?: CommandOptions): Promise<string>;
    check(options?: CommandOptions): Promise<{
        ok: boolean;
        problems: string[];
    }>;
    compile(request: CompileRequest): Promise<CompileResult>;
    sync(request: SyncRequest): Promise<InstallReport>;
};

export declare function createReportReader(invocationId: string): ReportReader;

export declare function createVenvApi(engine: Engine): {
    create(request?: VenvRequest): Promise<{
        path: string;
    }>;
};

export declare function decodeChunks(sink: TextSink): (chunk: Uint8Array) => void;

DEFAULT_CACHE_DIR = "/cache"

DEFAULT_CWD = "/work"

export declare function emptyManifest(abiTag: string): Manifest;

export type EndpointFactory = () => EngineEndpoint | Promise<EngineEndpoint>;

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

export interface EngineConfigInput {
    fs?: {
        kind: "memory";
    } | {
        kind: "opfs";
        root?: string;
    } | {
        kind: "delegate";
    };
    cache?: {
        kind: "opfs";
        scope?: string;
        abiTag?: string;
        budgetBytes?: number;
    } | {
        kind: "memory";
    } | {
        kind: "none";
    };
    transport?: {
        kind: "platform";
    } | {
        kind: "fetch";
        rewriteHead?: boolean;
    } | {
        kind: "libcurl";
        moduleUrl: string;
        wasmUrl?: string;
        relayUrl: string;
        userAgent?: string;
        maxConnections?: number;
        connectionCache?: number;
        connectionsPerHost?: number;
    };
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

export declare class EngineCrashedError extends EngineError {
    readonly code: "engine-crashed";
}

export interface EngineEndpoint {
    postMessage(message: unknown): void;
    addEventListener(type: "message", listener: (event: {
        data: unknown;
    }) => void): void;
    removeEventListener(type: "message", listener: (event: {
        data: unknown;
    }) => void): void;
    terminate(): void;
}

export declare abstract class EngineError extends Error {
    abstract readonly code: ErrorCode;
    readonly data: unknown;
    constructor(message: string, data?: unknown);
}

export interface EngineExports {
    default: (options?: unknown) => Promise<unknown>;
    version: () => string;
    buildInfo: () => string;
    Engine: new () => EngineHandle;
}

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

export interface EngineOptions {
    endpoint?: EndpointFactory;
    config?: EngineConfigInput;
    onEvent?: (event: EngineEvent) => void;
    handshakeTimeoutMs?: number;
    workerUrl?: URL | string;
}

export interface EngineWorker {
    receive(raw: unknown): void;
    readonly settled: Promise<void>;
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

export interface ExecHandle {
    readonly id: string;
    readonly exit: Promise<ExecResult>;
    resize(size: TtySize): void;
    cancel(reason?: string): void;
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

EXIT_CODE_CANCELLED = 130

export interface ExportedTree {
    entries: TreeEntry[];
    bytes: Uint8Array;
}

export declare function exportTree(vfs: ExportVfs, root: string): ExportedTree;

export interface ExportVfs {
    fsRead(path: string): Uint8Array;
    fsReadDir(path: string): string[];
    fsKind(path: string): string | undefined;
    fsSize(path: string): number;
    fsReadLink(path: string): string;
}

export interface FlushPlan {
    writes: string[];
    deletes: string[];
}

export interface FlushReport {
    written: string[];
    removed: string[];
    failed: string[];
    quotaExceeded: boolean;
    nearQuota: boolean;
}

export declare function groupByUnit<T>(entries: readonly T[], pathOf: (entry: T) => string): Map<string, T[]>;

export declare function guard(path: string): void;

export declare class HashMismatchError extends EngineError {
    readonly code: "hash-mismatch";
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

export declare function hookTrees(vfs: ExportVfs, request: RuntimeHookRequest): HookTree[];

export type HookVfs = ExportVfs & ImportVfs & RemoveVfs;

export declare function hydrateCacheTree(vfs: HydrateVfs, root: string, entries: readonly CacheEntry[], load: LoadBlob): Promise<string[]>;

export interface HydrateReport {
    hydrated: string[];
    missing: string[];
    evicted: string[];
    orphaned: string[];
}

export interface HydrateVfs {
    fsWrite(path: string, contents: Uint8Array): void;
    fsSymlink(target: string, link: string): void;
    fsMkdirp(path: string): void;
}

export interface ImportedTree {
    files: number;
    links: number;
    bytes: number;
}

export declare function importTree(vfs: ImportVfs, root: string, entries: readonly TreeEntry[], bytes: Uint8Array): ImportedTree;

export interface ImportVfs {
    fsWrite(path: string, contents: Uint8Array): void;
    fsSymlink(target: string, link: string): void;
    fsMkdirp(path: string): void;
    fsKind(path: string): string | undefined;
}

export declare class InconsistentInterpreter extends Error {
    readonly disagreements: string[];
    constructor(path: string, disagreements: string[]);
}

export interface InstalledPackage {
    name: string;
    version: string;
}

export interface InstallReport {
    installed: PackageRef[];
    removed: PackageRef[];
    unchanged: number;
    needsRuntimeFinalize: PackageRef[];
}

export interface InstallRequest extends CommandOptions {
    packages?: string[];
    requirements?: string[];
    constraints?: string[];
    upgrade?: boolean;
    reinstall?: boolean;
    dryRun?: boolean;
    requireHashes?: boolean;
}

INTERNAL_NAME = "uv-wasm"

export declare function interpreterAbiTag(vfs: ProfileReader, path?: string): string;

export interface InterpreterProfile {
    platform?: {
        os?: {
            name?: string;
            major?: number;
            minor?: number;
        };
        arch?: string;
    };
    markers?: {
        implementation_name?: string;
        python_full_version?: string;
        python_version?: string;
    };
    stdlib?: string;
    extension_suffixes?: string[];
    scheme?: {
        purelib?: string;
    };
    virtualenv?: {
        purelib?: string;
    };
}

export declare class InvalidConfigError extends EngineError {
    readonly code: "invalid-config";
}

export declare function isReusable(manifest: Manifest, abiTag: string): boolean;

export type LoadBlob = (path: string) => Promise<Uint8Array | undefined>;

export declare function loadManifest(raw: string | undefined, abiTag: string): Manifest;

export type LockRunner = <T>(name: string, run: () => Promise<T>) => Promise<T>;

export interface Manifest {
    schemaVersion: number;
    abiTag: string;
    entries: Record<string, ManifestEntry>;
}

MANIFEST_FILE = "manifest.json"

MANIFEST_SCHEMA_VERSION = 2

export type ManifestEntry = {
    kind: "file";
    size: number;
    usedAt: number;
} | {
    kind: "symlink";
    target: string;
    usedAt: number;
};

MAX_EXPORT_BYTES: number

export declare function millisecondsOf(elapsed: string): number;

export declare class NetworkError extends EngineError {
    readonly code: "network";
}

export declare class NoRuntimeAttachedError extends EngineError {
    readonly code: "no-runtime-attached";
}

export declare function openColdStore(origin: FileSystemDirectoryHandle, scope?: string): Promise<ColdStore>;

export type OpfsCacheSpec = Extract<CacheSpec, {
    kind: "opfs";
}>;

originQuota: () => Promise<StorageRoom | undefined>

export interface PackageDetail {
    name: string;
    version: string;
    location?: string;
    requires: string[];
    requiredBy: string[];
}

export declare class PackageNotFoundError extends EngineError {
    readonly code: "package-not-found";
}

export declare function parseShow(text: string): PackageDetail[];

export interface Persistence {
    hydrate(): Promise<HydrateReport>;
    flush(): Promise<FlushReport>;
}

export interface PersistenceOptions {
    store: ColdStore;
    vfs: PersistenceVfs;
    root: string;
    abiTag: string;
    lock: LockRunner;
    now?: () => number;
    budgetBytes?: number;
    quota?: () => Promise<StorageRoom | undefined>;
}

export type PersistenceVfs = CacheVfs & HydrateVfs & {
    fsRead(path: string): Uint8Array;
};

export declare function planEviction(manifest: Manifest, budgetBytes: number): string[];

export declare function planFlush(live: readonly CacheEntry[], manifest: Manifest): FlushPlan;

export interface ProfileReader {
    fsRead(path: string): Uint8Array;
}

PROGRAM_NAME = "uv"

export declare class ProtocolMismatchError extends EngineError {
    readonly code: "protocol-mismatch";
}

QUOTA_HIGH_WATER = 0.9

QUOTA_SHARE = 0.5

export declare function readCacheTree(vfs: CacheVfs, root: string): CacheEntry[];

export interface RemoveVfs {
    fsKind(path: string): string | undefined;
    fsRemove(path: string): void;
    fsRemoveDir(path: string): void;
}

export interface ReportReader {
    push(chunk: string): EngineEvent[];
    flush(): EngineEvent[];
}

export declare class ResolutionConflictError extends EngineError {
    readonly code: "resolution-conflict";
}

export declare function runCommand(engine: Engine, argv: string[], options?: CommandOptions): Promise<CommandOutcome>;

export type RuntimeHandler = (invocation: HookInvocation) => Promise<HookOutcome>;

export interface RuntimeHookOutput {
    stdout: string[];
    stderr: string[];
    code: number;
}

export interface RuntimeHookRequest {
    venv: string;
    script: string;
    sourceTree: string;
    env: Record<string, string>;
    path: string;
    outputDir?: string;
}

export declare class RuntimeRequiredError extends EngineError {
    readonly code: "runtime-required";
}

export declare class SdistNeedsRuntimeError extends EngineError {
    readonly code: "sdist-needs-runtime";
}

export declare function sitePackagesOf(vfs: ExportVfs, venv: string): string[];

STORAGE_SCOPE = "uv-wasm"

export interface StorageRoom {
    quota: number;
    usage: number;
}

STORE_ROOT = "uv-wasm"

STORE_VERSION = "v1"

export declare function stripAnsi(text: string): string;

export interface SyncRequest extends CommandOptions {
    requirements: string[];
    requireHashes?: boolean;
}

export type TextSink = (text: string) => void;

export declare function toEngineError(info: StructuredErrorInfo): EngineError;

UNKNOWN_ABI = "unknown"

export declare class UnsupportedError extends EngineError {
    readonly code: "unsupported";
}

export interface VenvRequest extends CommandOptions {
    path?: string;
    pythonVersion?: string;
    prompt?: string;
    clear?: boolean;
}

WASM_ASSET_FILENAME = "engine_bg.wasm"

webLocks: LockRunner

WORKER_ENTRY_FILENAME = "worker.js"

export declare function workerEndpoint(url: URL | string): EngineEndpoint;
```
