import {
  EXIT_CODE_CANCELLED,
  PROTOCOL_VERSION,
  type WorkerMessage,
} from "@uv-wasm/engine-protocol";
import { describe, expect, it } from "vitest";
import {
  createEngineWorker,
  type EngineExports,
  type EngineHandle,
  type EngineWorker,
} from "./engine-worker.js";
import type { ColdStore } from "./opfs-store.js";

const encoder = new TextEncoder();

interface FakeOptions {
  profile?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  throws?: string;
  blocks?: boolean;
  rejectsCwd?: boolean;
}

type FsNode = { kind: "file"; bytes: Uint8Array } | { kind: "symlink"; target: string };

class FakeEngine implements EngineHandle {
  columns = 0;
  rows = 0;
  cleared = false;
  cancels = 0;
  readonly environments: string[][] = [];
  readonly directories: string[] = [];
  readonly stdins: (Uint8Array | undefined)[] = [];
  readonly nodes = new Map<string, FsNode>();
  readonly folders = new Set<string>();
  private release: ((code: number) => void) | undefined;

  constructor(private readonly options: FakeOptions) {
    if (options.profile !== undefined) {
      this.fsWrite("/bin/python3", encoder.encode(options.profile));
    }
  }

  private ancestors(path: string): void {
    const parts = path.split("/");
    for (let index = parts.length - 1; index > 1; index -= 1) {
      this.folders.add(parts.slice(0, index).join("/"));
    }
  }

  fsRead(path: string): Uint8Array {
    const node = this.nodes.get(path);
    if (node?.kind !== "file") {
      throw new Error(`${path} was not found`);
    }
    return node.bytes;
  }

  fsWrite(path: string, contents: Uint8Array): void {
    this.ancestors(path);
    this.nodes.set(path, { kind: "file", bytes: contents });
  }

  fsReadDir(path: string): string[] {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const known of [...this.nodes.keys(), ...this.folders]) {
      if (known.startsWith(prefix)) {
        const head = known.slice(prefix.length).split("/")[0];
        if (head !== undefined && head !== "") {
          names.add(head);
        }
      }
    }
    return [...names].sort();
  }

  fsKind(path: string): string | undefined {
    const node = this.nodes.get(path);
    if (node) {
      return node.kind === "file" ? "file" : "symlink";
    }
    return this.folders.has(path) ? "directory" : undefined;
  }

  fsSize(path: string): number {
    const node = this.nodes.get(path);
    return node?.kind === "file" ? node.bytes.byteLength : 0;
  }

  fsReadLink(path: string): string {
    const node = this.nodes.get(path);
    if (node?.kind !== "symlink") {
      throw new Error(`${path} is not a symbolic link`);
    }
    return node.target;
  }

  fsSymlink(target: string, link: string): void {
    this.ancestors(link);
    this.nodes.set(link, { kind: "symlink", target });
  }

  fsMkdirp(path: string): void {
    this.folders.add(path);
    this.ancestors(`${path}/x`);
  }

  envReplace(entries: string[]): void {
    this.environments.push(entries);
  }

  setStdin(bytes: Uint8Array): void {
    this.stdins.push(bytes);
  }

  clearStdin(): void {
    this.stdins.push(undefined);
  }

  setCwd(path: string): void {
    if (this.options.rejectsCwd) {
      throw new Error(`uv-wasm: could not enter \`${path}\``);
    }
    this.directories.push(path);
  }

  async invoke(
    _argv: string[],
    onOutput: (stream: string, data: Uint8Array) => void,
  ): Promise<number> {
    if (this.options.throws) {
      throw new Error(this.options.throws);
    }
    if (this.options.stdout) {
      onOutput("stdout", encoder.encode(this.options.stdout));
    }
    if (this.options.stderr) {
      onOutput("stderr", encoder.encode(this.options.stderr));
    }
    if (this.options.blocks) {
      return new Promise<number>((resolve) => {
        this.release = resolve;
      });
    }
    return this.options.exitCode ?? 0;
  }

  cancel(): boolean {
    this.cancels += 1;
    if (!this.release) {
      return false;
    }
    this.release(EXIT_CODE_CANCELLED);
    this.release = undefined;
    return true;
  }

  setTermSize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
  }

  clearTerm(): void {
    this.cleared = true;
  }

  isRunning(): boolean {
    return this.release !== undefined;
  }
}

