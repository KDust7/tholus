import { describe, expect, it } from "vitest";
import { LineEditor, PASTE_END, PASTE_START } from "./line-editor.js";

const editor = (history?: string[]): LineEditor =>
  new LineEditor({ prompt: "> ", ...(history === undefined ? {} : { history }) });

const type = (line: LineEditor, ...inputs: string[]): string[] =>
  inputs.flatMap((input) => line.input(input).lines);

describe("typing builds a line and enter submits it", () => {
  it("collects printable characters in order", () => {
    const line = editor();
    expect(type(line, "uv pip list")).toEqual([]);
    expect(line.value).toBe("uv pip list");
    expect(type(line, "\r")).toEqual(["uv pip list"]);
    expect(line.value).toBe("");
  });

  it("redraws the whole line so the terminal never has to guess", () => {
    const line = editor();
    const result = line.input("ab");
    expect(result.output.endsWith("> ab")).toBe(true);
    expect(result.output.startsWith("\r\x1b[K")).toBe(true);
  });

  it("ignores control characters it has no meaning for", () => {
    const line = editor();
    line.input("a\x1cb");
    expect(line.value).toBe("ab");
  });

  it("submits a line for each newline in one burst of input", () => {
    const line = editor();
    expect(type(line, "one\rtwo\r")).toEqual(["one", "two"]);
  });
});

describe("editing moves within the line rather than only at its end", () => {
  it("backspaces the character before the cursor", () => {
    const line = editor();
    line.input("abc\x7f");
    expect(line.value).toBe("ab");
  });

  it("inserts where the cursor is, not at the end", () => {
    const line = editor();
    line.input("ac");
    line.input("\x1b[D");
    line.input("b");
    expect(line.value).toBe("abc");
    expect(line.position).toBe(2);
  });

  it("moves to the start and the end", () => {
    const line = editor();
    line.input("abc");
    line.input("\x01");
    expect(line.position).toBe(0);
    line.input("\x05");
    expect(line.position).toBe(3);
  });

  it("deletes forwards with the delete key", () => {
    const line = editor();
    line.input("abc");
    line.input("\x1b[H");
    line.input("\x1b[3~");
    expect(line.value).toBe("bc");
  });

  it("kills to the start, to the end and by word", () => {
    const killStart = editor();
    killStart.input("abc def");
    killStart.input("\x15");
    expect(killStart.value).toBe("");

    const killEnd = editor();
    killEnd.input("abc def");
    killEnd.input("\x1b[H");
    killEnd.input("\x0b");
    expect(killEnd.value).toBe("");

    const killWord = editor();
    killWord.input("abc def");
    killWord.input("\x17");
    expect(killWord.value).toBe("abc ");
  });

  it("refuses to move the cursor outside the line", () => {
    const line = editor();
    line.input("\x1b[D");
    expect(line.position).toBe(0);
    line.input("ab\x1b[C\x1b[C");
    expect(line.position).toBe(2);
  });
});

describe("ctrl-c abandons the line without running it", () => {
  it("reports the cancellation, echoes it and clears the buffer", () => {
    const line = editor();
    line.input("half-typed");
    const result = line.input("\x03");
    expect(result.cancelled).toBe(true);
    expect(result.lines).toEqual([]);
    expect(result.output).toContain("^C\r\n");
    expect(line.value).toBe("");
  });

  it("does not put the abandoned line into history", () => {
    const line = editor();
    line.input("half-typed\x03");
    expect(line.history).toEqual([]);
  });
});

describe("history recalls what was run, and only what was run", () => {
  it("walks back and forward through earlier lines", () => {
    const line = editor(["first", "second"]);
    line.input("\x1b[A");
    expect(line.value).toBe("second");
    line.input("\x1b[A");
    expect(line.value).toBe("first");
    line.input("\x1b[B");
    expect(line.value).toBe("second");
  });

  it("keeps the half-typed line and gives it back at the end of history", () => {
    const line = editor(["earlier"]);
    line.input("draft");
    line.input("\x1b[A");
    expect(line.value).toBe("earlier");
    line.input("\x1b[B");
    expect(line.value, "walking past the newest entry restores what was being typed").toBe("draft");
  });

  it("does not record blank lines or an immediate repeat", () => {
    const line = editor();
    line.input("\r");
    line.input("   \r");
    line.input("uv --version\r");
    line.input("uv --version\r");
    expect(line.history).toEqual(["uv --version"]);
  });

  it("forgets the oldest entries once it is full", () => {
    const line = new LineEditor({ historyLimit: 2 });
    line.input("a\rb\rc\r");
    expect(line.history).toEqual(["b", "c"]);
  });

  it("does nothing when there is no history to walk", () => {
    const line = editor();
    line.input("typed");
    line.input("\x1b[A");
    expect(line.value).toBe("typed");
  });
});

describe("a bracketed paste is text, never a sequence of keystrokes", () => {
  it("inserts the pasted text literally", () => {
    const line = editor();
    line.input(`${PASTE_START}uv pip install "a b"${PASTE_END}`);
    expect(line.value).toBe('uv pip install "a b"');
  });

  it("submits each complete line of a multi-line paste", () => {
    const line = editor();
    const result = line.input(`${PASTE_START}one\ntwo\nthree${PASTE_END}`);
    expect(result.lines).toEqual(["one", "two"]);
    expect(line.value).toBe("three");
  });

  it("survives a paste split across two chunks of input", () => {
    const line = editor();
    line.input(`${PASTE_START}uv pip `);
    line.input(`list${PASTE_END}`);
    expect(line.value).toBe("uv pip list");
  });

  it("does not treat a control character inside a paste as an edit", () => {
    const line = editor();
    line.input(`${PASTE_START}a\x7fb${PASTE_END}`);
    expect(line.value, "a paste is data; backspace inside it must not delete").toBe("a\x7fb");
  });
});
