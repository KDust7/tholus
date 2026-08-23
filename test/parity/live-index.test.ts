import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { jsPath, PROGRAM, root, wasmPath } from "./cli-goldens.js";
import { normalizeReport } from "./normalize-report.js";

const PYPI = "https://pypi.org/simple";
const PYODIDE = "https://index.pyodide.org/314.0.5";

const SCENARIOS: readonly { name: string; index: string }[] = [
  { name: "pure-python", index: PYPI },
  { name: "markers", index: PYPI },
  { name: "transitive", index: PYPI },
  { name: "extras", index: PYPI },
  { name: "hashes", index: PYPI },
  { name: "universal", index: PYPI },
  { name: "pyodide-wheel", index: PYODIDE },
];

const fixtures = resolve(root, "test/fixtures");
const asked = process.env["UV_WASM_LIVE"] === "1";
const hasEngine = existsSync(wasmPath) && existsSync(jsPath);

if (asked && !hasEngine) {
  throw new Error(
    "the live-index check was asked for but the engine artifact is missing; " +
      "skipping would report drift as absent while measuring nothing",
  );
}

interface Snapshot {
  requirements: string[];
  args: string[];
  expected?: string;
}

interface EngineInstance {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  fsMkdirp(path: string): void;
  fsWrite(path: string, contents: Uint8Array): void;
  setStdin(bytes: Uint8Array): void;
  clearStdin(): void;
}

interface EngineModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  Engine: new () => EngineInstance;
}

const read = (name: string): Snapshot =>
  JSON.parse(readFileSync(resolve(fixtures, name, "snapshot.json"), "utf8")) as Snapshot;

describe.skipIf(!asked)("the recorded goldens still describe the live indexes", () => {
  let engine: EngineInstance;

  beforeAll(async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as EngineModule;
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    engine = new mod.Engine();
  }, 300_000);

  it.each(SCENARIOS.map((scenario) => [scenario.name, scenario] as const))(
    "resolves `%s` off the live index exactly as recorded",
    async (name, scenario) => {
      const snapshot = read(name);
      const golden = snapshot.expected;
      expect(golden, `${name} carries no golden; re-record it`).toBeDefined();
      expect((golden as string).length).toBeGreaterThan(0);

      const requirements = `${snapshot.requirements.join("\n")}\n`;
      const directory = `/live-${name}`;
      engine.fsMkdirp(directory);
      engine.fsWrite(`${directory}/requirements.in`, new TextEncoder().encode(requirements));
      if (snapshot.args.includes("-")) {
        engine.setStdin(new TextEncoder().encode(requirements));
      } else {
        engine.clearStdin();
      }

      let stdout = "";
      let stderr = "";
      const decoder = new TextDecoder();
      const code = await engine.invoke(
        [PROGRAM, ...snapshot.args, "--index-url", scenario.index, "--directory", directory],
        (stream, data) => {
          if (stream === "stdout") {
            stdout += decoder.decode(data);
          } else {
            stderr += decoder.decode(data);
          }
        },
      );

      expect(code, `the live resolve failed: ${stderr}`).toBe(0);
      expect(normalizeReport(stderr)).toContain("Resolved");
      expect(
        stdout,
        `${name} resolves differently against the live index than the fixture records; ` +
          "the index moved under the golden, so re-record it",
      ).toBe(golden);
    },
    300_000,
  );
});
