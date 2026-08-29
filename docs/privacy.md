# Privacy

tholus runs entirely in the page. This document says what that means concretely: what leaves the
browser, what is stored, and what a host controls.

## What leaves the browser

Only package-index traffic, and only to the indexes you configure.

uv fetches index pages, metadata and distribution archives from `indexUrl` and any
`extraIndexUrls`, and from whatever URLs those pages point at, usually a separate file host. That is
the whole of it. There is no telemetry, no analytics, no crash reporting and no call to any
tholus-operated service. There is no tholus-operated service.

The requests are made by uv itself, through whichever transport the host chose. With
`{kind:"platform"}` they are ordinary browser `fetch` calls and follow the page's own CORS and CSP
rules. With `{kind:"libcurl"}` they are tunneled through a Wisp relay the host supplies, which by
construction sees every request and response. See [transports.md](transports.md). Choosing that
transport means choosing to trust that relay.

`apps/demo` is shaped so that this is a choice you make, not one made for you: no
relay is configured until you type one into the footer, and the page says so beneath the terminal.
A relay operator sees every hostname you reach and the size and timing of every response, which is
enough to identify which packages you installed even though the bodies are TLS-protected end to end.
Run your own, or do not name one.

## What an index can observe

The same things any package installer reveals: which packages and versions you asked for, and when.
Through the platform transport a browser also attaches its own `Origin` and `Referer`, and its own
`User-Agent`, so an index sees the page you are on, which a command-line uv would not disclose.

Hosts that care about this should serve the index from the same origin, or proxy it.

## What is stored, and where

Everything is per-origin browser storage. Nothing is written outside the browser's own sandbox.

| What | Where | Survives a reload |
| --- | --- | --- |
| uv's package cache | OPFS, under a scope you name | Yes, with `cache: { kind: "opfs" }` |
| Virtual environments and project files | The engine's in-memory filesystem | No |
| Anything Pyodide wrote | Pyodide's own filesystem | No |

The cache holds downloaded distributions and their unpacked form. It holds no credentials and no
request history. Clearing site data removes it; so does `cache: { kind: "none" }`, which keeps
everything in memory for the session.

The cache is keyed by an ABI tag derived from the attached interpreter, so an environment built for
one Pyodide release is never mixed into another.

## Credentials

uv supports authenticated indexes. Anything you pass (a token in an index URL, or headers a custom
transport adds) is held in memory for the session and is written to the cache by nothing. It does
reach the index, which is the point, and it reaches a Wisp relay too if you configured one.

Browser `fetch` silently drops `Cookie` and `Authorization` is subject to CORS preflight, so
same-origin or proxied indexes are the practical route for authenticated installs through the
platform transport.

## What the host can turn off

- `cache: { kind: "none" }`: nothing persists.
- `transport: { kind: "platform" }`, the default: no third party is involved beyond the index.
- Not attaching a Pyodide runtime: no arbitrary Python from a package's build backend ever executes.

That last one is worth stating plainly. A source distribution's build backend is arbitrary code,
and running one means running it. It executes inside Pyodide's WebAssembly sandbox with access to the
trees uv hands it, not to the page. Installing only wheels avoids the question entirely, and an
engine with no runtime attached cannot build from source even if asked.