class FakeColdStore implements ColdStore {
  readonly blobs = new Map<string, Uint8Array>();
  readonly calls: string[] = [];
  manifest: string | undefined;
  failWrites = false;
  failReads = false;

  async readManifest(): Promise<string | undefined> {
    this.calls.push("readManifest");
    if (this.failReads) {
      throw new Error("the cold store is unreadable");
    }
    return this.manifest;
  }

  async writeManifest(raw: string): Promise<void> {
    this.calls.push("writeManifest");
    this.manifest = raw;
  }

  async read(path: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(path);
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.calls.push(`write:${path}`);
    if (this.failWrites) {
      throw new Error("the cold store is full");
    }
    this.blobs.set(path, bytes);
  }

  async remove(path: string): Promise<void> {
    this.blobs.delete(path);
  }
}

interface Harness {
  worker: EngineWorker;
  emitted: WorkerMessage[];
  engines: FakeEngine[];
  store: FakeColdStore;
}

function harness(options: FakeOptions = {}, store = new FakeColdStore()): Harness {
  const emitted: WorkerMessage[] = [];
  const engines: FakeEngine[] = [];
  const exports = {
    default: async () => undefined,
    version: () => "uv-wasm 0.0.0 (uv 0.12.3)",
    buildInfo: () => `{"engine":"0.0.0","uv":"0.12.3","protocol":"${PROTOCOL_VERSION}"}`,
    Engine: class extends FakeEngine {
      constructor() {
        super(options);
        engines.push(this);
      }
    },
  } satisfies EngineExports;

  const worker = createEngineWorker({
    load: async () => exports,
    emit: (message) => emitted.push(message),
    now: () => 0,
    coldStore: async () => store,
    lock: (_name, run) => run(),
  });
  return { worker, emitted, engines, store };
}

async function init(test: Harness, config: Record<string, unknown> = {}): Promise<void> {
  test.worker.receive({ type: "init", id: "i1", protocolVersion: PROTOCOL_VERSION, config });
  await test.worker.settled;
}

function typesOf(emitted: WorkerMessage[]): string[] {
  return emitted.map((message) => message.type);
}

