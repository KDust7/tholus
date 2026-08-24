import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyHookWrites,
  type HookVfs,
  hookTrees,
  type RuntimeHookRequest,
  sitePackagesOf,
} from "@tholus/core";
import { attachPyodide, type PyodideLike } from "@tholus/pyodide";
import { beforeAll, describe, expect, it } from "vitest";

import { jsPath, PROGRAM, root, wasmPath } from "./cli-goldens.js";
import { normalizeReport } from "./normalize-report.js";
import { type ReplayServer, startReplayServer } from "./replay-server.js";

interface Scenario {
  name: string;
  distribution: string;
  distInfo: string;
  backend: string;
  backendModule: string;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "sdist",
    distribution: "idna",
    distInfo: "idna-3.11.dist-info",
    backend: "flit_core.buildapi",
    backendModule: "flit_core",
  },
  {
    name: "sdist-setuptools",
    distribution: "zipp",
    distInfo: "zipp-3.23.0.dist-info",
    backend: "setuptools.build_meta",
    backendModule: "setuptools",
  },
  {
    name: "sdist-hatchling",
    distribution: "attrs",
    distInfo: "attrs-25.4.0.dist-info",
    backend: "hatchling.build",
    backendModule: "hatchling",
  },
];

const require = createRequire(import.meta.url);
const hasPyodide = ((): boolean => {
  try {
    require.resolve("pyodide");
    return true;
  } catch {
    return false;
  }
})();

const fixtureOf = (name: string): string => resolve(root, "test/fixtures", name);
const hasEngine = existsSync(wasmPath) && existsSync(jsPath);
const available = SCENARIOS.filter((scenario) =>
  existsSync(resolve(fixtureOf(scenario.name), "snapshot.json")),
);
const canRun = hasEngine && available.length === SCENARIOS.length;

if (process.env.CI && (!canRun || !hasPyodide)) {
  throw new Error(
    "the sdist parity gate cannot run: the engine artifact, an sdist fixture or the `pyodide` " +
      "package is missing. Skipping here would report phase 5's parity criterion as green while " +
      "never building a source distribution.",
  );
}

const normalize = normalizeReport;

interface SeenHook extends RuntimeHookRequest {
  sitePackages: string[];
  backends: string[];
}

interface Snapshot {
  args: string[];
  expectedReport?: string;
}

interface EngineInstance extends HookVfs {
  fsWrite(path: string, contents: Uint8Array): void;
  fsMkdirp(path: string): void;
  clearStdin(): void;
  attachRuntime(
    run: (request: RuntimeHookRequest) => Promise<{
      stdout: string[];
      stderr: string[];
      code: number;
    }>,
  ): void;
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
}

interface EngineModule {
  default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  Engine: new () => EngineInstance;
}

let modulePromise: Promise<EngineModule> | undefined;

async function engineModule(): Promise<EngineModule> {
  modulePromise ??= (async () => {
    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as EngineModule;
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    return mod;
  })();
  return modulePromise;
}

for (const scenario of SCENARIOS) {
  describe.skipIf(!canRun || !hasPyodide)(
    `uv builds \`${scenario.distribution}\` from its sdist with ${scenario.backendModule}`,
    () => {
      const decoder = new TextDecoder();
      const home = `/${scenario.name}`;
      const target = `${home}/target`;
      let engine: EngineInstance;
      let snapshot: Snapshot;
      let code: number;
      let stderr: string;
      let hooks: SeenHook[];

      const text = (path: string): string => decoder.decode(engine.fsRead(path));

      beforeAll(async () => {
        snapshot = JSON.parse(
          await readFile(resolve(fixtureOf(scenario.name), "snapshot.json"), "utf8"),
        ) as Snapshot;
        const server: ReplayServer = await startReplayServer(fixtureOf(scenario.name));

        const mod = await engineModule();
        engine = new mod.Engine();
        engine.clearStdin();
        engine.fsMkdirp(home);

        const { loadPyodide } = (await import("pyodide")) as {
          loadPyodide: () => Promise<PyodideLike>;
        };
        const pyodide = await loadPyodide();
        const runtime = attachPyodide(
          { exportTree: () => Promise.reject(new Error("unused")) },
          pyodide,
        );

        hooks = [];
        engine.attachRuntime(async (request) => {
          const sitePackages = sitePackagesOf(engine, request.venv);
          hooks.push({
            ...request,
            sitePackages,
            backends: sitePackages.filter(
              (path) => engine.fsKind(`${path}/${scenario.backendModule}`) === "directory",
            ),
          });
          const outcome = await runtime.hook({
            script: request.script,
            cwd: request.sourceTree,
            env: request.env,
            sitePackages,
            trees: hookTrees(engine, request),
          });
          applyHookWrites(engine, outcome.writes);
          return { stdout: outcome.stdout, stderr: outcome.stderr, code: outcome.code };
        });

        stderr = "";
        code = await engine.invoke(
          [PROGRAM, ...snapshot.args, "--index-url", `${server.origin}/simple`, "--target", target],
          (stream, data) => {
            if (stream !== "stdout") {
              stderr += decoder.decode(data);
            }
          },
        );
        await server.close();
      }, 900_000);

      it("built the source distribution and installed what it produced", () => {
        expect(code, `the build failed:\n${stderr}`).toBe(0);
      });

      it("reports what native uv reported, once timings are normalized", () => {
        expect(snapshot.expectedReport, "the fixture must carry native's own report").toBeDefined();
        expect(normalize(stderr)).toBe(normalize(snapshot.expectedReport as string));
      });

      it("really built rather than quietly falling back to the wheel", () => {
        expect(stderr).toContain(`Building ${scenario.distribution}==`);
        expect(stderr).toContain(`Built ${scenario.distribution}==`);
        expect(
          hooks.length,
          "a build runs at least a requires hook and a build hook",
        ).toBeGreaterThanOrEqual(2);
      });

      it("ran the backend uv installed into the build venv, not one the test supplied", () => {
        const build = hooks.find((hook) => hook.outputDir !== undefined) as SeenHook;
        expect(build.script).toContain(scenario.backend);
        expect(
          build.sitePackages,
          "uv makes the build venv and deletes it, so this can only be read at hook time",
        ).not.toEqual([]);
        expect(
          build.backends,
          "the backend uv resolved off the index has to be importable when the hook runs",
        ).not.toEqual([]);
      });

      it("installed a package whose RECORD describes the bytes on disk", () => {
        const record = text(`${target}/${scenario.distInfo}/RECORD`);
        const first = record.split(/\r?\n/).find((line) => line.trim().length > 0) as string;
        const path = first.split(",")[0] as string;
        expect(engine.fsKind(`${target}/${path}`)).toBe("file");
      });
    },
  );
}
