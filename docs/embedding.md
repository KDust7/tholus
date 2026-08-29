# Embedding uv

`@tholus/core` runs uv in a dedicated Worker and gives the page a typed handle to it. Two layers are
exposed and you can mix them freely:

- Layer 0 is `engine.exec(argv, options)`, uv's command line exactly as it is on a terminal.
- Layer 1 is `engine.pip.*` and `engine.venv.*`, which build the argv for you and return parsed
  results.

## Starting one

```ts
import { createEngine } from "@tholus/core";

const engine = await createEngine({
  config: {
    cwd: "/work",
    cache: { kind: "opfs" },
  },
});

console.log(engine.build.uv); // "0.12.3"
```

`createEngine` resolves once the worker has compiled the wasm, booted the engine and completed the
protocol handshake. It rejects if the worker's protocol version does not match the SDK's.

### Where the worker comes from

By default the SDK loads `./worker.js` relative to the module doing the loading. Ship
`worker.js` beside your bundle and it resolves on its own; the engine's `.js` and `.wasm` are then
found relative to the worker. If your layout differs, pass `workerUrl`.

```ts
await createEngine({ workerUrl: new URL("/vendor/uv/worker.js", location.origin) });
```

## Running a command

`argv` starts at the subcommand. The program name is the engine's business, not yours.

```ts
const handle = engine.exec(["pip", "install", "idna"], {
  stdout: (chunk) => term.write(chunk),
  stderr: (chunk) => term.write(chunk),
});

const { code, cancelled, durationMs } = await handle.exit;
```

- Invocations are serialized. A second `exec` queues behind the first.
- `handle.cancel()` interrupts; a second cancel escalates. `options.signal` accepts an `AbortSignal`.
- `options.tty = { cols, rows }` makes uv render as if attached to a terminal, and `handle.resize()`
  tells it the size changed mid-run.
- `options.stdin` accepts a string or bytes, for `uv pip install -r -`.

## The typed commands

```ts
await engine.venv.create({ path: "/work/.venv", pythonVersion: "/bin/python3" });

const report = await engine.pip.install({
  packages: ["idna==3.11"],
  venv: "/work/.venv",
});
// report.installed -> [{ name: "idna", version: "3.11" }]

const installed = await engine.pip.list({ venv: "/work/.venv" });
```

These throw on failure, where `exec` only reports a non-zero code: `ResolutionConflictError` when
uv could not solve, `UnsupportedError` otherwise. Use whichever failure style suits the surface
you are building.

## Watching it boot

The engine fetches ~18 MiB of WebAssembly, compiles it, and initializes. On a cold cache that is not
instant, and a page that says nothing during it looks broken:

```ts
const engine = await createEngine({
  onBootProgress: ({ phase, ms }) => {
    setStatus(ms === undefined ? phase : `${phase} in ${Math.round(ms)} ms`);
  },
});
```

Four phases arrive in order (`compile-start`, `compile-done`, `init-start`, `ready`) and the two
that end a stage carry the milliseconds it took. They all arrive before `createEngine` resolves,
which is the whole point and also the trap: a listener attached to the returned engine is too late to
see any of them, so this is a `createEngine` option rather than an `onEvent` type. A listener that
throws is reported as a `log` event and does not stop the boot.

## Watching progress

```ts
engine.onEvent((event) => {
  if (event.type === "phase") {
    setStatus(`${event.phase} ${event.state}`);
  }
});
```

Events also arrive per invocation through `options.onEvent`. What is emitted today: `log`, `phase`,
`resolution-complete`, `install-report`, `runtime-finalize` and `request`.

`request` is the exception to per-invocation delivery. It carries no `invocationId`, because the
transport does not know which command a fetch belongs to, so it reaches the engine-level listener
only. It is emitted only when you choose a transport: the `platform` default deliberately leaves
`globalThis.fetch` untouched, so there is nothing to observe.

`progress` is declared in the protocol and not emitted. uv suppresses progress bars on a pipe, so
there is nothing to read; deriving it from a response body would mean interposing on the download
path, which is not a trade worth making for a progress bar.

## Wiring it to a terminal

`@tholus/xterm` writes uv's bytes through untouched, with no rewriting and no line-ending
translation, because a terminal is the thing that owns rendering. That leaves one setting the host has to get
right:

```ts
const terminal = new Terminal({ convertEol: true });
```

uv writes bare `LF`. A terminal that does not convert it moves the cursor down without returning
it to column 0, so every line starts where the last one ended and the output reads as a staircase.
`runInTerminal` warns once on a terminal that says `convertEol: false`, and says nothing when the
terminal does not report the option at all, since xterm.js is not the only terminal shaped like
`TerminalLike`.

`test/parity/tty-render.test.ts` replays a real install through a headless terminal both ways: with
the conversion nothing is indented and every progress frame is erased behind the summary; without it
the staircase reappears, which is what keeps that gate honest.

## Reading what uv built

```ts
const { entries, bytes } = await engine.exportTree("/work/.venv/lib/python3.14/site-packages");
```

One transferable buffer plus an offset table, instead of a chatty filesystem API. This is what you
hand to Pyodide; see [pyodide.md](pyodide.md).

## Finishing

`engine.dispose()` drains in-flight work, flushes the cache and closes the worker. `engine.terminate()`
kills it immediately and is the right answer when a command will not stop.

## Configuration worth knowing

| Field | Notes |
| --- | --- |
| `cache` | `opfs` persists across reloads; `memory` does not; `none` disables it. |
| `fs` | `memory` only. Whole-filesystem persistence is a different feature and refuses. |
| `transport` | See [transports.md](transports.md). |
| `index` | `indexUrl`, `extraIndexUrls`, `indexStrategy`, `pyodideIndex`. |
| `env` | Extra environment variables. uv reads its own `UV_*` set from here. |
| `logFilter` | A `tracing` filter, e.g. `uv=debug`. Equivalent to `-v` but scoped. |

There is no ambient environment in a browser, so anything uv would normally read from the process
environment has to arrive through `config`.
