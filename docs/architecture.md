# Architecture

## The shape of the problem

`uv` is a native CLI. It spawns subprocesses to interrogate Python interpreters and to run PEP 517
build backends, it hardlinks files out of a global cache, it takes advisory file locks, and it talks
to package indexes over a TLS stack it owns. A browser offers none of that.

The port keeps uv's logic and replaces its four contacts with the outside world:

| Contact | Native | Browser |
| --- | --- | --- |
| Filesystem | `std::fs`, hardlinks, file locks | A virtual filesystem trait, memory-backed, persisted to OPFS |
| Network | reqwest + rustls | A transport trait the host supplies, defaulting to `fetch` |
| Subprocess | `python -c`, PEP 517 hooks | An RPC to a Pyodide runtime the host attaches |
| Interpreter discovery | Runs a probe script | A synthetic interpreter built from static target facts |

Everything else (resolution, metadata handling, wheel unpacking, virtual environment layout) is
uv's own code, unmodified.

## Layers

```
  host page  ──────────────────────────────────────────────────────┐
    xterm.js terminal    programmatic API    resolver-only API      │
             │                   │                   │             │
             └───────────── @tholus/core ───────────┘             │  main thread
                                 │                                 │
              ┌──────────────────┴──────────────────┐              │
        transport (fetch | libcurl)          Pyodide adapter        │
                                 │                                 │
  ═══════════════════ engine-protocol (the treaty) ════════════════╪══
                                 │                                 │
                       uv-wasm-engine (wasm)                       │  dedicated worker
                                 │                                 │
                   ┌─────────────┴─────────────┐                   │
              uv-vfs        uv-wasm-http   uv-wasm-compat           │
                   └─────────────┬─────────────┘                   │
                        the uv fork (vendor/uv)                    │
```

The engine runs in a dedicated Web Worker. That is not a preference: OPFS synchronous file access
handles only exist in workers, and it keeps a CPU-bound resolver off the UI thread. Nothing in the
design requires `SharedArrayBuffer`, so embedding pages need no COOP/COEP headers.

## The protocol is the contract

`@tholus/engine-protocol` defines every message crossing the worker boundary as a zod schema, and
emits those schemas as JSON Schema documents that the Rust side validates against. Both
implementations answer to the same document, so neither can drift silently.

Alongside it, `test/contract/transcripts/` holds golden message sequences for the canonical flows:
handshake, streaming output, stdin round-trip, cancellation, structured failure. Any implementation
claiming to be an engine must satisfy them. `@tholus/mock-engine` satisfies them today, which is
what lets the SDK be built and tested before the real engine compiles.

## Why there are two output channels

The engine emits raw bytes on stdout and stderr: real ANSI, real progress bars, byte-identical to
native uv. It *also* emits structured events for the same activity.

These are independent. Programmatic consumers never parse terminal output, and terminal consumers
get uv's own bytes instead of a summary of them. The typed API layer is built strictly on the event
channel; a contract test enforces that separation.

## Filesystem: memory in front of OPFS

uv's install path is synchronous throughout. An async filesystem trait would mean rewriting the
fork, which defeats the point of forking minimally. So the trait is synchronous, and the live
filesystem is always in memory.

OPFS sits underneath as a persistence store, touched only at points that are already asynchronous.
At startup the cache manifest is read and small buckets are hydrated eagerly; large unpacked
archives become metadata-only stubs. Content is faulted in before any synchronous read can reach it.
After a successful command the dirty set is written back and hydrated archives are demoted to stubs
again, which bounds memory to roughly the working set.

OPFS has no hardlinks, so uv's cache-to-environment linking degrades to copying, tracked by a
reference table.

## Networking without CORS assumptions

PyPI turns out to be fully CORS-open for reads. The simple index, wheel downloads, range requests,
and PEP 658 metadata sidecars all permit browser origins. So the default transport is plain `fetch`
and the zero-configuration path works with no infrastructure.

One trap: `files.pythonhosted.org` sends no CORS headers on `HEAD`. The browser HTTP layer rewrites
any HEAD into a one-byte range GET.

Private indexes and arbitrary hosts generally are not CORS-open. For those the transport seam
accepts any implementation shaped like `ProxyTransport`, so a host can plug in a Wisp-relay client
and reach anything, with TLS terminated client-side. Those relay clients are AGPL, so they are
loaded by the host at runtime and never linked into anything we publish.

## Python runtime is the host's

The engine resolves, fetches, and unpacks. It never needs Python to do that. Two things do need a
runtime, and both are delegated to an adapter over the host's own Pyodide instance:

- Pure-Python source distributions, whose PEP 517 hooks run inside Pyodide with a build
  environment the engine pre-populates.
- Binary wheels, whose shared objects must be registered with Emscripten's dynamic linker from
  inside the runtime. Writing the files is not enough to make them importable.

With no runtime attached, pure-Python wheels still install normally; the other two cases fail with
errors that name the packages and the remedy.

## Fork discipline

`vendor/uv` is our fork pinned to an upstream release tag. Each seam is a single commit, so the
patch set reads as a `git range-diff` against upstream and rebases with `rerere`. All browser
behavior hides behind `cfg(target_family = "wasm")`, and CI runs upstream's own test suite against
the fork to prove native behavior is untouched.
