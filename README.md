# tholus

Astral's [uv](https://github.com/astral-sh/uv), the Rust Python package manager, compiled to
WebAssembly.

>
>
> **Not affiliated with or endorsed by Astral.** This is an independent port.

## What it is

implement in three different places:

- Terminals: wire the engine to [xterm.js](https://xtermjs.org) and type `uv pip install rich`
  with real ANSI colors and live progress bars.
- Pyodide apps: a programmatic package-manager API for JupyterLite/PyScript/marimo-class hosts,
  with correct dependency resolution 
- Tooling UIs: uv's PubGrub resolver as a library. Resolve, lock, and export without installing.

 engine runs in a dedicated Web Worker. Embedding pages need no COOP/COEP headers and no
`SharedArrayBuffer`.

## Why not micropip

micropip has no real resolver. It takes the first satisfying version and raises on conflict, with no
backtracking. uv brings PubGrub resolution, lockfiles, a persistent cache, and range-request metadata
fetching.

## Layout

| Path | What lives there |
| --- | --- |
| `vendor/uv/` | Submodule: our fork of astral-sh/uv, one commit per seam patch |
| `crates/uv-wasm-engine/` | wasm-bindgen boundary, OPFS store, TTY and event plumbing |
| `crates/uv-wasm-xtask/` | Build pipeline: cargo then wasm-bindgen then wasm-opt |
| `packages/` | npm SDK (core, pyodide adapter, xterm addon, transports) |
| `apps/demo/` | demo site |
| `test/parity/` | parity tests against native uv |
| `apps/testbed/` | Playwright harness page |
| `docs/` | Architecture, spec, and integration guides |

## Documentation

| Guide | What it covers |
| --- | --- |
| [comparison.md](docs/comparison.md) | How this differs from micropip and Pyodide's `loadPackage` |
| [embedding.md](docs/embedding.md) | Starting an engine, running commands, the typed `pip`/`venv` API |
| [transports.md](docs/transports.md) | `platform`, `fetch` and `libcurl`, and writing your own |
| [pyodide.md](docs/pyodide.md) | Mounting an environment into Pyodide, and PEP 517 build hooks |
| [parity.md](docs/parity.md) | How the byte-parity gate works and how to re-record fixtures |
| [privacy.md](docs/privacy.md) | What leaves the browser, what is stored, what a host can turn off |
| [hosting.md](docs/hosting.md) | Serving the artifact: brotli, immutable caching, CSP, and no COOP/COEP |
| [architecture.md](docs/architecture.md) | How the pieces fit |

## Development

Requires [bun](https://bun.sh) >= 1.3 and the Rust toolchain pinned in `rust-toolchain.toml`.

```sh
bun install --linker=isolated
bun run build       # the packages, then the apps that bundle them
bun run test        # everything
cargo xtask build   # build the wasm engine artifact
```

`bun run test` splits into two projects: `--project unit` for everything that runs in-process, and
`--project browser` for the seven files that launch Chromium, which run one at a time on purpose.
Seven at once does not just run slowly. It produces failures that look like defects. See
[parity.md](docs/parity.md).

## License

Apache-2.0 OR MIT. The vendored uv fork keeps upstream's licensing (`uv-pep440` and `uv-pep508` are
Apache-2.0 OR BSD-2-Clause). No AGPL code is linked or shipped; see `docs/transports.md`.
