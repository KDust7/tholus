export interface EditorResult {
  output: string;
  lines: string[];
  cancelled: boolean;
}

export interface LineEditorOptions {
  prompt?: string;
  history?: string[];
  historyLimit?: number;
}

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

const DEFAULT_HISTORY_LIMIT = 500;
const CLEAR_LINE = "\r\x1b[K";

export class LineEditor {
  private buffer = "";
  private cursor = 0;
  private pasting = false;
  private browsing: number | undefined;
  private draft = "";
  readonly history: string[];
  private readonly limit: number;
  prompt: string;

  constructor(options: LineEditorOptions = {}) {
    this.prompt = options.prompt ?? "$ ";
    this.history = [...(options.history ?? [])];
    this.limit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  }

  get value(): string {
    return this.buffer;
  }

  get position(): number {
    return this.cursor;
  }

  render(): string {
    const trailing = this.buffer.length - this.cursor;
    const back = trailing > 0 ? `\x1b[${trailing}D` : "";
    return `${CLEAR_LINE}${this.prompt}${this.buffer}${back}`;
  }

  reset(): void {
    this.buffer = "";
    this.cursor = 0;
    this.browsing = undefined;
    this.draft = "";
  }

  remember(line: string): void {
    if (line.trim() === "" || this.history.at(-1) === line) {
      return;
    }
    this.history.push(line);
    while (this.history.length > this.limit) {
      this.history.shift();
    }
  }

  private insert(text: string): string {
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
    return this.render();
  }

  private recall(step: number): string {
    if (this.history.length === 0) {
      return "";
    }
    if (this.browsing === undefined) {
      if (step > 0) {
        return "";
      }
      this.draft = this.buffer;
      this.browsing = this.history.length;
    }
    this.browsing = Math.min(Math.max(this.browsing + step, 0), this.history.length);
    this.buffer =
      this.browsing === this.history.length ? this.draft : (this.history[this.browsing] as string);
    this.cursor = this.buffer.length;
    return this.render();
  }

  private submit(result: EditorResult): void {
    result.lines.push(this.buffer);
    this.remember(this.buffer);
    this.reset();
    result.output += "\r\n";
  }

  input(data: string): EditorResult {
    const result: EditorResult = { output: "", lines: [], cancelled: false };
    let rest = data;

    while (rest.length > 0) {
      if (this.pasting) {
        const end = rest.indexOf(PASTE_END);
        const chunk = end === -1 ? rest : rest.slice(0, end);
        rest = end === -1 ? "" : rest.slice(end + PASTE_END.length);
        this.pasting = end === -1;
        this.pasteChunk(chunk, result);
        continue;
      }
      if (rest.startsWith(PASTE_START)) {
        this.pasting = true;
        rest = rest.slice(PASTE_START.length);
        continue;
      }
      rest = rest.slice(this.step(rest, result));
    }

    return result;
  }

  private pasteChunk(chunk: string, result: EditorResult): void {
    const parts = chunk.replace(/\r\n?/g, "\n").split("\n");
    for (const [index, part] of parts.entries()) {
      if (index > 0) {
        this.submit(result);
      }
      if (part !== "") {
        result.output += this.insert(part);
      }
    }
  }

  private step(rest: string, result: EditorResult): number {
    const sequence = this.controlSequence(rest, result);
    if (sequence !== undefined) {
      return sequence;
    }

    const char = rest[0] as string;
    switch (char) {
      case "\r":
      case "\n":
        this.submit(result);
        return 1;
      case "\x03":
        result.cancelled = true;
        this.reset();
        result.output += "^C\r\n";
        return 1;
      case "\x7f":
      case "\b":
        if (this.cursor > 0) {
          this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
          this.cursor -= 1;
          result.output += this.render();
        }
        return 1;
      case "\x01":
        this.cursor = 0;
        result.output += this.render();
        return 1;
      case "\x05":
        this.cursor = this.buffer.length;
        result.output += this.render();
        return 1;
      case "\x15":
        this.buffer = this.buffer.slice(this.cursor);
        this.cursor = 0;
        result.output += this.render();
        return 1;
      case "\x0b":
        this.buffer = this.buffer.slice(0, this.cursor);
        result.output += this.render();
        return 1;
      case "\x17": {
        const upto = this.buffer.slice(0, this.cursor).replace(/\S*\s*$/, "");
        this.buffer = upto + this.buffer.slice(this.cursor);
        this.cursor = upto.length;
        result.output += this.render();
        return 1;
      }
      default:
        break;
    }

    if (char < " " || char === "\x1b") {
      return 1;
    }
    result.output += this.insert(char);
    return 1;
  }

  private controlSequence(rest: string, result: EditorResult): number | undefined {
    const moves: Record<string, () => void> = {
      "\x1b[D": () => {
        this.cursor = Math.max(0, this.cursor - 1);
      },
      "\x1b[C": () => {
        this.cursor = Math.min(this.buffer.length, this.cursor + 1);
      },
      "\x1b[H": () => {
        this.cursor = 0;
      },
      "\x1b[F": () => {
        this.cursor = this.buffer.length;
      },
    };

    for (const [sequence, move] of Object.entries(moves)) {
      if (rest.startsWith(sequence)) {
        move();
        result.output += this.render();
        return sequence.length;
      }
    }

    if (rest.startsWith("\x1b[A")) {
      result.output += this.recall(-1);
      return 3;
    }
    if (rest.startsWith("\x1b[B")) {
      result.output += this.recall(1);
      return 3;
    }
    if (rest.startsWith("\x1b[3~")) {
      if (this.cursor < this.buffer.length) {
        this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
        result.output += this.render();
      }
      return 4;
    }
    return undefined;
  }
}
