# @uv-wasm/mock-engine

6 public exports.

```ts
export declare function createMockEngine(script?: MockScript): MockEngineEndpoint;

export declare function matchCommand(script: MockScript, argv: string[]): MockCommand | undefined;

export interface MockCommand {
    argv: string[];
    steps?: MockStep[];
    exitCode?: number;
    error?: StructuredErrorInfo;
}

export interface MockEngineEndpoint {
    postMessage(message: unknown): void;
    addEventListener(type: "message", listener: (event: {
        data: unknown;
    }) => void): void;
    removeEventListener(type: "message", listener: (event: {
        data: unknown;
    }) => void): void;
    terminate(): void;
    readonly received: HostMessage[];
    readonly emitted: WorkerMessage[];
}

export interface MockScript {
    build?: BuildIdentity;
    protocolVersion?: string;
    commands?: MockCommand[];
    unknownCommand?: {
        exitCode: number;
        error?: StructuredErrorInfo;
        steps?: MockStep[];
    };
}

export type MockStep = {
    kind: "stdout";
    text: string;
} | {
    kind: "stderr";
    text: string;
} | {
    kind: "event";
    event: EngineEvent;
} | {
    kind: "pause";
};
```
