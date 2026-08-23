# Transports

uv reaches a package index through `fetch`. In a browser that is not always the `fetch` you want, so
the engine lets a host choose. A transport is anything shaped like `ProxyTransport`:

```ts
interface ProxyTransport {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
```

The chosen transport is installed over `globalThis.fetch` inside the worker, before the engine
boots. uv itself is unaware of it.

## Choosing one

```ts
const engine = await createEngine({ config: { transport: { kind: "platform" } } });
```

| `kind` | What it does | When |
| --- | --- | --- |
| `platform` *(default)* | Leaves the ambient `fetch` untouched. | The index allows cross-origin reads, or you proxy at the server. |
| `fetch` | Wraps the ambient `fetch` with the rewrites below. | The index answers `HEAD` badly, or you want the range behavior normalized. |
| `libcurl` | Routes every request through a Wisp relay via `libcurl.js`. | You need CORS-free access, real cookies, or uv's own `User-Agent` to reach the index. |

## Why `platform` is the default, and not this one

The plan calls fetch the default, and it is: `{kind:"platform"}` is the browser's own `fetch`,
installed by nobody and rewritten by nobody. `{kind:"fetch"}` is a rewriting layer *over* fetch, and
promoting it to the default would be a behavior change rather than a naming one. Two reasons not to:

- The HEAD rewrite trades a safelisted request for a preflighted one. A bare `HEAD` with no
  custom headers is a CORS *simple* request. `Range` is not a safelisted request header, so
  `GET`+`Range` needs the index to answer an `OPTIONS` preflight with
  `Access-Control-Allow-Headers: Range`. PyPI does. A private devpi, Artifactory or Nexus mirror,
  which is where uv users live, may not, so the rewrite can manufacture CORS failures the untouched
  path never had.
- A server that ignores `Range` answers with 200 and the whole body. There is then no
  `Content-Range` to read a length from, so a question about a wheel's size becomes a download of
  it. That is a performance cliff with no error attached.

Both are reasons to keep the rewrite opt-in for the hosts that need it, which is exactly what an
index refusing `HEAD` looks like. `test/parity/transport-engine.test.ts` gates it either way: it
drives a real install through this transport and asserts no `HEAD` survived.

## `fetch`

Wraps the platform `fetch` and does four things:

- `HEAD` becomes `GET` with `Range: bytes=0-0`, and the one-byte reply is turned back into a
  `HEAD`-shaped 200 whose `content-length` comes from `Content-Range`'s total. Pass
  `rewriteHead: false` to send real `HEAD` requests.
- Range requests pass through unchanged.
- Forbidden request headers are stripped before the request is constructed, because the platform
  drops them anyway and leaving them in only produces confusing failures.
- `content-encoding` and `content-length` are dropped when the platform already decoded the body,
  so uv does not try to inflate something that is already inflated.

It never retries. uv owns retry policy, and a second layer of backoff would be invisible to it.

## `libcurl`

`libcurl.js` is a real curl compiled to WebAssembly, tunneling TCP over a WebSocket relay. It is not
bundled, the host supplies the module, because the worker is a single esbuild bundle and shipping
~6 MB of curl to every user for an opt-in path is not a trade worth making. Nothing in this repository
depends on `libcurl.js` at runtime.

```ts
const engine = await createEngine({
  config: {
    transport: {
      kind: "libcurl",
      moduleUrl: "https://cdn.example/libcurl.mjs",
      wasmUrl: "https://cdn.example/libcurl.wasm",
      relayUrl: "wss://relay.example/ws/",
      userAgent: "uv/0.12.3",
    },
  },
});
```

- `moduleUrl` is imported lazily, on the first request, not at boot. The loader accepts the module's
  `libcurl` named export, its default export, or the namespace itself.
- `relayUrl` must be `ws:` or `wss:` and must end in a trailing slash, libcurl appends the
  destination to it. Both are checked when the engine is configured, not when the first download
  fails.
- `userAgent` is the reason this transport exists. A browser `Request` silently drops `User-Agent`,
  `Cookie` and `Host`, so through the platform transport uv is indistinguishable from the page.
  libcurl sends whatever you give it, and if you give it nothing it sends the *browser's* own
  `User-Agent`, so set it yourself.
- `connectionsPerHost` defaults to 16. libcurl's own default is 6, which throttles an index badly.
  `maxConnections` (60) and `connectionCache` (50) are libcurl's defaults and rarely need changing.

You need a Wisp relay to use this. Running one is out of scope here.

`apps/demo` is the worked example: it takes a relay URL in the footer, and naming one rebuilds the
engine with this transport instead of reconfiguring the running one, because the transport is
installed in the worker before uv boots. The new engine is created before the old one is torn down,
so a relay that is refused leaves a working page. The demo serves `libcurl.mjs` and `libcurl.wasm`
from its own origin under `/libcurl/`; a deployment has to copy them there, see
[hosting.md](hosting.md).

## Writing your own

Any object with a `fetch` method will do, so a host can implement the seam over anything, a service
worker, a same-origin proxy, an Electron main process. That interface is the whole
contract; nothing else about a transport is observable to uv.

This is also the boundary that keeps AGPL-licensed proxy clients out of this repository. They are
host-loaded plugins behind the same `ProxyTransport` shape, never linked or shipped here.

## What a transport cannot fix

uv sets its own `User-Agent` on the reqwest client. On `wasm32-unknown-unknown` that header is
dropped when `web_sys::Request` is constructed, before any transport sees it, so the `userAgent`
option above is currently the only way to send one. Aliasing uv's header through to the transport is
not yet implemented.
