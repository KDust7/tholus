import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { normalizeReport } from "./normalize-report.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const assets = resolve(root, "packages/core/assets");
const jsPath = resolve(assets, "engine.js");
const wasmPath = resolve(assets, "engine_bg.wasm");
const nativePath = resolve(
  root,
  "vendor/uv/target/debug",
  process.platform === "win32" ? "uv.exe" : "uv",
);
const isBuilt = existsSync(wasmPath) && existsSync(jsPath);
const hasNative = existsSync(nativePath);

if (process.env.CI && !isBuilt) {
  throw new Error(
    "the registry-error gate cannot run: the engine artifact is missing. Skipping here would " +
      "report error parity without ever provoking an error.",
  );
}

interface EngineInstance {
  invoke(argv: string[], onOutput: (stream: string, data: Uint8Array) => void): Promise<number>;
  clearStdin(): void;
}

interface Outcome {
  code: number;
  stderr: string;
}

function startFailing(status: number, body: string): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "text/html" }).end(body);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

const originOf = (server: Server): string =>
  `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function tidy(text: string): string {
  return normalizeReport(text)
    .replace(/http:\/\/127\.0\.0\.1:\d+/g, "<INDEX>")
    .replace(/\r/g, "")
    .trimEnd();
}

describe.skipIf(!isBuilt)("an index that fails is reported the way uv reports it", () => {
  let engine: EngineInstance;
  let notFound: Server;
  let broken: Server;

  const wasm = async (argv: string[]): Promise<Outcome> => {
    let stderr = "";
    const decoder = new TextDecoder();
    const code = await engine.invoke(["uv", ...argv], (stream, data) => {
      if (stream === "stderr") {
        stderr += decoder.decode(data);
      }
    });
    return { code, stderr };
  };

  const native = (argv: string[]): Promise<Outcome> =>
    new Promise((done) => {
      execFile(nativePath, argv, { encoding: "utf8" }, (error, _stdout, stderr) => {
        const status = (error as { code?: number } | null)?.code;
        done({ code: typeof status === "number" ? status : 0, stderr });
      });
    });

  beforeAll(async () => {
    notFound = await startFailing(404, "not found");
    broken = await startFailing(500, "the index fell over");

    const mod = (await import(pathToFileURL(jsPath).href)) as unknown as {
      default: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
      Engine: new () => EngineInstance;
    };
    await mod.default({ module_or_path: new Uint8Array(await readFile(wasmPath)) });
    engine = new mod.Engine();
    engine.clearStdin();
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((done) => notFound?.close(() => done()));
    await new Promise<void>((done) => broken?.close(() => done()));
  }, 60_000);

  it("says a package is missing, rather than failing obscurely", async () => {
    const result = await wasm([
      "pip",
      "install",
      "nonesuch-package",
      "--index-url",
      `${originOf(notFound)}/simple`,
      "--target",
      "/work/out",
      "--no-cache",
    ]);

    expect(result.code, "a missing package is a failure, not a silent success").not.toBe(0);
    expect(result.stderr).toMatch(
      /was not found|No solution found|not found in the package registry/,
    );
    expect(result.stderr, "a panic is never an acceptable error message").not.toContain("panicked");
  }, 180_000);

  it("names the index it could not read when the server errors", async () => {
    const result = await wasm([
      "pip",
      "install",
      "idna",
      "--index-url",
      `${originOf(broken)}/simple`,
      "--target",
      "/work/out",
      "--no-cache",
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr, "the operator has to be able to see which index failed").toContain(
      "127.0.0.1",
    );
    expect(result.stderr).not.toContain("panicked");
  }, 180_000);

  it("reports an unreachable index without crashing the engine", async () => {
    const dead = await startFailing(404, "");
    const origin = originOf(dead);
    await new Promise<void>((done) => dead.close(() => done()));

    const result = await wasm([
      "pip",
      "install",
      "idna",
      "--index-url",
      `${origin}/simple`,
      "--target",
      "/work/out",
      "--no-cache",
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toContain("panicked");
    expect(
      result.stderr.trim().length,
      "an unreachable index has to produce a message, not silence",
    ).toBeGreaterThan(0);

    const after = await wasm(["--version"]);
    expect(after.code, "a failed download must not take the engine with it").toBe(0);
  }, 180_000);

  it.skipIf(!hasNative)(
    "matches native uv's words for a missing package",
    async () => {
      const argv = (origin: string): string[] => [
        "pip",
        "install",
        "nonesuch-package",
        "--index-url",
        `${origin}/simple`,
        "--target",
        "/work/out",
        "--no-cache",
      ];

      const browser = await wasm(argv(originOf(notFound)));
      const cli = await native(argv(originOf(notFound)));

      expect(
        tidy(browser.stderr),
        "the failure a user sees in a browser has to be the failure uv actually reports",
      ).toBe(tidy(cli.stderr));
      expect(browser.code).toBe(cli.code);
    },
    240_000,
  );
});
