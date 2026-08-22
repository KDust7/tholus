import { LineEditor } from "./line-editor.js";
import { type EngineLike, type ExecResultLike, runInTerminal } from "./run.js";
import type { Disposable, TerminalLike } from "./terminal.js";
import { TerminalWriter } from "./terminal.js";

export interface CommandContext {
  argv: string[];
  write(text: string): void;
  engine: EngineLike;
}

export type Builtin = (context: CommandContext) => Promise<number> | number;

export interface AttachOptions {
  prompt?: string;
  program?: string;
  commands?: Record<string, Builtin>;
  history?: string[];
  motd?: string;
  cwd?: string;
}

export interface TerminalSession {
  readonly history: string[];
  executeLine(line: string): Promise<number>;
  dispose(): void;
}

export class UnterminatedQuote extends Error {
  constructor(quote: string) {
    super(`the command ends inside a ${quote} quote`);
    this.name = "UnterminatedQuote";
  }
}

export function splitArgv(line: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    if (char === "\\" && index + 1 < line.length && quote !== "'") {
      current += line[index + 1] as string;
      started = true;
      index += 1;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === " " || char === "\t") {
      if (started) {
        argv.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (quote !== undefined) {
    throw new UnterminatedQuote(quote);
  }
  if (started) {
    argv.push(current);
  }
  return argv;
}

export function attachTerminal(
  terminal: TerminalLike,
  engine: EngineLike,
  options: AttachOptions = {},
): TerminalSession {
  const program = options.program ?? "uv";
  const editor = new LineEditor({
    prompt: options.prompt ?? `${program}$ `,
    ...(options.history === undefined ? {} : { history: options.history }),
  });
  const writer = new TerminalWriter(terminal);
  const builtins = options.commands ?? {};

  let running = false;
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();

  const write = (text: string): void => writer.write(text);

  const prompt = (): void => {
    write(editor.render());
  };

  const execute = async (line: string): Promise<number> => {
    let argv: string[];
    try {
      argv = splitArgv(line);
    } catch (error) {
      write(`${error instanceof Error ? error.message : String(error)}\r\n`);
      return 2;
    }
    if (argv.length === 0) {
      return 0;
    }
    if (argv[0] === program) {
      argv = argv.slice(1);
      if (argv.length === 0) {
        argv = ["--help"];
      }
    }

    const builtin = builtins[argv[0] as string];
    if (builtin !== undefined) {
      return builtin({ argv, write, engine });
    }

    running = true;
    try {
      const result: ExecResultLike = await runInTerminal(terminal, engine, [program, ...argv], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        writer,
      });
      return result.code;
    } finally {
      running = false;
    }
  };

  const onData = terminal.onData((data) => {
    if (disposed || running) {
      return;
    }
    const result = editor.input(data);
    write(result.output);
    for (const line of result.lines) {
      queue = queue.then(async () => {
        if (disposed) {
          return;
        }
        await execute(line);
        if (!disposed) {
          prompt();
        }
      });
    }
    if (result.cancelled) {
      prompt();
    }
  });

  const listeners: Disposable[] = [onData];

  if (options.motd !== undefined) {
    write(`${options.motd.replace(/\n/g, "\r\n")}\r\n`);
  }
  prompt();

  return {
    get history(): string[] {
      return [...editor.history];
    },
    executeLine(line: string): Promise<number> {
      const ran = queue.then(() => execute(line));
      queue = ran.then(
        () => undefined,
        () => undefined,
      );
      return ran;
    },
    dispose(): void {
      disposed = true;
      for (const listener of listeners) {
        listener.dispose();
      }
    },
  };
}
