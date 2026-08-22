import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchChromium, type StaticSite, serveStatic, testbedFiles } from "./browser-harness.js";
import { createReplayHandler, emptyReplayLog, readSnapshot } from "./replay-server.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = resolve(root, "test/fixtures/install");
const files = testbedFiles(root);
const canRun = [...files.values()].every((path) => existsSync(path));

if (process.env.CI && !canRun) {
  throw new Error(
    "the testbed gate cannot run: the engine artifact, the worker bundle or the built testbed " +
      "is missing. Skipping here would report the browser E2E flow as green without a browser.",
  );
}

const VENV = "/work/.venv";

interface InstallSnapshot {
  args: string[];
}

interface Outcome {
  code: number;
  cancelled: boolean;
  stdout: string;
  stderr: string;
}

interface Driver {
  init(config?: unknown): Promise<{ ok: boolean; build?: { uv: string }; message?: string }>;
  exec(argv: string[], options?: unknown): Promise<Outcome>;
  call(method: string, request?: unknown): Promise<unknown>;
  tree(path: string): Promise<string[] | { failed: true; message: string }>;
  events(): { type: string }[];
  dispose(): Promise<void>;
}

describe.skipIf(!canRun)("the testbed drives uv end to end in a real browser", () => {
  let site: StaticSite;
  let browser: Browser;
  let page: Page;
  let installed: Outcome;
  let created: unknown;
  const log = emptyReplayLog();

  beforeAll(async () => {
    const snapshot = await readSnapshot(fixture);
    const { args } = snapshot as unknown as InstallSnapshot;
    const replay = createReplayHandler(snapshot, log);
    site = await serveStatic(files, (request, response) => {
      const url = request.url ?? "/";
      if (!url.startsWith("/simple/") && !url.startsWith("/files/")) {
        return false;
      }
      replay(request, response);
      return true;
    });
    log.origin = site.origin;

    browser = await launchChromium();
    page = await browser.newPage();
    await page.goto(`${site.origin}/index.html`);
    await page.waitForFunction(() => "__uv" in globalThis);

    const started = await page.evaluate(
      () => (globalThis as unknown as { __uv: Driver }).__uv.init({ cache: { kind: "memory" } }),
      undefined,
    );
    expect(started.ok, started.message).toBe(true);

    created = await page.evaluate(
      ([venv]) =>
        (globalThis as unknown as { __uv: Driver }).__uv.call("venv.create", {
          path: venv,
          pythonVersion: "/bin/python3",
        }),
      [VENV] as const,
    );

    const argv: string[] = [...args, "--index-url", `${site.origin}/simple`, "--python", VENV];
    installed = await page.evaluate(
      (command) => (globalThis as unknown as { __uv: Driver }).__uv.exec(command),
      argv,
    );
  }, 600_000);

  afterAll(async () => {
    await page?.evaluate(() => (globalThis as unknown as { __uv: Driver }).__uv.dispose());
    await browser?.close();
    await site?.close();
  }, 180_000);

  it("boots the engine and reports the uv it was built from", async () => {
    const version = await page.evaluate(() =>
      (globalThis as unknown as { __uv: Driver }).__uv.exec(["--version"]),
    );
    expect(version.code).toBe(0);
    expect(version.stdout).toContain("uv 0.12.3");
  }, 120_000);

  it("created the virtual environment through the SDK rather than raw argv", () => {
    expect(created, JSON.stringify(created)).toMatchObject({ path: VENV });
  });

  it("installed the package off the replayed index", () => {
    expect(installed.code, `the install failed: ${installed.stderr}`).toBe(0);
    expect(installed.stderr).toContain("+ idna==3.11");
  });

  it("served every request from the fixture, so nothing reached the network", () => {
    expect(log.misses, `the replay server was asked for ${log.misses.join(", ")}`).toEqual([]);
    expect(
      log.requested.length,
      "zero requests would mean the install never happened at all",
    ).toBeGreaterThan(0);
  });

  it("lists the package back through the SDK rather than raw argv", async () => {
    const listed = await page.evaluate(
      ([venv]) => (globalThis as unknown as { __uv: Driver }).__uv.call("pip.list", { venv }),
      [VENV] as const,
    );
    expect(listed).toEqual([{ name: "idna", version: "3.11" }]);
  }, 180_000);

  it("exports the environment it built, so a host can read what landed", async () => {
    const tree = await page.evaluate(
      ([venv]) => (globalThis as unknown as { __uv: Driver }).__uv.tree(venv),
      [VENV] as const,
    );
    expect(Array.isArray(tree), JSON.stringify(tree)).toBe(true);
    const paths = tree as string[];
    expect(paths).toContain("pyvenv.cfg");
    expect(
      paths.some((path) => path.includes("idna/__init__.py")),
      "the installed package has to be visible in the exported tree",
    ).toBe(true);
  }, 180_000);

  it.skip("BLOCKED: reports the install as a structured event, the real worker emits only `log`, so six of the protocol's seven event kinds exist in the mock alone and `pip.install` resolves an empty report against a real engine", async () => {
    const events = await page.evaluate(() =>
      (globalThis as unknown as { __uv: Driver }).__uv.events(),
    );
    expect(events.map((event) => event.type)).toContain("install-report");
  });
});
