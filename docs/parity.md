# Parity

The claim this project rests on is that uv in a browser behaves like uv on a terminal. That claim is
a gate in CI, not a line in a README. This document says how the gate works and how to keep it
honest.

## The bar

N-class, byte parity. For a given command, the bytes uv writes to stdout and stderr in the
browser must equal the bytes native uv writes, after normalizing the handful of tokens that cannot
match: temporary paths, durations, transfer rates, sizes, the Python implementation string and uv's
own build stamp. Ordering is never forgiven, a differently-ordered `readdir` is a failure, not a
nuisance.

W-class, reviewed snapshots. Where byte parity is not meaningful (structured reports, terminal
renderings), a frozen snapshot is compared and any change has to be reviewed deliberately, the same
way an API report is.

TTY, render parity. Both raw streams are replayed through a headless terminal at the recorded
geometry, and the final screen and scrollback must match.

## Both sides must be the same uv

The browser artifact and the native binary have to be built from the same fork commit.
`native-parity.test.ts` asserts their build stamps are equal, which is what stops a mismatched
pair being compared at all.

Two traps follow from that:

- `uv-cli/build.rs` reads `.git/HEAD`, so committing between the two builds is enough to skew
  them. The rule that works is *commit, then rebuild both*, or build both, then commit. Deciding to
  commit "while the build runs" is the specific move to avoid.
- Both lagging equally is fine, and is the normal state. The gate compares the binaries against
  each other, not against `HEAD`. What is not fine is a fork change that alters *native* behavior
  without a native rebuild, even when the stamps happen to match.

The program name is the one deliberate divergence: the worker names it `uv`, where a native binary
names the file it was run from, so `uv.exe` appears on Windows. `normalize()` folds that away, the
same way it folds away the target triple in `--version`.

## The index is frozen

Neither side talks to PyPI. `scripts/record-fixtures.mjs` records a scenario by running both
binaries against the real index and saving every response; it refuses to write a fixture unless both
exited zero, which makes the recording itself a differential oracle.
`test/parity/replay-server.ts` serves that snapshot back on an ephemeral port, with `Range` support,
rewriting the recorded origin to wherever it is listening.

Re-recording:

```sh
node scripts/record-fixtures.mjs [scenario…]   # compile, install, sync, pyodide
node scripts/make-conflict-fixture.mjs         # the hand-authored conflict
bun run --filter @uv-wasm/parity record        # the CLI goldens
```

All of them need a native uv built from the same fork commit as the artifact.

## What the fixtures contain, and why that is publishable

The snapshots embed the actual bytes of the distributions each scenario downloads, 8.9 MB across
27 distributions, because a replay server that did not would be replaying nothing. The pre-reveal
checklist asks for this posture to be stated, not assumed, so:

- Everything embedded is an unmodified upstream artifact from PyPI, recorded byte for byte. None
  is patched, repacked or renamed.
- The licenses are permissive, checked against PyPI and not from memory: Apache-2.0
  (`requests`, `msgpack`), MIT (`urllib3`, `charset-normalizer`, `zipp`, `attrs`, `setuptools`,
  `hatchling`, `pathspec`, `pluggy`), BSD-3-Clause (`idna`, `flit-core`), MPL-2.0 (`certifi`). All
  permit redistribution; MPL-2.0's source-availability condition is satisfied by the artifact being
  the unmodified upstream one.
- Four are ours, `uv_wasm_left`, `uv_wasm_right`, `uv_wasm_shared` (two versions), hand-authored
  to produce a resolution conflict that no real package pair reliably produces.

If that posture ever stops being comfortable, the fixtures are regenerable: delete them, run the
recorder, and the only cost is the recording time. Nothing in the suite depends on the *bytes* being
in git, only on their being identical between the two binaries at record time.

## Running it

```sh
bun run vitest run                       # everything
bun run vitest run --project unit        # everything that does not launch a browser
bun run vitest run --project browser     # the seven that do, one at a time
```

The browser project sets `fileParallelism: false` on purpose. Seven concurrent Chromium instances
on one machine do not merely run slowly, they produce failures that look like defects. A local
server refusing a connection with `TypeError: fetch failed`, a `spawnSync` of the native binary
taking four minutes, a file failing with zero failing tests inside it: all three have been observed,
and all three were load.

Corollary that matters: a slow run here is not a slow pass, it is an unreliable one. Check
the duration before believing a failure. Killing a pile of Chromium processes does not leave a quiet
machine immediately either, give it a moment before concluding anything from the next run.

## Skips

A skipped test in this repository means one of two things, and the name says which.

- Structural, the case does not apply. There is no extension module in a pure-Python wheel, so
  the test that would check one is skipped for that scenario. These are inapplicable, not missing.
- `BLOCKED:`, a defect. The name carries the whole reason, so it reads as a defect in the run
  output instead of disappearing into a count. Anything here is owed work.

The golden transcripts are the third kind: they assert the mock's scripted output, not uv's,
so they run against the mock and never the engine.

## Gates that cannot fail are worse than no gates

Every gate here has, at some point, been made to fail to confirm it goes red. That is not
ceremony. This project has four recorded instances of an oracle agreeing with a wrong implementation
because neither side ran at all, a fixture empty on both sides, a `misses.length === 0` with
nothing requested, a mock built on the same wrong assumption as the code it checked, and a render
assertion anchored on a line that looked identical in both renderings.

When a gate passes on its first run, break it on purpose. It costs one run and it is the only thing
separating a gate from a decoration.
