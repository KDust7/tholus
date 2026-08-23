import type { EngineEvent } from "@uv-wasm/engine-protocol";
import { describe, expect, it } from "vitest";

import { createReportReader, millisecondsOf, stripAnsi } from "./report-events.js";

const read = (chunks: string[]): EngineEvent[] => {
  const reader = createReportReader("inv-1");
  const events = chunks.flatMap((chunk) => reader.push(chunk));
  return [...events, ...reader.flush()];
};

const kinds = (events: EngineEvent[]): string[] => events.map((event) => event.type);

const reportOf = (events: EngineEvent[]) =>
  events.find((event) => event.type === "install-report") as
    | Extract<EngineEvent, { type: "install-report" }>
    | undefined;

const INSTALL = [
  "Using CPython 3.14.0 interpreter at: /bin/python3",
  "Creating virtual environment at: /work/.venv",
  "Resolved 1 package in 126ms",
  "Prepared 1 package in 88ms",
  "Installed 1 package in 30ms",
  " + idna==3.11",
  "",
].join("\n");

describe("uv's own words become the structured events the SDK promises", () => {
  it("reports what was installed, which is what `pip.install` resolves", () => {
    const report = reportOf(read([INSTALL]));
    expect(report?.installed).toEqual([{ name: "idna", version: "3.11" }]);
    expect(report?.removed).toEqual([]);
    expect(report?.unchanged).toBe(0);
  });

  it("reports the resolution separately, with its own count and duration", () => {
    const resolved = read([INSTALL]).find((event) => event.type === "resolution-complete");
    expect(resolved).toMatchObject({ packageCount: 1, durationMs: 126 });
  });

  it("opens and closes a phase for each step uv announces", () => {
    const phases = read([INSTALL])
      .filter((event) => event.type === "phase")
      .map((event) => `${event.phase}:${event.state}`);
    expect(phases).toEqual([
      "resolving:start",
      "resolving:end",
      "downloading:start",
      "downloading:end",
      "installing:start",
      "installing:end",
    ]);
  });

  it("emits the install report only after uv says the install finished", () => {
    const reader = createReportReader("inv-1");
    const early = reader.push("Resolved 1 package in 5ms\n + idna==3.11\n");
    expect(kinds(early)).not.toContain("install-report");
    const late = reader.push("Installed 1 package in 7ms\n");
    expect(kinds([...late, ...reader.flush()])).toContain("install-report");
  });
});

describe("the reader survives how the bytes actually arrive", () => {
  it("joins a line split across chunks", () => {
    const report = reportOf(read(["Installed 1 package in 3ms\n + id", "na==3.11\n"]));
    expect(report?.installed).toEqual([{ name: "idna", version: "3.11" }]);
  });

  it("reads a final line that never got its newline", () => {
    const report = reportOf(read(["Installed 1 package in 3ms\n + idna==3.11"]));
    expect(report?.installed).toEqual([{ name: "idna", version: "3.11" }]);
  });

  it("ignores the colors a terminal session adds", () => {
    const colored = "\u001B[2mInstalled \u001B[1m1 package\u001B[0m in 30ms\u001B[0m\n";
    const events = read([colored, " \u001B[32m+\u001B[39m \u001B[1midna\u001B[0m==3.11\n"]);
    expect(reportOf(events)?.installed).toEqual([{ name: "idna", version: "3.11" }]);
  });

  it("treats a carriage return as part of the line ending, not the text", () => {
    const report = reportOf(read(["Installed 1 package in 3ms\r\n + idna==3.11\r\n"]));
    expect(report?.installed).toEqual([{ name: "idna", version: "3.11" }]);
  });
});

describe("the shapes uv prints that are not a plain version", () => {
  it("keeps the URL when a package came from one, rather than inventing a version", () => {
    const report = reportOf(read(["Installed 1 package in 3ms\n + demo @ file:///work/demo\n"]));
    expect(report?.installed).toEqual([{ name: "demo", source: "file:///work/demo" }]);
  });

  it("separates removals and reinstalls from installs", () => {
    const report = reportOf(
      read([
        "Uninstalled 2 packages in 4ms",
        "\nInstalled 2 packages in 9ms\n",
        " - old==1.0\n + new==2.0\n ~ same==3.0\n",
      ]),
    );
    expect(report?.installed).toEqual([{ name: "new", version: "2.0" }]);
    expect(report?.removed).toEqual([{ name: "old", version: "1.0" }]);
    expect(report?.unchanged).toBe(1);
  });

  it("counts packages in the plural form too", () => {
    const resolved = read(["Resolved 12 packages in 1.5s\n"]).find(
      (event) => event.type === "resolution-complete",
    );
    expect(resolved).toMatchObject({ packageCount: 12, durationMs: 1500 });
  });

  it("says nothing at all when uv installed nothing", () => {
    expect(kinds(read(["Audited 3 packages in 2ms\n"]))).toEqual(["phase", "phase"]);
  });
});

describe("a source build is announced as it happens", () => {
  it("brackets each build with a start and an end", () => {
    const events = read([
      "Resolved 1 package in 5ms\n",
      "   Building idna==3.11\n      Built idna==3.11\n",
      "Installed 1 package in 3ms\n + idna==3.11\n",
    ]).filter((event) => event.type === "runtime-finalize");
    expect(events).toEqual([
      {
        type: "runtime-finalize",
        invocationId: "inv-1",
        package: { name: "idna", version: "3.11" },
        action: "build",
        state: "start",
      },
      {
        type: "runtime-finalize",
        invocationId: "inv-1",
        package: { name: "idna", version: "3.11" },
        action: "build",
        state: "end",
      },
    ]);
  });
});

describe("the small pieces", () => {
  it("strips escape sequences without touching the text", () => {
    expect(stripAnsi("\u001B[1mbold\u001B[0m text")).toBe("bold text");
  });

  it("reads uv's duration units", () => {
    expect(millisecondsOf("126", "ms")).toBe(126);
    expect(millisecondsOf("1.5", "s")).toBe(1500);
    expect(millisecondsOf("2", "m")).toBe(120_000);
  });
});
