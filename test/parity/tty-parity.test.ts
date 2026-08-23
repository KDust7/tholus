import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { jsPath, normalize, PROGRAM, root, wasmPath } from "./cli-goldens.js";

const nativePath = resolve(
  root,
  "vendor/uv/target/debug",
  process.platform === "win32" ? "uv.exe" : "uv",
);
const hasEngine = existsSync(wasmPath) && existsSync(jsPath);
const hasNative = existsSync(nativePath);
const canCompare = hasEngine && hasNative;

if (process.env.CI && !hasEngine) {
  throw new Error(
    "the tty parity gate cannot run: the engine artifact is missing. Skipping here would report " +
      "render parity without rendering anything.",
  );
}

const WIDTHS = [80, 100, 120] as const;
const COMMANDS: readonly (readonly string[])[] = [
  ["--help"],
  ["pip", "--help"],
  ["pip", "install", "--help"],
];

interface EngineInstance {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  setTermSize(columns: number, rows: number): void;
  clearStdin(): void;
}

const decoder = new TextDecoder();
const ESCAPE = String.fromCharCode(27);
const ANSI = new RegExp(`${ESCAPE}[[0-9;?]*[A-Za-z]`, "g");
const HAS_ANSI = new RegExp(`${ESCAPE}[[0-9;?]*[A-Za-z]`);

const layout = (text: string): string => normalize(text.replace(ANSI, ""));

describe.skipIf(!canCompare)("uv wraps to the same width in a browser as on a terminal", () => {
  let engine: EngineInstance;

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as {
      default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
      Engine: new () => EngineInstance;
    };
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    engine = new mod.Engine();
    engine.clearStdin();
  }, 180_000);

  const browser = async (argv: readonly string[], columns: number): Promise<string> => {
    engine.setTermSize(columns, 24);
    let stdout = "";
    await engine.invoke([PROGRAM, ...argv], (stream, data) => {
      if (stream === "stdout") {
        stdout += decoder.decode(data);
      }
    });
    return stdout;
  };

  const native = (argv: readonly string[], columns: number): Promise<string> =>
    new Promise((done) => {
      execFile(
        nativePath,
        [...argv],
        { encoding: "utf8", env: { ...process.env, COLUMNS: String(columns) } },
        (_error, stdout) => done(stdout),
      );
    });

  const cases = WIDTHS.flatMap((columns) =>
    COMMANDS.map((argv) => [`${argv.join(" ")} at ${columns} columns`, argv, columns] as const),
  );

  it.each(cases)(
    "renders %s exactly as native uv does",
    async (_label, argv, columns) => {
      const here = await browser(argv, columns);
      const there = await native(argv, columns);

      expect(
        layout(here),
        "uv honors COLUMNS on a pipe, so a browser at the same width has to wrap identically. " +
          "Styling is compared separately: clap decides help coloring by terminal detection, so " +
          "a piped native uv is never colored and neither --color nor FORCE_COLOR changes that",
      ).toBe(layout(there));
    },
    180_000,
  );

  it("still colors its help, which is the whole point of declaring a terminal", async () => {
    const here = await browser(["--help"], 80);
    expect(
      HAS_ANSI.test(here),
      "a declared terminal has to get styled output, or the TTY seam is doing nothing",
    ).toBe(true);
  }, 180_000);

  it("actually rewraps between widths, so the comparison is not width-blind", async () => {
    const narrow = await browser(["--help"], 80);
    const wide = await browser(["--help"], 120);
    expect(
      narrow,
      "if the two widths produced the same bytes, every assertion above would be vacuous",
    ).not.toBe(wide);
  }, 180_000);
});