describe("the engine worker speaks the host protocol", () => {
  it("reports the build identity after booting", async () => {
    const test = harness();
    await init(test);
    expect(typesOf(test.emitted)).toEqual([
      "bootProgress",
      "bootProgress",
      "bootProgress",
      "bootProgress",
      "initResult",
    ]);
    const result = test.emitted.at(-1);
    expect(result).toMatchObject({
      type: "initResult",
      id: "i1",
      outcome: { ok: true, build: { uv: "0.12.3", protocol: PROTOCOL_VERSION } },
    });
  });

  it("refuses a host that speaks a different protocol", async () => {
    const test = harness();
    test.worker.receive({ type: "init", id: "i1", protocolVersion: "99", config: {} });
    await test.worker.settled;
    expect(test.emitted).toEqual([
      {
        type: "initResult",
        id: "i1",
        outcome: {
          ok: false,
          error: {
            code: "protocol-mismatch",
            message: `engine speaks protocol ${PROTOCOL_VERSION}, host speaks 99`,
          },
        },
      },
    ]);
  });

  it("turns engine output into sequenced output messages and an exit", async () => {
    const test = harness({ stdout: "hello\n", stderr: "warn\n", exitCode: 2 });
    await init(test);
    test.emitted.length = 0;
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv", "--help"] });
    await test.worker.settled;

    expect(test.emitted).toEqual([
      {
        type: "output",
        invocationId: "x1",
        stream: "stdout",
        seq: 0,
        data: encoder.encode("hello\n"),
      },
      {
        type: "output",
        invocationId: "x1",
        stream: "stderr",
        seq: 1,
        data: encoder.encode("warn\n"),
      },
      { type: "exit", invocationId: "x1", code: 2, cancelled: false, durationMs: 0 },
    ]);
  });

  it("refuses to exec before init rather than crashing", async () => {
    const test = harness();
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
    await test.worker.settled;
    expect(test.emitted).toEqual([
      {
        type: "exit",
        invocationId: "x1",
        code: 1,
        cancelled: false,
        durationMs: 0,
        error: { code: "unsupported", message: "the engine is not initialized; send `init` first" },
      },
    ]);
  });

  it("hands the engine the standard input the host supplied", async () => {
    const test = harness();
    await init(test);
    const stdin = encoder.encode("anyio\n");
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"], stdin });
    await test.worker.settled;
    expect(test.engines[0]?.stdins).toEqual([stdin]);
  });

  it("clears standard input when the host supplies none, so it cannot leak forward", async () => {
    const test = harness();
    await init(test);
    test.worker.receive({
      type: "exec",
      invocationId: "x1",
      argv: ["uv"],
      stdin: encoder.encode("a"),
    });
    await test.worker.settled;
    test.worker.receive({ type: "exec", invocationId: "x2", argv: ["uv"] });
    await test.worker.settled;
    expect(test.engines[0]?.stdins).toEqual([encoder.encode("a"), undefined]);
  });

  it("passes an empty buffer through rather than treating it as absent", async () => {
    const test = harness();
    await init(test);
    test.worker.receive({
      type: "exec",
      invocationId: "x1",
      argv: ["uv"],
      stdin: new Uint8Array(0),
    });
    await test.worker.settled;
    expect(test.engines[0]?.stdins).toEqual([new Uint8Array(0)]);
  });

  it("declares a terminal when the host attaches one", async () => {
    const test = harness();
    await init(test);
    test.worker.receive({
      type: "exec",
      invocationId: "x1",
      argv: ["uv"],
      tty: { cols: 120, rows: 40 },
    });
    await test.worker.settled;
    expect(test.engines[0]).toMatchObject({ columns: 120, rows: 40 });
  });

  it("clears the terminal when the host attaches none", async () => {
    const test = harness();
    await init(test);
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
    await test.worker.settled;
    expect(test.engines[0]?.cleared).toBe(true);
  });

  it("resizes an attached terminal", async () => {
    const test = harness();
    await init(test);
    test.worker.receive({ type: "resize", invocationId: "x1", size: { cols: 200, rows: 50 } });
    expect(test.engines[0]).toMatchObject({ columns: 200, rows: 50 });
  });

  it("never starts an invocation cancelled before it ran", async () => {
    const test = harness({ stdout: "partial" });
    await init(test);
    test.emitted.length = 0;
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
    test.worker.receive({ type: "cancel", invocationId: "x1" });
    await test.worker.settled;
    expect(test.emitted).toEqual([
      { type: "exit", invocationId: "x1", code: 130, cancelled: true, durationMs: 0 },
    ]);
  });

  it("cancels only the invocation it names", async () => {
    const test = harness({ stdout: "partial" });
    await init(test);
    test.emitted.length = 0;
    test.worker.receive({ type: "exec", invocationId: "a", argv: ["uv"] });
    test.worker.receive({ type: "exec", invocationId: "b", argv: ["uv"] });
    test.worker.receive({ type: "cancel", invocationId: "b" });
    await test.worker.settled;
    expect(test.emitted).toEqual([
      {
        type: "output",
        invocationId: "a",
        stream: "stdout",
        seq: 0,
        data: encoder.encode("partial"),
      },
      { type: "exit", invocationId: "a", code: 0, cancelled: false, durationMs: 0 },
      { type: "exit", invocationId: "b", code: 130, cancelled: true, durationMs: 0 },
    ]);
  });

  it("enters the working directory the config named", async () => {
    const test = harness();
    await init(test, { cwd: "/work" });
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
    await test.worker.settled;
    expect(test.engines[0]?.directories).toEqual(["/work"]);
  });

  it("lets an invocation name a working directory of its own", async () => {
    const test = harness();
    await init(test, { cwd: "/work" });
    test.worker.receive({
      type: "exec",
      invocationId: "x1",
      argv: ["uv"],
      cwd: "/elsewhere",
    });
    test.worker.receive({ type: "exec", invocationId: "x2", argv: ["uv"] });
    await test.worker.settled;
    expect(test.engines[0]?.directories).toEqual(["/elsewhere", "/work"]);
  });

  it("reports a working directory it cannot enter as a failed invocation", async () => {
    const test = harness({ rejectsCwd: true });
    await init(test, { cwd: "/missing" });
    test.emitted.length = 0;
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
    await test.worker.settled;
    expect(test.emitted).toHaveLength(1);
    const [exit] = test.emitted;
    expect(exit?.type).toBe("exit");
    expect(exit).toMatchObject({ code: 1, cancelled: false });
  });

  it("interrupts an invocation that is already running", async () => {
    const test = harness({ blocks: true, stdout: "started" });
    await init(test);
    test.emitted.length = 0;
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
    await Promise.resolve();
    expect(test.engines[0]?.isRunning()).toBe(true);
    test.worker.receive({ type: "cancel", invocationId: "x1" });
    await test.worker.settled;
    expect(test.engines[0]?.cancels).toBe(1);
    expect(test.emitted).toEqual([
      {
        type: "output",
        invocationId: "x1",
        stream: "stdout",
        seq: 0,
        data: encoder.encode("started"),
      },
      {
        type: "exit",
        invocationId: "x1",
        code: EXIT_CODE_CANCELLED,
        cancelled: true,
        durationMs: 0,
      },
    ]);
  });

  it("does not reach for the engine when the cancelled invocation is only queued", async () => {
    const test = harness({ stdout: "partial" });
    await init(test);
    test.worker.receive({ type: "cancel", invocationId: "never-sent" });
    await test.worker.settled;
    expect(test.engines[0]?.cancels).toBe(0);
  });

  it("turns an engine crash into an exit and a fatal", async () => {
    const test = harness({ throws: "unreachable executed" });
    await init(test);
    test.emitted.length = 0;
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
    await test.worker.settled;
    expect(typesOf(test.emitted)).toEqual(["exit", "fatal"]);
    expect(test.emitted.at(-1)).toMatchObject({
      type: "fatal",
      message: "unreachable executed",
    });
  });

  it("serializes invocations rather than interleaving them", async () => {
    const test = harness({ stdout: "one" });
    await init(test);
    test.emitted.length = 0;
    test.worker.receive({ type: "exec", invocationId: "a", argv: ["uv"] });
    test.worker.receive({ type: "exec", invocationId: "b", argv: ["uv"] });
    await test.worker.settled;
    const order = test.emitted.map((message) =>
      "invocationId" in message ? message.invocationId : "",
    );
    expect(order).toEqual(["a", "a", "b", "b"]);
  });

  it("reports a malformed host message as fatal rather than throwing", () => {
    const test = harness();
    test.worker.receive({ type: "nonsense" });
    expect(test.emitted.at(-1)?.type).toBe("fatal");
  });

  it("goes silent after dispose", async () => {
    const test = harness();
    await init(test);
    test.worker.receive({ type: "dispose" });
    test.emitted.length = 0;
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
    await test.worker.settled;
    expect(test.emitted).toEqual([]);
  });
});

