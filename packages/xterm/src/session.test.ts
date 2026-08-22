import { describe, expect, it } from "vitest";
import { type EngineLike, type ExecHandleLike, runInTerminal } from "./run.js";
import { attachTerminal, splitArgv, UnterminatedQuote } from "./session.js";
import { FakeTerminal } from "./testing/fake-terminal.js";

const encoder = new TextEncoder();

interface Invocation {
  argv: string[];
  tty?: { cols: number; rows: number };
  resizes: { cols: number; rows: number }[];
  cancels: string[];
}

function fakeEngine(
  behavior: (argv: string[], emit: (stream: "stdout" | "stderr", text: string) => void) => number,
): EngineLike & { calls: Invocation[]; release: (() => void) | undefined } {
  const calls: Invocation[] = [];
  const engine = {
    calls,
    release: undefined as (() => void) | undefined,
    exec(argv: string[], options: Parameters<EngineLike["exec"]>[1]): ExecHandleLike {
      const call: Invocation = {
        argv,
        ...(options.tty === undefined ? {} : { tty: options.tty }),
        resizes: [],
        cancels: [],
      };
      calls.push(call);
      const emit = (stream: "stdout" | "stderr", text: string): void => {
        const sink = stream === "stdout" ? options.stdout : options.stderr;
        sink?.(encoder.encode(text));
      };
      const code = behavior(argv, emit);
      return {
        exit: Promise.resolve({ code, cancelled: false }),
        resize: (size) => call.resizes.push(size),
        cancel: (reason) => call.cancels.push(reason ?? ""),
      };
    },
  };
  return engine;
}

describe("a typed line becomes an argv the way a shell would read it", () => {
  it("splits on whitespace", () => {
    expect(splitArgv("uv pip install idna")).toEqual(["uv", "pip", "install", "idna"]);
  });

  it("keeps a quoted argument together", () => {
    expect(splitArgv(`uv pip install "a b" 'c d'`)).toEqual(["uv", "pip", "install", "a b", "c d"]);
  });

  it("keeps an empty quoted argument, which is not the same as no argument", () => {
    expect(splitArgv(`uv run ""`)).toEqual(["uv", "run", ""]);
  });

  it("honors a backslash escape outside single quotes", () => {
    expect(splitArgv(`uv run a\\ b`)).toEqual(["uv", "run", "a b"]);
    expect(splitArgv(`uv run 'a\\ b'`)).toEqual(["uv", "run", "a\\ b"]);
  });

  it("refuses a line that ends inside a quote rather than guessing", () => {
    expect(() => splitArgv(`uv pip install "unclosed`)).toThrow(UnterminatedQuote);
  });

  it("reads a blank line as no command at all", () => {
    expect(splitArgv("   ")).toEqual([]);
  });
});

describe("running a command sends its bytes to the terminal untouched", () => {
  it("writes stdout and stderr verbatim", async () => {
    const terminal = new FakeTerminal();
    const engine = fakeEngine((_argv, emit) => {
      emit("stdout", "Resolved 1 package\r\n");
      emit("stderr", "warning: none\r\n");
      return 0;
    });

    const result = await runInTerminal(terminal, engine, ["uv", "pip", "list"]);
    expect(result.code).toBe(0);
    expect(terminal.text).toBe("Resolved 1 package\r\nwarning: none\r\n");
  });

  it("tells the engine the terminal's size, and forwards a resize", async () => {
    const terminal = new FakeTerminal();
    terminal.cols = 120;
    terminal.rows = 40;
    const engine = fakeEngine(() => 0);

    const running = runInTerminal(terminal, engine, ["uv", "--help"]);
    terminal.resize(80, 24);
    await running;

    expect(engine.calls[0]?.tty).toEqual({ cols: 120, rows: 40 });
    expect(engine.calls[0]?.resizes).toEqual([{ cols: 80, rows: 24 }]);
  });

  it("cancels on ctrl-c and escalates to terminate on the second", async () => {
    const terminal = new FakeTerminal();
    const engine = fakeEngine(() => 0);
    const seen: number[] = [];

    const running = runInTerminal(terminal, engine, ["uv", "lock"], {
      onInterrupt: (times) => seen.push(times),
    });
    terminal.type("\x03");
    terminal.type("\x03");
    await running;

    expect(seen).toEqual([1, 2]);
    expect(engine.calls[0]?.cancels).toEqual(["interrupt", "terminate"]);
  });

  it("lets go of its listeners when the command ends", async () => {
    const terminal = new FakeTerminal();
    const engine = fakeEngine(() => 0);
    await runInTerminal(terminal, engine, ["uv", "--version"]);
    expect(terminal.listeners).toBe(0);
  });
});

