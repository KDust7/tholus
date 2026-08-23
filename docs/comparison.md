# uv in a browser, next to what already exists

Three things already install Python packages in a browser tab. This page says what each one does,
where it stops, and which one you want.

## The short answer

| | resolution | lockfiles | cache | sdists | source of packages |
| --- | --- | --- | --- | --- | --- |
| this project | PubGrub, full backtracking | `uv.lock`, `pip compile` | persistent, OPFS | PEP 517 via a Pyodide you supply | any PEP 503 index |
| micropip | first satisfying version, no backtracking | none | none | none | Pyodide's index, PyPI wheels |
| Pyodide's `loadPackage` | none, a fixed graph | none | browser HTTP cache | none | Pyodide's own build only |

## micropip

`micropip.install("requests")` works, and for a single package with shallow dependencies it is the
right tool: it is small, it is already in the runtime, and it needs nothing else.

What it does not do is resolve. micropip walks the requirement graph taking the first version that
satisfies each constraint, and when two requirements disagree it raises. There is no backtracking, so
a solvable problem can still fail, and the failure names the two requirements rather than the
choice that caused them. It also keeps no lockfile and no cache, so the same install re-downloads
every time, and two sessions can legitimately install different versions of the same set.

This project runs uv's PubGrub resolver, which is the same code Astral ships. It backtracks, it
reports an unsatisfiable set as a derivation tree rather than a single conflicting pair, and it
records what it chose.

## Pyodide's `loadPackage`

`pyodide.loadPackage("numpy")` is not a package manager. It fetches a package from the build Pyodide
was released with, whose versions are pinned to that release, `numpy` is exactly one version per
Pyodide version. That is a feature for the packages with compiled extensions, because those *have*
to come from Pyodide's own cross-build to load at all.

The two complement each other. This project resolves against
`index.pyodide.org/<version>/` first and PyPI second, which is what uv's default `first-index` strategy
is for: a package Pyodide built resolves to Pyodide's wasm wheel, and a pure
Python package that Pyodide never built falls through to PyPI.

## What this project costs

The engine is a ~18 MiB WebAssembly module (~4 MiB over brotli), which is a real download and a real
compile. That buys uv itself, the resolver, the installer, the cache, the lockfile format, the
`pip` command surface, and byte-identical output to the native binary. If all you need is one
pure-Python wheel in a notebook cell, micropip is smaller and already there.

It is worth it when any of these is true:

- the resolution has to be right, several requirements, overlapping constraints, or a conflict
  you need explained, not just raised;
- the environment has to be reproducible, `uv pip compile` and `uv lock` produce the same
  artifacts a terminal would, hashes included, so an environment resolved in a browser can be
  installed on a server;
- the same install happens repeatedly, the cache survives a reload, and a warm reinstall makes
  no network request at all;
- you want a terminal, `uv` in an xterm.js session behaves like `uv` in a terminal, progress
  bars and colors included.

## What it does not do

- It cannot build a compiled extension. A PEP 517 backend runs inside a Pyodide you attach, and
  that Pyodide has no compiler. Source builds work for pure-Python backends (flit-core, setuptools,
  hatchling are all gated); anything with C in it needs a wheel Pyodide already cross-built.
- It cannot install a Python. `python-build-standalone` has no `wasm32` build, so
  `uv python install` correctly finds nothing. The interpreter is the Pyodide the host supplies.
- It is not a sandbox escape. The same-origin policy still applies: an index has to send CORS
  headers, or you have to route through a transport that does not need them, see
  [transports.md](transports.md).

## Which to reach for

- One wheel, in a notebook, no reproducibility requirement → micropip.
- Something with a compiled extension that Pyodide already builds → `loadPackage`, or this
  project, which will resolve to the same wheel.
- A dependency set, a lockfile, a cache, a terminal, or output you intend to trust → this
  project.
