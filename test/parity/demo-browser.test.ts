import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchBrowser, type StaticSite, serveStatic } from "./browser-harness.js";
import { createReplayHandler, emptyReplayLog, readSnapshot } from "./replay-server.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = resolve(root, "test/fixtures/install");
const conflictFixture = resolve(root, "test/fixtures/conflicts");

const files = new Map<string, string>([
  ["/", resolve(root, "apps/demo/index.html")],
  ["/index.html", resolve(root, "apps/demo/index.html")],
  ["/demo/main.js", resolve(root, "apps/demo/dist/main.js")],
  ["/demo/worker.js", resolve(root, "packages/core/dist/worker.js")],
  ["/assets/engine.js", resolve(root, "packages/core/assets/engine.js")],
  ["/assets/engine_bg.wasm", resolve(root, "packages/core/assets/engine_bg.wasm")],
]);

const canRun = [...files.values()].every((path) => existsSync(path));

const pyodideDir = ((): string | undefined => {
  try {
    return dirname(
      createRequire(resolve(root, "test/parity/package.json")).resolve("pyodide/pyodide.mjs"),
    );
  } catch {
    return undefined;
  }
})();

if (process.env.CI && !canRun) {
  throw new Error(
    "the demo gate cannot run: the built demo, the worker bundle or the engine artifact is " +
      "missing. Skipping here would ship a demo nobody has opened.",
  );
}

const VENV = "/work/.venv";

interface DemoHandle {
  run(line: string): Promise<number>;
  mountPython(): void;
  useRelay(relayUrl: string): Promise<void>;
}

const screenOf = (page: Page): Promise<string> => page.locator(".xterm-screen").innerText();

const run = (page: Page, line: string): Promise<number> =>
  page.evaluate(
    (command) => (globalThis as unknown as { __demo: DemoHandle }).__demo.run(command),
    line,
  );