describe("a session reads lines, runs them, and prompts again", () => {
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("greets with the motd and shows a prompt", () => {
    const terminal = new FakeTerminal();
    attachTerminal(
      terminal,
      fakeEngine(() => 0),
      { motd: "uv-wasm ready" },
    );
    expect(terminal.text).toContain("uv-wasm ready\r\n");
    expect(terminal.text.endsWith("uv$ ")).toBe(true);
  });

  it("runs what was typed and strips the program name the prompt already shows", async () => {
    const terminal = new FakeTerminal();
    const engine = fakeEngine(() => 0);
    attachTerminal(terminal, engine);

    terminal.type("uv pip list\r");
    await settle();

    expect(engine.calls[0]?.argv).toEqual(["pip", "list"]);
  });

  it("runs a bare command as uv's, so `pip list` and `uv pip list` agree", async () => {
    const terminal = new FakeTerminal();
    const engine = fakeEngine(() => 0);
    attachTerminal(terminal, engine);

    terminal.type("pip list\r");
    await settle();

    expect(engine.calls[0]?.argv).toEqual(["pip", "list"]);
  });

  it("shows help when the program name is typed with nothing after it", async () => {
    const terminal = new FakeTerminal();
    const engine = fakeEngine(() => 0);
    attachTerminal(terminal, engine);

    terminal.type("uv\r");
    await settle();

    expect(engine.calls[0]?.argv).toEqual(["--help"]);
  });

  it("gives a host builtin the line instead of the engine", async () => {
    const terminal = new FakeTerminal();
    const engine = fakeEngine(() => 0);
    const seen: string[][] = [];
    attachTerminal(terminal, engine, {
      commands: {
        python: ({ argv, write }) => {
          seen.push(argv);
          write("Python 3.14.0\r\n");
          return 0;
        },
      },
    });

    terminal.type("python -c 'print(1)'\r");
    await settle();

    expect(seen).toEqual([["python", "-c", "print(1)"]]);
    expect(engine.calls).toEqual([]);
    expect(terminal.text).toContain("Python 3.14.0\r\n");
  });

  it("reports an unterminated quote rather than running anything", async () => {
    const terminal = new FakeTerminal();
    const engine = fakeEngine(() => 0);
    attachTerminal(terminal, engine);

    terminal.type(`uv pip install "oops\r`);
    await settle();

    expect(engine.calls).toEqual([]);
    expect(terminal.text).toContain("ends inside a");
  });

  it("does nothing for a blank line but still prompts", async () => {
    const terminal = new FakeTerminal();
    const engine = fakeEngine(() => 0);
    attachTerminal(terminal, engine);
    terminal.chunks.length = 0;

    terminal.type("\r");
    await settle();

    expect(engine.calls).toEqual([]);
    expect(terminal.text.endsWith("uv$ ")).toBe(true);
  });

  it("keeps what was run in history the host can read back", async () => {
    const terminal = new FakeTerminal();
    const session = attachTerminal(
      terminal,
      fakeEngine(() => 0),
    );

    terminal.type("uv --version\r");
    await settle();

    expect(session.history).toEqual(["uv --version"]);
  });

  it("runs a line the host submits without anyone typing it", async () => {
    const terminal = new FakeTerminal();
    const engine = fakeEngine(() => 3);
    const session = attachTerminal(terminal, engine);

    await expect(session.executeLine("uv pip check")).resolves.toBe(3);
    expect(engine.calls[0]?.argv).toEqual(["pip", "check"]);
  });

  it("stops listening once disposed, so a second session cannot double-run a line", async () => {
    const terminal = new FakeTerminal();
    const engine = fakeEngine(() => 0);
    const session = attachTerminal(terminal, engine);

    session.dispose();
    terminal.type("uv pip list\r");
    await settle();

    expect(engine.calls).toEqual([]);
    expect(terminal.listeners).toBe(0);
  });
});
