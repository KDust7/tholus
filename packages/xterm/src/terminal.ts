export interface Disposable {
  dispose(): void;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalLike {
  readonly cols: number;
  readonly rows: number;
  readonly options?: { convertEol?: boolean };
  write(data: string | Uint8Array, callback?: () => void): void;
  onData(listener: (data: string) => void): Disposable;
  onResize(listener: (size: TerminalSize) => void): Disposable;
}

export const EOL_WARNING =
  "uv writes bare LF, so a terminal without `convertEol: true` renders its output as a staircase. " +
  "Set it when constructing the terminal.";

const warned = new WeakSet<object>();

export function warnUnlessConvertingEol(
  terminal: TerminalLike,
  report: (message: string) => void = (message) => console.warn(message),
): void {
  if (terminal.options?.convertEol !== false || warned.has(terminal)) {
    return;
  }
  warned.add(terminal);
  report(EOL_WARNING);
}

export const HIGH_WATER_BYTES = 256 * 1024;

export class TerminalWriter {
  private pending = 0;
  private queue: (string | Uint8Array)[] = [];
  private draining = false;
  private idle: (() => void)[] = [];

  constructor(
    private readonly terminal: TerminalLike,
    private readonly highWater: number = HIGH_WATER_BYTES,
  ) {}

  get backlog(): number {
    return this.pending;
  }

  write(data: string | Uint8Array): void {
    if (data.length === 0) {
      return;
    }
    this.queue.push(data);
    this.pending += data.length;
    this.pump();
  }

  private pump(): void {
    if (this.draining || this.queue.length === 0) {
      return;
    }
    if (this.pending > this.highWater && this.queue.length > 1) {
      this.flushCombined();
      return;
    }
    this.send(this.queue.shift() as string | Uint8Array);
  }

  private flushCombined(): void {
    const chunks = this.queue;
    this.queue = [];
    const text = chunks.every((chunk) => typeof chunk === "string");
    if (text) {
      this.send((chunks as string[]).join(""));
      return;
    }
    const encoder = new TextEncoder();
    const encoded = chunks.map((chunk) =>
      typeof chunk === "string" ? encoder.encode(chunk) : chunk,
    );
    const merged = new Uint8Array(encoded.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of encoded) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.send(merged);
  }

  private send(chunk: string | Uint8Array): void {
    this.draining = true;
    this.terminal.write(chunk, () => {
      this.draining = false;
      this.pending = Math.max(0, this.pending - chunk.length);
      if (this.queue.length > 0) {
        this.pump();
        return;
      }
      const waiting = this.idle;
      this.idle = [];
      for (const resolve of waiting) {
        resolve();
      }
    });
  }

  drained(): Promise<void> {
    if (this.queue.length === 0 && !this.draining) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.idle.push(resolve));
  }
}
