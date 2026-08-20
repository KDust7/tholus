import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { jsPath, PROGRAM, root, wasmPath } from "./cli-goldens.js";
import { type ReplayServer, startReplayServer } from "./replay-server.js";

const fixture = resolve(root, "test/fixtures/install");
const hasEngine = existsSync(wasmPath) && existsSync(jsPath);
const hasFixture = existsSync(resolve(fixture, "snapshot.json"));
const canRun = hasEngine && hasFixture;

if (process.env.CI && !canRun) {
  throw new Error(
    "the terminal gate cannot run: the engine artifact or the install fixture is missing. " +
      "Skipping here would report a gate that never ran.",
  );
}

interface EngineInstance {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  setTermSize(columns: number, rows: number): void;
  clearTerm(): void;
  fsMkdirp(path: string): void;
  clearStdin(): void;
}

interface EngineModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  Engine: new () => EngineInstance;
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");
const HAS_ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`);
const FRAME_BREAK = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]|\\r|\\n`);

function plain(text: string): string {
  return text.replace(ANSI, "");
}

function lines(text: string): string[] {
  return plain(text).split("\n");
}

function paintedWidths(stderr: string): number[] {
  return stderr
    .split(FRAME_BREAK)
    .map((frame) => frame.length)
    .filter((length) => length > 0);
}

describe.skipIf(!canRun)("the engine renders to the terminal the host declares", () => {
  let engine: EngineInstance;

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as EngineModule;
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    engine = new mod.Engine();
  }, 300_000);

  async function capture(args: string[]): Promise<{ code: number; out: string; err: string }> {
    engine.clearStdin();
    let out = "";
    let err = "";
    const decoder = new TextDecoder();
    const code = await engine.invoke([PROGRAM, ...args], (stream, data) => {
      if (stream === "stdout") {
        out += decoder.decode(data);
      } else {
        err += decoder.decode(data);
      }
    });
    return { code, out, err };
  }

  async function help(): Promise<string> {
    return (await capture(["pip", "install", "--help"])).out;
  }

  async function install(directory: string): Promise<string> {
    let server: ReplayServer | undefined;
    try {
      server = await startReplayServer(fixture);
      engine.fsMkdirp(directory);
      const created = await capture(["venv", `${directory}/.venv`, "--python", "/bin/python3"]);
      expect(created.code, `the venv failed: ${created.err}`).toBe(0);
      const run = await capture([
        "pip",
        "install",
        "idna==3.11",
        "--index-url",
        `${server.origin}/simple`,
        "--no-cache",
        "--python",
        `${directory}/.venv`,
      ]);
      expect(run.code, `the install failed: ${run.err}`).toBe(0);
      return run.err;
    } finally {
      await server?.close();
    }
  }

  it("wraps help to fewer lines the wider the terminal is", async () => {
    engine.setTermSize(80, 24);
    const narrow = lines(await help());
    engine.setTermSize(120, 24);
    const wide = lines(await help());

    expect(narrow.length, "the two widths produced the same help").not.toBe(wide.length);
    expect(wide.length, "the wider terminal did not wrap to fewer lines").toBeLessThan(
      narrow.length,
    );
  }, 180_000);

  it.each([80, 120])(
    "keeps every breakable help line inside %i columns",
    async (columns) => {
      engine.setTermSize(columns, 24);
      const over = lines(await help()).filter((line) => line.length > columns);
      expect(
        over.length,
        `${over.length} lines ran past ${columns} columns: ${over.slice(0, 2).join(" | ")}`,
      ).toBeLessThanOrEqual(1);
    },
    180_000,
  );

  it("falls back to clap's own 100 columns when no terminal is declared", async () => {
    engine.setTermSize(100, 24);
    const hundred = await help();
    engine.clearTerm();
    const none = await help();
    expect(
      lines(none).length,
      "no terminal did not fall back to clap's 100 columns, so the recorded goldens would drift",
    ).toBe(lines(hundred).length);
  }, 180_000);

  it("draws no progress at all when no terminal is declared", async () => {
    engine.clearTerm();
    const stderr = await install("/tty-none");
    expect(plain(stderr)).not.toContain("Preparing packages");
    expect(stderr, "something painted a frame with no terminal to paint it on").not.toMatch(
      HAS_ANSI,
    );
  }, 300_000);

  it.each([80, 120])(
    "paints every frame to exactly %i columns",
    async (columns) => {
      engine.setTermSize(columns, 24);
      const stderr = await install(`/tty-${columns}`);
      expect(plain(stderr)).toContain("Preparing packages");
      expect(stderr, "no ANSI reached the sink, so nothing was rendered").toMatch(HAS_ANSI);

      const widths = paintedWidths(stderr);
      expect(widths, "no frame was painted at the declared width").toContain(columns);

      const ragged = widths.filter((width) => width > columns && width % columns !== 0);
      expect(
        ragged,
        "a frame ran past the terminal without being a whole stack of its lines",
      ).toEqual([]);
    },
    300_000,
  );

  it("follows a resize that lands mid-invocation", async () => {
    engine.setTermSize(80, 24);
    engine.fsMkdirp("/tty-resize");
    const created = await capture(["venv", "/tty-resize/.venv", "--python", "/bin/python3"]);
    expect(created.code).toBe(0);

    let server: ReplayServer | undefined;
    try {
      server = await startReplayServer(fixture);
      let stderr = "";
      const decoder = new TextDecoder();
      let resized = false;

      const code = await engine.invoke(
        [
          PROGRAM,
          "pip",
          "install",
          "idna==3.11",
          "--index-url",
          `${server.origin}/simple`,
          "--no-cache",
          "--python",
          "/tty-resize/.venv",
        ],
        (stream, data) => {
          if (stream === "stdout") {
            return;
          }
          stderr += decoder.decode(data);
          if (!resized && stderr.includes("Preparing packages")) {
            resized = true;
            engine.setTermSize(120, 24);
          }
        },
      );

      expect(code, `the install failed: ${stderr}`).toBe(0);
      expect(resized, "the install never reached the stage the resize was timed to").toBe(true);

      const widths = paintedWidths(stderr);
      expect(widths, "no frame was painted at the width the invocation started with").toContain(80);
      expect(widths, "no frame was painted at the width the resize asked for").toContain(120);
    } finally {
      await server?.close();
    }
  }, 300_000);
});
