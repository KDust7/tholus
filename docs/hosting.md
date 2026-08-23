# Hosting

uv-wasm is static files. There is no server to run, and this project operates none.

## What you serve

| File | Notes |
| --- | --- |
| your page and bundle | whatever your app is |
| `worker.js` | the engine worker, beside your bundle unless you pass `workerUrl` |
| `engine.js` | wasm-bindgen's glue, at `../assets/` relative to the worker |
| `engine_bg.wasm` | ~18.3 MiB raw, ~4.1 MiB brotli |

The worker resolves `engine.js` and `engine_bg.wasm` relative to its own URL, so keeping the shipped
layout is the path of least resistance.

## No COOP/COEP

You do not need cross-origin isolation. The engine is single-threaded and uses no
`SharedArrayBuffer`, so none of `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy` or
`Cross-Origin-Resource-Policy` is required. That is a design constraint, not an accident:
those headers break embedding in most real pages, and the whole point is to drop into one.

## Compression

Serve the wasm with brotli. It is the difference between 18.3 MiB and 4.1 MiB on the wire, a
factor of 4.5, and by far the largest single thing you control.

```
Content-Encoding: br
Content-Type: application/wasm
```

Gzip is the fallback at ~6.0 MiB. Pre-compress at build time, not on the fly; a 18 MiB brotli
compression per request is not something to do live.

Serve `Content-Type: application/wasm` so the browser can compile the module while it streams. A
generic `application/octet-stream` forces the whole download to land before compilation starts.

## Caching

Hash the filename and cache it forever:

```
Cache-Control: public, max-age=31536000, immutable
```

The artifact is large and changes only when you ship a new build, so an immutable, content-addressed
URL is the right call. Do not serve it with a short max-age and revalidation, you will pay a
round trip on every load for a file that never changes.

Your HTML should be the opposite: `Cache-Control: no-cache`, so a new deploy is picked up.

V8 caches compiled WebAssembly against the resource URL. A stable, immutable URL therefore skips
recompilation on repeat visits, which for a module this size is worth more than the transfer saving.

## Range requests

Serve `Accept-Ranges: bytes` and honor `Range` on whatever hosts your package index, if you host
one. uv fetches PEP 658 metadata sidecars and, where an index does not provide them, reads the
central directory of a wheel with a ranged request instead of downloading it whole. A host that
ignores `Range` turns a few kilobytes into a few megabytes per candidate version.

This does not apply to the engine artifact itself, which is fetched once, whole.

## Content Security Policy

The engine needs `wasm-unsafe-eval`, the directive that permits WebAssembly compilation. It does not
need `unsafe-eval`.

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  worker-src 'self';
  connect-src 'self' https://pypi.org https://files.pythonhosted.org;
```

Narrow `connect-src` to the indexes you configure. If you use the libcurl transport, add the
relay's `wss://` origin instead, every request goes there rather than to the index.

## Storage

Persistence uses OPFS, which needs no permission prompt and no headers. It is per-origin, so an
embedding page shares its quota with everything else on that origin. See
[privacy.md](privacy.md) for what is stored.

## Checking a deploy

```sh
curl -sI https://your.host/assets/engine_bg.wasm | grep -iE 'content-(type|encoding)|cache-control'
```

You want `application/wasm`, `br`, and an immutable `max-age`. Two of the three are wrong on most
default static hosts.
