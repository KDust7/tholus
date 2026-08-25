# Continuous integration

## Active workflows

### `ci.yml`

Runs on every push to `main` and every pull request.

`javascript` job, installs the bun workspace, then:

- `bun run lint` (biome)
- `bun run typecheck` (tsc 6.0 per package)
- `bun run test:coverage`, gated at 80% lines/functions/branches/statements, per package as well as
  overall
- regenerates the protocol JSON Schema artifacts and fails if the committed copies drift
- `node scripts/check-release-readiness.mjs`, which fails on anything that would make a publish
  wrong and stays quiet about the packages still being private
- regenerates the public API report and fails if the committed copies drift

`wasm engine` job, installs the Rust toolchain pinned by `rust-toolchain.toml` plus a
`wasm-bindgen-cli` matching the `wasm-bindgen` crate version exactly, then:

- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --workspace`
- `cargo xtask build` to produce the browser artifact
- `bun run size` to measure raw, brotli, and gzip sizes against the budgets

The `wasm-bindgen` crate version and the CLI version must match; the CLI refuses to process a
module built by a different version. The crate is pinned exactly in the workspace manifest and the
workflow reads the same number from `WASM_BINDGEN_VERSION`.

## Running the gate before you push

`bash scripts/verify-local.sh` runs the parts of the `javascript` job that fail on drift rather than
on behavior, build, lint, typecheck, the emitted protocol schemas, release readiness, the public
API report, and the fork-rewrite tests, and reports every failure rather than stopping at the
first.

The two drift checks are the ones worth running locally, because neither is visible in a normal
test run. The API report reads `dist/`, not `src/`, so a source change that is not rebuilt
regenerates the *old* surface and reports success. `verify-local.sh` builds first for that reason.

CI can check drift with `git diff --exit-code`, because its checkout is clean. Locally that is the
wrong question, it cannot tell your uncommitted edit from stale committed output, so it fails on
any dirty tree, which is every tree that needs checking. `verify-local.sh` snapshots the generated
directory, regenerates, and compares the two: if regenerating changes nothing, the copies on disk
are current, whatever else is uncommitted.

The suite and coverage are left out of it; run `bun run test:coverage` separately.

## Size policy

Budgets live in `tools/size-report/budgets.json` and are advisory, matching the project
decision to prioritize correctness over size until the MVP bar is met. The size job fails only on:

- a required artifact missing, or
- a brotli size regression greater than 10% against a supplied baseline
  (`UV_WASM_SIZE_BASELINE` pointing at a previous `size-report.json`).

Exceeding the raw or brotli budget prints a warning explaining the consequence, past roughly
20 MB of wasm, V8 stops caching compiled code and every visit pays a full recompile, but does not
fail the build.

## The other workflows

All of these exist and have been watched running; none is still owed.

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `fork-native.yml` | push, PR | Runs the fork's own crates natively, `uv-vfs`, `uv-wasm-compat`, `uv-wasm-http`, with fmt, clippy, tests and coverage, so the port's Rust is checked outside the browser |
| `rebase-canary.yml` | weekly | Trial rebase onto the latest uv tag, publishes a `git range-diff` artifact and does not fail the branch |
| `nightly.yml` | nightly | The full parity matrix across Chromium, Firefox and WebKit, the Pyodide stable/prev/next matrix, and the live-PyPI smoke |
| `release.yml` | manual | Lockstep publish of all six packages with provenance, defaulting to a dry run |

There is no `parity.yml`. The parity gate runs inside `ci.yml`'s `wasm engine` job, against the
artifact that job just built, which is the point, since a parity run against a stale artifact
proves nothing.

### What `release.yml` does that is easy to miss

Two steps exist because `npm pack` will happily produce a tarball that cannot be installed:

- Pin the workspace ranges npm cannot resolve. The six packages depend on each other with
  `workspace:*`. npm has no such protocol, it copies the range into the tarball verbatim and
  every consumer install dies with `EUNSUPPORTEDPROTOCOL`. `scripts/rewrite-workspace-deps.mjs`
  pins them to the release version, and it runs after the suite so the tests still exercise
  the linked workspace.
- Read the tarballs back. `scripts/check-tarballs.mjs` opens each `.tgz`, parses the tar in
  process, and inspects the `package.json` npm wrote into it, refusing on a surviving
  `workspace:` range, a wrong version, a `private: true` outside a dry run, or a missing engine.
  The engine is gitignored and built by `cargo xtask build`, so packing before that step would
  ship an SDK with no wasm in it.

Both are covered by `scripts/publish-gates.test.ts`, and the readiness check fails if `release.yml`
stops running either one.

## Local equivalents

```sh
bun run lint
bun run typecheck
bun run test:coverage
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo xtask build
bun run size
```

On Windows the Rust toolchain needs a host linker. If Visual Studio Build Tools are not installed,
select the GNU toolchain for the session with
`$env:RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-gnu"`.