describe("the engine worker hands the environment to the engine", () => {
  it("installs the configured environment when it initializes", async () => {
    const test = harness();
    await init(test, { env: { HOME: "/home/browser" } });
    expect(test.engines[0]?.environments).toEqual([["HOME", "/home/browser"]]);
  });

  it("re-applies the configured environment for an invocation that names none", async () => {
    const test = harness();
    await init(test, { env: { HOME: "/home/browser" } });
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
    await test.worker.settled;
    expect(test.engines[0]?.environments.at(-1)).toEqual(["HOME", "/home/browser"]);
  });

  it("overlays an invocation's environment onto the configured one", async () => {
    const test = harness();
    await init(test, { env: { HOME: "/home/browser", UV_CACHE_DIR: "/base" } });
    test.worker.receive({
      type: "exec",
      invocationId: "x1",
      argv: ["uv"],
      env: { UV_CACHE_DIR: "/override" },
    });
    await test.worker.settled;
    expect(test.engines[0]?.environments.at(-1)).toEqual([
      "HOME",
      "/home/browser",
      "UV_CACHE_DIR",
      "/override",
    ]);
  });

  it("does not let one invocation's environment reach the next", async () => {
    const test = harness();
    await init(test, { env: { HOME: "/home/browser" } });
    test.worker.receive({
      type: "exec",
      invocationId: "x1",
      argv: ["uv"],
      env: { UV_NO_CACHE: "1" },
    });
    test.worker.receive({ type: "exec", invocationId: "x2", argv: ["uv"] });
    await test.worker.settled;
    expect(test.engines[0]?.environments.at(-1)).toEqual(["HOME", "/home/browser"]);
  });

  it("hands the configured indexes to the engine as the variables uv reads", async () => {
    const test = harness();
    await init(test, {
      env: { HOME: "/home/browser" },
      index: {
        indexUrl: "https://example.invalid/simple",
        pyodideIndex: "https://index.pyodide.org/314.0.5",
      },
    });
    expect(test.engines[0]?.environments).toEqual([
      [
        "HOME",
        "/home/browser",
        "UV_DEFAULT_INDEX",
        "https://example.invalid/simple",
        "UV_INDEX",
        "https://index.pyodide.org/314.0.5",
      ],
    ]);
  });

  it("keeps a configured index out of a later invocation's overlay", async () => {
    const test = harness();
    await init(test, { index: { pyodideIndex: "https://index.pyodide.org/314.0.5" } });
    test.worker.receive({ type: "exec", invocationId: "x1", argv: ["uv"] });
    await test.worker.settled;
    expect(test.engines[0]?.environments.at(-1)).toEqual([
      "UV_INDEX",
      "https://index.pyodide.org/314.0.5",
    ]);
  });

  it("refuses an init whose env and index config set the same variable", async () => {
    const test = harness();
    await init(test, {
      env: { UV_INDEX: "https://host.invalid" },
      index: { pyodideIndex: "https://index.pyodide.org/314.0.5" },
    });
    expect(test.emitted).toEqual([
      {
        type: "initResult",
        id: "i1",
        outcome: {
          ok: false,
          error: {
            code: "invalid-config",
            message:
              "config and config.env both set UV_INDEX; set one or the other, so it is clear which the engine obeys",
          },
        },
      },
    ]);
  });
});

