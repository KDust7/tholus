import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve } from "node:path";
import { PROTOCOL_VERSION } from "@tholus/engine-protocol";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chosenBrowser, launchBrowser } from "./browser-harness.js";
import { root } from "./cli-goldens.js";
import { createReplayHandler, emptyReplayLog, readSnapshot } from "./replay-server.js";

const assets = resolve(root, "packages/core/assets");
const dist = resolve(root, "packages/core/dist");
const fixture = resolve(root, "test/fixtures/install");
const canRun = [
  resolve(assets, "engine_bg.wasm"),
  resolve(assets, "engine.js"),
  resolve(dist, "worker.js"),
  resolve(fixture, "snapshot.json"),
].every((path) => existsSync(path));

if (process.env.CI && !canRun) {
  throw new Error(
    "the browser persistence gate cannot run: the engine artifact, the worker bundle or the " +
      "install fixture is missing. Skipping here would report a gate that never ran.",
  );
}

const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>tholus persistence</title>
<script type="module">
globalThis.__boot = (id) => {
  const worker = new Worker("/dist/worker.js", { type: "module" });
  const seen = [];
  worker.addEventListener("message", (event) => seen.push(event.data));
  worker.addEventListener("error", (event) => seen.push({ type: "fatal", message: event.message }));
  globalThis["__w" + id] = { worker, seen };
};
globalThis.__send = (id, message) => globalThis["__w" + id].worker.postMessage(message);
globalThis.__kill = (id) => globalThis["__w" + id].worker.terminate();
globalThis.__await = async (id, type, budgetMs) => {
  const bag = globalThis["__w" + id];
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const fatal = bag.seen.find((m) => m.type === "fatal");
    if (fatal) throw new Error("worker died: " + fatal.message);
    const hit = bag.seen.find((m) => m.type === type);
    if (hit) {
      const drained = bag.seen.splice(0, bag.seen.length);
      return drained.map((m) => (m.type === "output" ? { ...m, data: Array.from(m.data) } : m));
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("timed out waiting for " + type + "; saw " + JSON.stringify(bag.seen.map((m) => m.type)));
};
globalThis.__wipeOpfs = async () => {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry("tholus", { recursive: true }).catch(() => {});
  return true;
};
</script>`;

interface Emitted {
  type: string;
  [key: string]: unknown;
}

interface Scope {
  __boot(id: string): void;
  __send(id: string, message: unknown): void;
  __kill(id: string): void;
  __await(id: string, type: string, budgetMs: number): Promise<Emitted[]>;
  __wipeOpfs(): Promise<boolean>;
}

describe.skipIf(!canRun || chosenBrowser() !== "chromium")(
  "uv's cache survives a reload through real opfs (chromium only: clearing the browser's own HTTP cache needs CDP, and without that this measures their cache rather than ours)",
  () => {
    let server: Server;
    let browser: Browser;
    let page: Page;
    const log = emptyReplayLog();
    let firstRound: string[] = [];
    let secondRound: string[] = [];

    beforeAll(async () => {
      const replay = createReplayHandler(await readSnapshot(fixture), log);
      const statics = new Map<string, string>([
        ["/dist/worker.js", resolve(dist, "worker.js")],
        ["/assets/engine.js", resolve(assets, "engine.js")],
        ["/assets/engine_bg.wasm", resolve(assets, "engine_bg.wasm")],
      ]);

      server = createServer((request, response) => {
        const url = request.url ?? "/";
        if (url.startsWith("/simple/") || url.startsWith("/files/")) {
          replay(request, response);
          return;
        }
        const file = statics.get(url.split("?")[0] ?? "");
        if (file !== undefined) {
          readFile(file)
            .then((body) => {
              response
                .writeHead(200, { "content-type": TYPES[extname(file)] ?? "text/plain" })
                .end(body);
            })
            .catch(() => response.writeHead(500).end());
          return;
        }
        response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      log.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      browser = await launchBrowser();
      page = await browser.newPage();
      await page.goto(`${log.origin}/index.html`);
      await page.evaluate(() => (globalThis as unknown as Scope).__wipeOpfs());

      const boot = async (id: string): Promise<void> => {
        await page.evaluate(
          ([worker, version]) => {
            const scope = globalThis as unknown as Scope;
            scope.__boot(worker);
            scope.__send(worker, {
              type: "init",
              id: "i1",
              protocolVersion: version,
              config: { cache: { kind: "opfs" }, cwd: "/" },
            });
          },
          [id, PROTOCOL_VERSION] as const,
        );
        const seen = (await page.evaluate(
          ([worker, budget]) =>
            (globalThis as unknown as Scope).__await(worker, "initResult", budget as number),
          [id, 240_000] as const,
        )) as Emitted[];
        const result = seen.find((message) => message.type === "initResult");
        expect(result?.outcome, `worker ${id} failed to boot`).toMatchObject({ ok: true });
      };

      let invocation = 0;
      const run = async (id: string, argv: string[]): Promise<Emitted[]> => {
        invocation += 1;
        await page.evaluate(
          ([worker, args, tag]) => {
            (globalThis as unknown as Scope).__send(worker as string, {
              type: "exec",
              invocationId: tag,
              argv: args,
            });
          },
          [id, argv, `inv-${invocation}`] as [string, string[], string],
        );
        const seen = (await page.evaluate(
          ([worker, budget]) =>
            (globalThis as unknown as Scope).__await(worker, "exit", budget as number),
          [id, 300_000] as const,
        )) as Emitted[];
        const exit = seen.findLast((message) => message.type === "exit");
        const stderr = Buffer.from(
          seen
            .filter((message) => message.type === "output" && message.stream === "stderr")
            .flatMap((message) => message.data as number[]),
        ).toString("utf8");
        expect(exit, `${argv.join(" ")} never exited`).toBeDefined();
        expect(exit?.code, `${argv.join(" ")} failed: ${stderr}`).toBe(0);
        return seen;
      };

      const install = async (id: string, home: string): Promise<void> => {
        await run(id, ["venv", `${home}/.venv`, "--python", "/bin/python3"]);
        await run(id, [
          "pip",
          "install",
          "idna==3.11",
          "--index-url",
          `${log.origin}/simple`,
          "--python",
          `${home}/.venv`,
        ]);
        await run(id, ["--version"]);
      };

      await boot("a");
      const before = log.requested.length;
      await install("a", "/first");
      firstRound = log.requested.slice(before);
      await page.evaluate((worker) => (globalThis as unknown as Scope).__kill(worker), "a");

      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.clearBrowserCache");
      await cdp.detach();

      await boot("b");
      const between = log.requested.length;
      await install("b", "/second");
      secondRound = log.requested.slice(between);

      await new Promise<void>((done) => server.close(() => done()));
    }, 900_000);

    afterAll(async () => {
      await browser?.close();
    }, 180_000);

    it("downloads the index and the distribution in the first tab", () => {
      expect(
        firstRound.filter((url) => url.startsWith("/files/")).length,
        `the first tab fetched no distribution, so the second proves nothing: ${firstRound.join(", ")}`,
      ).toBe(2);
    });

    it("downloads no distribution in the second tab, having found it in opfs", () => {
      expect(
        secondRound.filter((url) => url.startsWith("/files/")),
        "a fresh tab re-downloaded a distribution the cold store was holding",
      ).toEqual([]);
    });

    it("still reaches the network for the index, so the browser cache is not doing the work", () => {
      expect(
        secondRound.length,
        "the second tab made no request at all; the browser's own http cache is answering, " +
          "so this file cannot tell uv's cache from Chrome's",
      ).toBeGreaterThan(0);
    });

    it("never asked the fixture for anything it had not recorded", () => {
      expect(log.misses).toEqual([]);
    });
  },
);
