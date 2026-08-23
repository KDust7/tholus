# @uv-wasm/xterm

25 public exports.

```ts
export interface AttachOptions {
    prompt?: string;
    program?: string;
    commands?: Record<string, Builtin>;
    history?: string[];
    motd?: string;
    cwd?: string;
}

export declare function attachTerminal(terminal: TerminalLike, engine: EngineLike, options?: AttachOptions): TerminalSession;

export type Builtin = (context: CommandContext) => Promise<number> | number;

export interface CommandContext {
    argv: string[];
    write(text: string): void;
    engine: EngineLike;
}

CTRL_C = "\u0003"

export interface Disposable {
    dispose(): void;
}

export interface EditorResult {
    output: string;
    lines: string[];
    cancelled: boolean;
}

export interface EngineLike {
    exec(argv: string[], options: {
        cwd?: string;
        tty?: {
            cols: number;
            rows: number;
        };
        stdout?: (chunk: Uint8Array) => void;
        stderr?: (chunk: Uint8Array) => void;
    }): ExecHandleLike;
}

EOL_WARNING: string

export interface ExecHandleLike {
    readonly exit: Promise<ExecResultLike>;
    resize(size: {
        cols: number;
        rows: number;
    }): void;
    cancel(reason?: string): void;
}

export interface ExecResultLike {
    code: number;
    cancelled: boolean;
}

HIGH_WATER_BYTES: number

export declare class LineEditor {
    private buffer;
    private cursor;
    private pasting;
    private browsing;
    private draft;
    readonly history: string[];
    private readonly limit;
    prompt: string;
    constructor(options?: LineEditorOptions);
    get value(): string;
    get position(): number;
    render(): string;
    reset(): void;
    remember(line: string): void;
    private insert;
    private recall;
    private submit;
    input(data: string): EditorResult;
    private pasteChunk;
    private step;
    private controlSequence;
}

export interface LineEditorOptions {
    prompt?: string;
    history?: string[];
    historyLimit?: number;
}

PASTE_END = "\u001B[201~"

PASTE_START = "\u001B[200~"

export declare function runInTerminal(terminal: TerminalLike, engine: EngineLike, argv: string[], options?: RunOptions): Promise<ExecResultLike>;

export interface RunOptions {
    cwd?: string;
    writer?: TerminalWriter;
    onInterrupt?: (times: number) => void;
    terminateAfter?: number;
}

export declare function splitArgv(line: string): string[];

export interface TerminalLike {
    readonly cols: number;
    readonly rows: number;
    readonly options?: {
        convertEol?: boolean;
    };
    write(data: string | Uint8Array, callback?: () => void): void;
    onData(listener: (data: string) => void): Disposable;
    onResize(listener: (size: TerminalSize) => void): Disposable;
}

export interface TerminalSession {
    readonly history: string[];
    executeLine(line: string): Promise<number>;
    dispose(): void;
}

export interface TerminalSize {
    cols: number;
    rows: number;
}

export declare class TerminalWriter {
    private readonly terminal;
    private readonly highWater;
    private pending;
    private queue;
    private draining;
    private idle;
    constructor(terminal: TerminalLike, highWater?: number);
    get backlog(): number;
    write(data: string | Uint8Array): void;
    private pump;
    private flushCombined;
    private send;
    drained(): Promise<void>;
}

export declare class UnterminatedQuote extends Error {
    constructor(quote: string);
}

export declare function warnUnlessConvertingEol(terminal: TerminalLike, report?: (message: string) => void): void;
```