describe("the worker carries uv's cache across a reload when the host asks for opfs", () => {
  const CACHE_ROOT = "/home/browser/.cache/uv";
  const opfs = { cache: { kind: "opfs" } };

  const seed = (store: FakeColdStore): void => {
    store.manifest = JSON.stringify({
      schemaVersion: 2,
      abiTag: "unknown",
      entries: { "simple-v24/idna.rkyv": { kind: "file", size: 5, usedAt: 1 } },
    });
    store.blobs.set("simple-v24/idna.rkyv", encoder.encode("index"));
  };

  const exec = async (test: Harness): Promise<void> => {
    test.worker.receive({ type: "exec", invocationId: "e1", argv: ["uv", "--version"] });
    await test.worker.settled;
  };

  it("hydrates the stored cache before it reports ready", async () => {
    const store = new FakeColdStore();
    seed(store);
    const test = harness({}, store);
    await init(test, opfs);

    expect(test.emitted.at(-1)).toMatchObject({ outcome: { ok: true } });
    const engine = test.engines[0];
    expect(engine?.fsRead(`${CACHE_ROOT}/simple-v24/idna.rkyv`)).toEqual(encoder.encode("index"));
  });

  it("leaves the cold store untouched when the cache is in memory", async () => {
    const test = harness();
    await init(test, { cache: { kind: "memory" } });
    await exec(test);
    expect(test.store.calls).toEqual([]);
  });

  it("flushes what a successful command cached", async () => {
    const test = harness();
    await init(test, opfs);
    test.engines[0]?.fsWrite(`${CACHE_ROOT}/wheels-v6/idna.whl`, encoder.encode("wheel"));
    await exec(test);

    expect(test.store.blobs.get("wheels-v6/idna.whl")).toEqual(encoder.encode("wheel"));
    expect(test.store.calls.at(-1)).toBe("writeManifest");
  });

  it("does not flush after a command that failed", async () => {
    const test = harness({ exitCode: 2 });
    await init(test, opfs);
    test.engines[0]?.fsWrite(`${CACHE_ROOT}/wheels-v6/idna.whl`, encoder.encode("wheel"));
    test.store.calls.length = 0;
    await exec(test);

    expect(test.store.calls).toEqual([]);
  });

  it("warns rather than failing init when the store cannot be read", async () => {
    const store = new FakeColdStore();
    store.failReads = true;
    const test = harness({}, store);
    await init(test, opfs);

    expect(test.emitted.at(-1)).toMatchObject({ outcome: { ok: true } });
    expect(test.emitted).toContainEqual(
      expect.objectContaining({
        type: "event",
        event: expect.objectContaining({ type: "log", level: "warn" }),
      }),
    );
  });

  it("warns rather than changing the exit code when the flush fails", async () => {
    const test = harness();
    await init(test, opfs);
    test.engines[0]?.fsWrite(`${CACHE_ROOT}/a`, encoder.encode("x"));
    test.store.failWrites = true;
    await exec(test);

    const exit = test.emitted.findLast((message) => message.type === "exit");
    expect(exit).toMatchObject({ code: 0, cancelled: false });
    expect(test.emitted).toContainEqual(
      expect.objectContaining({
        type: "event",
        event: expect.objectContaining({ type: "log", level: "warn" }),
      }),
    );
  });

  const profileFor = (release: number): string =>
    JSON.stringify({
      platform: { os: { name: "pyemscripten", major: release, minor: 0 }, arch: "wasm32" },
      markers: { implementation_name: "cpython", python_full_version: "3.14.0" },
    });

  it("keys the stored cache by the interpreter the wheels were built for", async () => {
    const test = harness({ profile: profileFor(2026) });
    await init(test, opfs);
    test.engines[0]?.fsWrite(`${CACHE_ROOT}/a`, encoder.encode("x"));
    await exec(test);

    expect(JSON.parse(test.store.manifest ?? "{}").abiTag).toBe(
      "cpython-3.14.0-pyemscripten_2026_0_wasm32",
    );
  });

  it("refuses a cache built for another interpreter rather than mixing the two", async () => {
    const store = new FakeColdStore();
    const first = harness({ profile: profileFor(2026) }, store);
    await init(first, opfs);
    first.engines[0]?.fsWrite(`${CACHE_ROOT}/a`, encoder.encode("x"));
    await exec(first);
    expect(store.blobs.has("a")).toBe(true);

    const second = harness({ profile: profileFor(2025) }, store);
    await init(second, opfs);
    expect(second.engines[0]?.fsKind(`${CACHE_ROOT}/a`)).toBeUndefined();
  });

  it("reports the exit before it spends time flushing", async () => {
    const test = harness();
    await init(test, opfs);
    test.engines[0]?.fsWrite(`${CACHE_ROOT}/a`, encoder.encode("x"));
    test.store.calls.length = 0;
    await exec(test);

    const order = test.emitted.map((message) => message.type);
    expect(order.lastIndexOf("exit")).toBeLessThan(order.length);
    expect(test.store.calls).toContain("write:a");
  });
});
