# @tholus/transport-fetch

9 public exports.

```ts
export declare function createFetchTransport(options?: FetchTransportOptions): ProxyTransport;

export declare function decodedHeaders(headers: Headers): Headers;

export interface FetchTransportOptions {
    fetch?: typeof globalThis.fetch;
    rewriteHead?: boolean;
}

FORBIDDEN_HEADERS: readonly string[]

export interface ProxyTransport {
    fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export declare function requestOf(input: string | Request, init?: RequestInit): Request;

export declare function stripForbidden(headers: Headers): Headers;

export declare function totalFromContentRange(value: string | null): number | undefined;

export declare function wasDecoded(headers: Headers): boolean;
```
