import type { Disposable, TerminalLike } from "./terminal.js";
import { TerminalWriter, warnUnlessConvertingEol } from "./terminal.js";

export interface ExecResultLike {
  code: number;
  cancelled: boolean;
}

export interface ExecHandleLike {
  readonly exit: Promise<ExecResultLike>;
  resize(size: { cols: number; rows: number }): void;
  cancel(reason?: string): void;
}

export interface EngineLike {
  exec(
    argv: string[],
    options: {
      cwd?: string;
      tty?: { cols: number; rows: number };
      stdout?: (chunk: Uint8Array) => void;
      stderr?: (chunk: Uint8Array) => void;
    },
  ): ExecHandleLike;
}

export interface RunOptions {
  cwd?: string;
  writer?: TerminalWriter;
  onInterrupt?: (times: number) => void;
  terminateAfter?: number;
}

export const CTRL_C = "\x03";

export async function runInTerminal(
  terminal: TerminalLike,
  engine: EngineLike,
  argv: string[],
  options: RunOptions = {},
): Promise<ExecResultLike> {
  warnUnlessConvertingEol(terminal);
  const writer = options.writer ?? new TerminalWriter(terminal);
  const terminateAfter = options.terminateAfter ?? 2;
  const handle = engine.exec(argv, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    tty: { cols: terminal.cols, rows: terminal.rows },
    stdout: (chunk) => writer.write(chunk),
    stderr: (chunk) => writer.write(chunk),
  });

  let interrupts = 0;
  const listeners: Disposable[] = [
    terminal.onData((data) => {
      if (!data.includes(CTRL_C)) {
        return;
      }
      interrupts += 1;
      options.onInterrupt?.(interrupts);
      handle.cancel(interrupts >= terminateAfter ? "terminate" : "interrupt");
    }),
    terminal.onResize((size) => handle.resize(size)),
  ];

  try {
    const result = await handle.exit;
    await writer.drained();
    return result;
  } finally {
    for (const listener of listeners) {
      listener.dispose();
    }
  }
}