describe.skipIf(!canRun)("the demo runs uv in a terminal, in a real browser", () => {
  let site: StaticSite;
  let browser: Browser;
  let page: Page;
  let created: number;
  let installed: number;
  let listed: number;
  let transcript = "";
  const log = emptyReplayLog();
  const pageErrors: string[] = [];

  beforeAll(async () => {
    const installable = await readSnapshot(fixture);
    const conflicting = await readSnapshot(conflictFixture);
    const replay = createReplayHandler(
      { ...installable, responses: { ...conflicting.responses, ...installable.responses } },
      log,
    );
    site = await serveStatic(
      files,
      (request, response) => {
        const url = request.url ?? "/";
        if (!url.startsWith("/simple/") && !url.startsWith("/files/")) {
          return false;
        }
        replay(request, response);
        return true;
      },
      [
        { prefix: "/libcurl/", directory: resolve(root, "apps/demo/dist/libcurl") },
        ...(pyodideDir === undefined ? [] : [{ prefix: "/pyodide/", directory: pyodideDir }]),
      ],
    );
    log.origin = site.origin;

    browser = await launchBrowser();
    page = await browser.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${site.origin}/index.html`);
    await page.waitForFunction(() => "__demo" in globalThis, undefined, { timeout: 240_000 });

    created = await run(page, `uv venv ${VENV} --python /bin/python3`);
    installed = await run(
      page,
      `uv pip install idna==3.11 --index-url ${site.origin}/simple --python ${VENV} ` +
        "--exclude-newer 2026-08-01T00:00:00Z",
    );
    listed = await run(page, `uv pip list --python ${VENV}`);
    transcript = await screenOf(page);
  }, 600_000);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
  }, 180_000);

  it("boots uv and shows which build it is running", async () => {
    expect(await page.locator("#build").innerText()).toMatch(/^uv 0\.12\.3 · engine /);
  });

  it("says on the page itself that it is unofficial", async () => {
    const disclaimer = await page.locator("#disclaimer").innerText();
    expect(disclaimer).toMatch(/unofficial port/i);
    expect(disclaimer).toMatch(/[Nn]ot affiliated with or endorsed by Astral/);
  });

  it("greets with a terminal that has already rendered text", async () => {
    expect(await screenOf(page)).toContain("uv is compiled to WebAssembly");
  });

  it("created the environment it was asked for", () => {
    expect(
      created,
      `uv venv exited ${created}; the terminal showed:
${transcript}`,
    ).toBe(0);
  });

  it("installed into the environment it created, off the replayed index", () => {
    expect(
      installed,
      `uv pip install exited ${installed}; the terminal showed:
${transcript}`,
    ).toBe(0);
    expect(transcript).toContain("+ idna==3.11");
  });

  it("listed the package back", () => {
    expect(
      listed,
      `uv pip list exited ${listed}; the terminal showed:
${transcript}`,
    ).toBe(0);
    expect(
      transcript.replace(/\s+/g, ""),
      "the version has to survive the render, wherever the row happens to wrap",
    ).toContain("idna3.11");
  });

  it("renders uv's bare newlines as real line breaks, not as a staircase", () => {
    expect(
      transcript,
      "uv writes LF where a terminal wants CRLF, so a terminal that does not convert them " +
        "indents every line by the length of the one before it",
    ).toMatch(/^ \+ idna==3\.11$/m);
  });

  it("served every package request from the fixture, so the demo is hermetic", () => {
    expect(log.misses, `the replay server was asked for ${log.misses.join(", ")}`).toEqual([]);
    expect(
      log.requested.length,
      "zero requests would mean the install never reached the index",
    ).toBeGreaterThan(0);
  });

  it("reports an unknown flag the way uv does, rather than throwing", async () => {
    expect(await run(page, "uv --nonesuch")).toBe(2);
    await page.waitForFunction(
      () => document.querySelector(".xterm-screen")?.textContent?.includes("--nonesuch") === true,
      undefined,
      { timeout: 60_000 },
    );
    expect(await screenOf(page)).toContain("--nonesuch");
  }, 120_000);

  it("accepts a command actually typed at the keyboard", async () => {
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("uv --version");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelector(".xterm-screen")?.textContent?.includes("uv 0.12.3") === true,
      undefined,
      { timeout: 120_000 },
    );
    expect(await screenOf(page)).toContain("uv 0.12.3");
  }, 180_000);

  it.skipIf(pyodideDir === undefined)(
    "hands the environment it built to Python, which is what the demo is for",
    async () => {
      await page.evaluate(() =>
        (globalThis as unknown as { __demo: DemoHandle }).__demo.mountPython(),
      );
      await page.waitForFunction(
        () => document.querySelector("#status")?.textContent?.includes("mounted") === true,
        undefined,
        { timeout: 600_000 },
      );

      const PROBE = `python -c "import idna; print('mounted-idna=' + idna.__version__)"`;
      expect(await run(page, PROBE)).toBe(0);
      await page.waitForFunction(
        () =>
          document.querySelector(".xterm-screen")?.textContent?.includes("mounted-idna=3.11") ===
          true,
        undefined,
        { timeout: 120_000 },
      );
      expect(
        await screenOf(page),
        "the marker has to be distinctive: the install line already printed `+ idna==3.11`, so " +
          "asserting on the bare version would pass without Python running at all",
      ).toContain("mounted-idna=3.11");
    },
    900_000,
  );

  it("reads an unsatisfiable resolution out in uv's own words", async () => {
    const code = await run(
      page,
      `uv pip install uv-wasm-left==1.0.0 uv-wasm-right==1.0.0 --python ${VENV} --no-cache ` +
        `--index-url ${site.origin}/simple --python-version 3.14`,
    );
    const screen = await screenOf(page);

    expect(code, `the conflict resolved, which it must not:\n${screen}`).not.toBe(0);
    expect(screen).toContain("No solution found when resolving dependencies");
    expect(
      screen,
      "the derivation tree is the readable half; without it this is just a failure",
    ).toContain("uv-wasm-shared");
    expect(log.misses, `the index was asked for ${log.misses.join(", ")}`).toEqual([]);
  }, 600_000);

  it("refuses a relay URL that is not a websocket, and keeps working", async () => {
    await page.evaluate(
      (url) => (globalThis as unknown as { __demo: DemoHandle }).__demo.useRelay(url),
      "https://not-a-relay.invalid/",
    );

    const said = await page.locator("#status").innerText();
    expect(said).toMatch(/ws:|wss:/);
    expect(
      await page.locator("#relay").isDisabled(),
      "the input stayed disabled, so the mistake cannot be corrected",
    ).toBe(false);
    expect(await run(page, "uv --version"), "the demo stopped working after a bad relay").toBe(0);
  }, 600_000);

  it("ships the libcurl module the relay path names", async () => {
    const response = await page.request.get(`${site.origin}/libcurl/libcurl.mjs`);
    expect(
      response.status(),
      "the demo offers a relay it cannot actually load; the build must copy libcurl beside the page",
    ).toBe(200);
    expect((await page.request.get(`${site.origin}/libcurl/libcurl.wasm`)).status()).toBe(200);
  }, 120_000);

  it("refuses a relay URL with no trailing slash, which libcurl needs", async () => {
    await page.evaluate(
      (url) => (globalThis as unknown as { __demo: DemoHandle }).__demo.useRelay(url),
      "wss://relay.invalid",
    );

    expect(await page.locator("#status").innerText()).toMatch(/trailing slash/);
  }, 600_000);

  it("raised no uncaught page errors along the way", () => {
    expect(pageErrors).toEqual([]);
  });
});
