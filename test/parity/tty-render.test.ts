import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Terminal } from "@xterm/headless";
import { beforeAll, describe, expect, it } from "vitest";

import { jsPath, PROGRAM, root, wasmPath } from "./cli-goldens.js";
import { type ReplayServer, startReplayServer } from "./replay-server.js";

const fixture = resolve(root, "test/fixtures/install");
const hasEngine = existsSync(wasmPath) && existsSync(jsPath);
const hasFixture = existsSync(resolve(fixture, "snapshot.json"));
const canRun = hasEngine && hasFixture;

if (process.env.CI && !canRun) {
  throw new Error(
    "the render gate cannot run: the engine artifact or the install fixture is missing. " +
      "Skipping here would report render parity without rendering anything.",
  );
}

const COLUMNS = 80;
const ROWS = 24;
const ESCAPE = String.fromCharCode(27);

interface EngineInstance {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  fsMkdirp(path: string): void;
  setTermSize(columns: number, rows: number): void;
  clearStdin(): void;
}

interface Rendered {
  screen: string[];
  everything: string[];
}

function render(
  stream: string,
  columns: number,
  rows: number,
  convertEol = true,
): Promise<Rendered> {
  const terminal = new Terminal({ cols: columns, rows, convertEol, allowProposedApi: true });
  return new Promise((done) => {
    terminal.write(stream, () => {
      const buffer = terminal.buffer.active;
      const everything: string[] = [];
      for (let index = 0; index < buffer.length; index += 1) {
        everything.push(buffer.getLine(index)?.translateToString(true) ?? "");
      }
      const screen = everything.slice(buffer.baseY);
      terminal.dispose();
      done({ screen, everything });
    });
  });
}

const nonEmpty = (lines: string[]): string[] =>
  lines.map((line) => line.trimEnd()).filter((line) => line !== "");

describe.skipIf(!canRun)("what a real terminal makes of the bytes uv paints", () => {
  let engine: EngineInstance;
  let stream = "";
  let code = -1;

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as {
      default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
      Engine: new () => EngineInstance;
    };
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    engine = new mod.Engine();
    engine.clearStdin();
    engine.setTermSize(COLUMNS, ROWS);
    engine.fsMkdirp("/render");

    const decoder = new TextDecoder();
    const run = async (argv: string[]): Promise<{ status: number; stderr: string }> => {
      let stderr = "";
      const status = await engine.invoke([PROGRAM, ...argv], (which, data) => {
        if (which !== "stdout") {
          stderr += decoder.decode(data);
        }
      });
      return { status, stderr };
    };

    const created = await run(["venv", "/render/.venv", "--python", "/bin/python3"]);
    expect(created.status, `the venv failed: ${created.stderr}`).toBe(0);

    let server: ReplayServer | undefined;
    try {
      server = await startReplayServer(fixture);
      const installed = await run([
        "pip",
        "install",
        "idna==3.11",
        "--index-url",
        `${server.origin}/simple`,
        "--no-cache",
        "--python",
        "/render/.venv",
      ]);
      code = installed.status;
      stream = installed.stderr;
    } finally {
      await server?.close();
    }
  }, 300_000);

  it("installed, so there is a real render to look at", () => {
    expect(code, `the install failed: ${stream}`).toBe(0);
    expect(
      stream.length,
      "nothing was written, so this gate would pass on silence",
    ).toBeGreaterThan(0);
  });

  it("painted progress rather than printing a static log", () => {
    const repaints = stream.split(ESCAPE).length - 1;
    expect(
      repaints,
      "no escape sequence reached the terminal, so no progress was drawn at all",
    ).toBeGreaterThan(0);
  });

  it("leaves a real terminal with no escape sequence it did not understand", async () => {
    const { everything } = await render(stream, COLUMNS, ROWS);
    const stray = everything.filter((line) => line.includes(ESCAPE));
    expect(stray, "an escape sequence survived into the rendered buffer").toEqual([]);
  });

  it("says only what uv says, with the progress frames erased behind it", async () => {
    const { everything } = await render(stream, COLUMNS, ROWS);
    const lines = nonEmpty(everything);

    expect(
      lines.filter((line) => /^Installed 1 package in /.test(line)),
      "uv's own summary is not on the screen",
    ).toHaveLength(1);
    expect(
      lines.filter((line) => line.includes("Preparing packages")),
      "a progress frame was left behind instead of being erased",
    ).toEqual([]);
    expect(
      lines.filter((line) => /[█░]/.test(line)),
      "a progress bar was left drawn on the final screen",
    ).toEqual([]);
    expect(
      lines.filter((line) => /^\s+\S/.test(line) && !line.trimStart().startsWith("+")),
      "a line starts indented, which is what a terminal that will not convert LF produces",
    ).toEqual([]);
  });

  it("staircases without the conversion, which is the trap the xterm package warns about", async () => {
    const { everything } = await render(stream, COLUMNS, ROWS, false);
    const indented = nonEmpty(everything).filter((line) => /^\s+\S/.test(line));
    expect(
      indented.length,
      "uv emits bare LF, so a terminal that does not convert it must staircase; " +
        "if this ever comes back empty the gate above has stopped proving anything",
    ).toBeGreaterThan(0);
  });

  it("wraps nothing past the width it was told about", async () => {
    const { everything } = await render(stream, COLUMNS, ROWS);
    for (const line of everything) {
      expect(line.length).toBeLessThanOrEqual(COLUMNS);
    }
  });

  it("renders the same summary at a different width", async () => {
    const { everything } = await render(stream, 120, ROWS);
    expect(
      nonEmpty(everything).filter((line) => /^Installed 1 package in /.test(line)),
    ).toHaveLength(1);
  });
});
