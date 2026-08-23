import { describe, expect, it } from "vitest";
import { EOL_WARNING, TerminalWriter, warnUnlessConvertingEol } from "./terminal.js";
import { FakeTerminal } from "./testing/fake-terminal.js";

const encoder = new TextEncoder();

describe("writing to a terminal waits for it, rather than flooding it", () => {
  it("passes text straight through when the terminal keeps up", () => {
    const terminal = new FakeTerminal();
    const writer = new TerminalWriter(terminal);
    writer.write("one");
    writer.write("two");
    expect(terminal.chunks).toEqual(["one", "two"]);
  });

  it("keeps only one write in flight while the terminal is busy", () => {
    const terminal = new FakeTerminal(true);
    const writer = new TerminalWriter(terminal);
    writer.write("one");
    writer.write("two");
    expect(terminal.chunks, "the second write must wait for the first to be acknowledged").toEqual([
      "one",
    ]);
    terminal.flush();
    expect(terminal.chunks).toEqual(["one", "two"]);
  });

  it("coalesces the backlog into one write once it passes the high-water mark", () => {
    const terminal = new FakeTerminal(true);
    const writer = new TerminalWriter(terminal, 8);
    writer.write("first");
    writer.write("aaa");
    writer.write("bbb");
    writer.write("ccc");
    expect(terminal.chunks).toEqual(["first"]);

    terminal.flush();
    expect(terminal.chunks, "a backed-up terminal gets one combined write, not three").toEqual([
      "first",
      "aaabbbccc",
    ]);
  });

  it("reports the bytes still owed to the terminal", () => {
    const terminal = new FakeTerminal(true);
    const writer = new TerminalWriter(terminal);
    writer.write("12345");
    expect(writer.backlog).toBe(5);
    terminal.flush();
    expect(writer.backlog).toBe(0);
  });

  it("writes bytes as bytes, so uv's output is never re-encoded", () => {
    const terminal = new FakeTerminal();
    const writer = new TerminalWriter(terminal);
    writer.write(encoder.encode("Résolu ✓"));
    expect(terminal.text).toBe("Résolu ✓");
  });

  it("combines byte chunks without decoding them one at a time", () => {
    const terminal = new FakeTerminal(true);
    const writer = new TerminalWriter(terminal, 4);
    const snowman = encoder.encode("☃");
    writer.write("start");
    writer.write(snowman.subarray(0, 1));
    writer.write(snowman.subarray(1, 2));
    writer.write(snowman.subarray(2, 3));
    terminal.flush();
    expect(terminal.text, "a multi-byte character split across chunks must survive").toBe("start☃");
  });

  it("ignores an empty write rather than queueing nothing", () => {
    const terminal = new FakeTerminal();
    const writer = new TerminalWriter(terminal);
    writer.write("");
    expect(terminal.chunks).toEqual([]);
  });

  it("settles once everything has been acknowledged", async () => {
    const terminal = new FakeTerminal(true);
    const writer = new TerminalWriter(terminal);
    writer.write("one");
    writer.write("two");

    let settled = false;
    const waiting = writer.drained().then(() => {
      settled = true;
    });
    expect(settled).toBe(false);

    terminal.flush();
    await waiting;
    expect(settled).toBe(true);
  });

  it("settles immediately when there is nothing owed", async () => {
    const writer = new TerminalWriter(new FakeTerminal());
    await expect(writer.drained()).resolves.toBeUndefined();
  });
});

describe("a coalesced batch is measured in bytes, not in javascript characters", () => {
  it("merges a non-ascii string with byte chunks without truncating it", () => {
    const terminal = new FakeTerminal(true);
    const writer = new TerminalWriter(terminal, 4);
    writer.write("start");
    writer.write("Résolu ✓");
    writer.write(encoder.encode(" ☃"));
    writer.write("!");
    terminal.flush();
    expect(
      terminal.text,
      "a string's length counts utf-16 units, so sizing the buffer by it under-allocates",
    ).toBe("startRésolu ✓ ☃!");
  });
});

describe("a terminal that will not convert uv's bare newlines", () => {
  const complaints = (options?: { convertEol?: boolean }): string[] => {
    const said: string[] = [];
    const terminal = new FakeTerminal();
    const subject = options === undefined ? terminal : Object.assign(terminal, { options });
    warnUnlessConvertingEol(subject, (message) => said.push(message));
    warnUnlessConvertingEol(subject, (message) => said.push(message));
    return said;
  };

  it("is told once, because uv writes LF and a terminal without the option staircases", () => {
    expect(complaints({ convertEol: false })).toEqual([EOL_WARNING]);
  });

  it("is left alone when it converts", () => {
    expect(complaints({ convertEol: true })).toEqual([]);
  });

  it("is left alone when it says nothing either way, since xterm.js is not the only terminal", () => {
    expect(complaints()).toEqual([]);
  });
});
