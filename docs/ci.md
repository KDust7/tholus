# Continuous integration

## Active workflows

### `ci.yml`

Runs on every push to `main` and every pull request.

`javascript` job, installs the pnpm workspace, then:

- `pnpm lint` (biome)
- `pnpm -r typecheck` (tsc 6.0 per package)
- `pnpm vitest run --coverage`, gated at 80% lines/functions/branches/statements
- regenerates the protocol JSON Schema artifacts and fails if the committed copies drift

`wasm engine` job, installs the Rust toolchain pinned by `rust-toolchain.toml` plus a
`wasm-bindgen-cli` matching the `wasm-bindgen` crate version exactly, then:

- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --workspace`
- `cargo xtask build` to produce the browser artifact
- `pnpm size` to measure raw, brotli, and gzip sizes against the budgets

The `wasm-bindgen` crate version and the CLI version must match; the CLI refuses to process a
module built by a different version. The crate is pinned exactly in the workspace manifest and the
workflow reads the same number from `WASM_BINDGEN_VERSION`.

## Size policy

Budgets live in `tools/size-report/budgets.json` and are advisory, matching the project
decision to prioritize correctness over size until the MVP bar is met. The size job fails only on:

- a required artifact missing, or
- a brotli size regression greater than 10% against a supplied baseline
  (`UV_WASM_SIZE_BASELINE` pointing at a previous `size-report.json`).

Exceeding the raw or brotli budget prints a warning explaining the consequence, past roughly
20 MB of wasm, V8 stops caching compiled code and every visit pays a full recompile, but does not
fail the build.

## Workflows still to come

These are specified in the implementation plan and land with the work they verify:

| Workflow | Lands with | Purpose |
| --- | --- | --- |
| `fork-native.yml` | Phase 1 | Runs upstream uv's own test suite inside `vendor/uv` to prove the fork's native behavior is unchanged |
| `parity.yml` | Phase 2 | Golden-output parity against native uv; becomes the required merge gate |
| `rebase-canary.yml` | Phase 1 | Weekly trial rebase onto the latest uv tag, publishing a `git range-diff` artifact |
| `nightly.yml` | Phase 3 | Full parity matrix across Chromium, Firefox, and WebKit; Pyodide version matrix; live-PyPI smoke |
| `release.yml` | MVP | Lockstep publish of every package with provenance |

## Local equivalents

```sh
pnpm lint
pnpm -r typecheck
pnpm vitest run --coverage
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo xtask build
pnpm size
```

On Windows the Rust toolchain needs a host linker. If Visual Studio Build Tools are not installed,
select the GNU toolchain for the session with
`$env:RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-gnu"`.
