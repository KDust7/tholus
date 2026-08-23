# @uv-wasm/transport-libcurl

12 public exports.

```ts
export declare function assertLibcurlShape(module: unknown, wantsWasmUrl: boolean): LibcurlModule;

export declare function assertRelayUrl(relayUrl: string): void;

export declare function createLibcurlTransport(options: LibcurlTransportOptions): LibcurlTransport;

DEFAULT_CONNECTION_CACHE = 50

DEFAULT_CONNECTIONS_PER_HOST = 16

DEFAULT_MAX_CONNECTIONS = 60

export interface LibcurlModule {
    set_websocket(url: string): void;
    load_wasm?(url?: string): Promise<unknown>;
    HTTPSession: new (options?: {
        enable_cookies?: boolean;
        proxy?: string;
    }) => LibcurlSession;
}

export interface LibcurlSession {
    fetch(input: string, init?: RequestInit): Promise<Response>;
    set_connections(total: number, cache: number, perHost: number): void;
    close(): void;
}

export interface LibcurlTransport extends ProxyTransport {
    dispose(): Promise<void>;
}

export interface LibcurlTransportOptions {
    load: () => Promise<LibcurlModule>;
    relayUrl: string;
    wasmUrl?: string;
    userAgent?: string;
    maxConnections?: number;
    connectionCache?: number;
    connectionsPerHost?: number;
}

export interface ProxyTransport {
    fetch(input: string, init?: RequestInit): Promise<Response>;
}

export declare function withUserAgent(headers: Headers, userAgent: string | undefined): Headers;
```
