# Pyodide

uv can resolve, download and install into a virtual environment entirely on its own. What it cannot
do is *run Python*, there is no interpreter inside the engine. Pyodide supplies one, and
`@uv-wasm/pyodide` connects the two in both directions:

- Mounting, hand an environment uv built to Pyodide so `import` finds it.
- Build hooks, let uv run a package's PEP 517 backend inside Pyodide, so source distributions
  build in the browser.

Nothing here is required. An engine with no runtime attached still installs wheels; it refuses only
the things that genuinely need an interpreter, and says so.

## Attaching

```ts
import { attachPyodide } from "@uv-wasm/pyodide";
import { loadPyodide } from "pyodide";

const pyodide = await loadPyodide();
const runtime = attachPyodide(engine, pyodide);
```

`attachPyodide` probes the runtime rather than trusting a version string. `runtime.facts` reports the
Python version, the platform tag and the extension-module suffix it found.

## Mounting an environment

```ts
await engine.venv.create({ path: "/work/.venv", pythonVersion: "/bin/python3" });
await engine.pip.install({ packages: ["idna"], venv: "/work/.venv" });

const mounted = await runtime.mount("/work/.venv/lib/python3.14/site-packages");
pyodide.runPython("import idna; print(idna.__version__)");
```

`mount` exports the tree from the engine as one transferable buffer, writes it into Pyodide's
filesystem and puts it on `sys.path`. It returns how many files and links were written and how many
bytes they took.

The ABI is checked before anything is written. If the environment holds an extension module built
for a different Pyodide than the one attached, the mount refuses instead of producing an
`ImportError` at some later, more confusing moment.

Extension modules load lazily when Python imports them, which is both correct and faster. Pass
`loadDynlibs: true` only if you need them resolved eagerly; on a large scientific stack that costs
roughly five times as long and changes nothing observable.

## Building source distributions

When uv needs to build a package from source it needs a Python to run the backend. Route its hook
requests to the runtime:

```ts
import { applyHookWrites, hookTrees, sitePackagesOf } from "@uv-wasm/core";

engine.attachRuntime(async (invocation) => {
  const outcome = await runtime.hook(invocation);
  return outcome;
});
```

Through the worker SDK that is a single call, `engine.attachRuntime(handler)`, and the worker does
the tree marshaling for you. Driving the engine handle directly, you assemble the same pieces with
`hookTrees`, `sitePackagesOf` and `applyHookWrites`.

What crosses, per hook: the source tree, the build environment's `site-packages`, and, for
`build_wheel` only, the output directory uv expects the wheel to appear in. What comes back: stdout,
stderr, an exit status, and the files the hook wrote, which are applied to the engine's filesystem.

uv drives this itself. It calls `get_requires_for_build_wheel`, installs whatever that asks for into
the build environment, and calls `build_wheel`, you do not orchestrate the sequence.

The build environment is a temporary directory uv deletes when the build ends. Anything you want
to know about it has to be observed inside the hook; reading it afterwards finds nothing, which looks
like a broken bridge and is not.

## Without a runtime

`uv pip install` of a wheel needs no runtime at all. A source build without one fails with uv's own
message about a missing interpreter, not a crash, and that refusal is pinned by tests, it is
a supported state, not an accident.

## Versions

Pyodide's ABI is probed, not assumed, because it moves. As of Pyodide 314.0.5 the runtime reports
CPython 3.14, `emscripten-5.0.3-wasm32` and `.cpython-314-wasm32-emscripten.so`, which matches the
interpreter profile the engine seeds. Pyodide ships neither `micropip` nor `numpy` nor `requests` by
default, uv installs those.

## The private API this depends on, and how you find out it went

Mounting a compiled extension needs `pyodide._api.loadDynlib`, which is private. Decision 22 accepted
that with a version-gated bridge and a nightly tripwire, and both exist:

- `test/parity/pyodide-surface.test.ts` asserts every member the adapter touches, thirteen `FS.*`
  methods, `runPython`, and `_api.loadDynlib`, against the pinned Pyodide, on every run.
- `test/parity/pyodide-matrix.test.ts` asserts the same surface against the stable, previous and
  next channels nightly, so a removal in a prerelease shows up as early warning instead of an upgrade
  that breaks. `scripts/install-pyodide-matrix.mjs` resolves those three from npm's `latest`/`next` tags
  and unpacks them.

Measured 2026-08-23: the whole surface is intact on 314.0.4, 314.0.5 and 315.0.0-alpha.2.

One fact worth carrying: npm spells a prerelease `315.0.0-alpha.2` and Pyodide reports itself as
`315.0.0a2`. Anything keying one to the other, a version gate, a cache tag, an ABI string, breaks
the first time the pin is a prerelease.
