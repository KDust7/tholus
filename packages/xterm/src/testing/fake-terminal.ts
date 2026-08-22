import type { Disposable, TerminalLike, TerminalSize } from "../terminal.js";

export class FakeTerminal implements TerminalLike {
  cols = 80;
  rows = 24;
  readonly chunks: string[] = [];
  private readonly decoder = new TextDecoder();
  private readonly data = new Set<(data: string) => void>();
  private readonly resizes = new Set<(size: TerminalSize) => void>();
  private readonly callbacks: (() => void)[] = [];

  constructor(readonly deferred = false) {}

  write(data: string | Uint8Array, callback?: () => void): void {
    this.chunks.push(typeof data === "string" ? data : this.decoder.decode(data, { stream: true }));
    if (callback === undefined) {
      return;
    }
    if (this.deferred) {
      this.callbacks.push(callback);
    } else {
      callback();
    }
  }

  flush(): void {
    while (this.callbacks.length > 0) {
      (this.callbacks.shift() as () => void)();
    }
  }

  onData(listener: (data: string) => void): Disposable {
    this.data.add(listener);
    return { dispose: () => this.data.delete(listener) };
  }

  onResize(listener: (size: TerminalSize) => void): Disposable {
    this.resizes.add(listener);
    return { dispose: () => this.resizes.delete(listener) };
  }

  type(text: string): void {
    for (const listener of [...this.data]) {
      listener(text);
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    for (const listener of [...this.resizes]) {
      listener({ cols, rows });
    }
  }

  get text(): string {
    return this.chunks.join("");
  }

  get listeners(): number {
    return this.data.size + this.resizes.size;
  }
}
