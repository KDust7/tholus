import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser } from "./browser-harness.js";
import { root } from "./cli-goldens.js";

const dist = resolve(root, "packages/core/dist");
const isBuilt = existsSync(resolve(dist, "opfs-store.js"));

if (process.env.CI && !isBuilt) {
  throw new Error(
    "the opfs gate cannot run: packages/core/dist is missing. " +
      "Skipping here would report a gate that never ran.",
  );
}

const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".map": "application/json",
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>opfs</title>`;

interface Probe {
  name: string;
  ok: boolean;
  detail: string;
}

describe.skipIf(!isBuilt)("the cold store works against a real origin private filesystem", () => {
  let server: Server;
  let browser: Browser;
  let page: Page;

  const scripts = new Map<string, string>();

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = (request.url ?? "/").split("?")[0] ?? "/";
      const script = scripts.get(url);
      if (script !== undefined) {
        response.writeHead(200, { "content-type": "text/javascript" }).end(script);
        return;
      }
      if (url.startsWith("/dist/")) {
        const file = resolve(dist, url.slice("/dist/".length));
        if (file.startsWith(dist) && existsSync(file)) {
          readFile(file)
            .then((body) => {
              response
                .writeHead(200, {
                  "content-type": TYPES[extname(file)] ?? "application/octet-stream",
                })
                .end(body);
            })
            .catch(() => response.writeHead(500).end());
          return;
        }
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    browser = await launchBrowser();
    page = await browser.newPage();
    await page.goto(`${origin}/index.html`);
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => server?.close(() => done()));
  }, 180_000);

  let scriptCounter = 0;

  const serve = (source: string): string => {
    scriptCounter += 1;
    const url = `/probe-${scriptCounter}.js`;
    scripts.set(url, source);
    return url;
  };

  const runInWorker = async (body: string, timeoutMs = 60_000): Promise<Probe[]> => {
    return page.evaluate(
      async ([url, budget]) => {
        const worker = new Worker(url as string, { type: "module" });
        try {
          return await new Promise<Probe[]>((done, fail) => {
            const timer = setTimeout(() => fail(new Error("the worker never answered")), budget);
            worker.addEventListener("message", (event) => {
              clearTimeout(timer);
              done(event.data as Probe[]);
            });
            worker.addEventListener("error", (event) => {
              clearTimeout(timer);
              fail(new Error(`${event.message} (${event.filename}:${event.lineno})`));
            });
          });
        } finally {
          worker.terminate();
        }
      },
      [serve(body), timeoutMs] as const,
    );
  };

  const expectAllPassed = (probes: Probe[]): void => {
    const failed = probes.filter((probe) => !probe.ok);
    expect(failed.map((probe) => `${probe.name}: ${probe.detail}`)).toEqual([]);
    expect(probes.length).toBeGreaterThan(0);
  };

  it("round trips blobs, nested paths, removal and the manifest", async () => {
    const probes = await runInWorker(`
      import { openColdStore } from "/dist/opfs-store.js";
      const out = [];
      const say = (name, ok, detail = "") => out.push({ name, ok, detail: String(detail) });
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry("uv-wasm", { recursive: true }).catch(() => {});
        const store = await openColdStore(root);

        say("a fresh store has no manifest", (await store.readManifest()) === undefined);

        await store.write("simple-v24/idna.rkyv", enc.encode("index"));
        say(
          "reads back what it wrote",
          dec.decode(await store.read("simple-v24/idna.rkyv")) === "index",
        );

        await store.write("archive-v0/xyz/idna/__init__.py", enc.encode("import idna"));
        say(
          "creates every directory a nested path needs",
          dec.decode(await store.read("archive-v0/xyz/idna/__init__.py")) === "import idna",
        );

        say("reports a missing path as undefined", (await store.read("never")) === undefined);

        await store.write("t", enc.encode("a much longer payload"));
        await store.write("t", enc.encode("short"));
        say("truncates a shortened payload", dec.decode(await store.read("t")) === "short");

        await store.remove("simple-v24/idna.rkyv");
        say("removes what it holds", (await store.read("simple-v24/idna.rkyv")) === undefined);

        await store.remove("never/written");
        say("tolerates removing what it never held", true);

        await store.writeManifest('{"schemaVersion":2}');
        say("round trips the manifest", (await store.readManifest()) === '{"schemaVersion":2}');

        const again = await openColdStore(root);
        say(
          "a reopened store still sees the manifest",
          (await again.readManifest()) === '{"schemaVersion":2}',
        );
        say(
          "a reopened store still sees the blobs",
          dec.decode(await again.read("archive-v0/xyz/idna/__init__.py")) === "import idna",
        );
      } catch (error) {
        say("threw", false, error && error.stack ? error.stack : error);
      }
      postMessage(out);
    `);
    expectAllPassed(probes);
  });

  it("survives a payload larger than one sync write, which is what a wheel is", async () => {
    const probes = await runInWorker(`
      import { openColdStore } from "/dist/opfs-store.js";
      const out = [];
      try {
        const root = await navigator.storage.getDirectory();
        const store = await openColdStore(root, "big");
        const payload = new Uint8Array(3 * 1024 * 1024);
        for (let i = 0; i < payload.length; i += 1) payload[i] = i & 0xff;
        await store.write("wheels-v6/big.whl", payload);
        const back = await store.read("wheels-v6/big.whl");
        const same = back.length === payload.length && back[payload.length - 1] === ((payload.length - 1) & 0xff);
        out.push({ name: "a three megabyte blob round trips", ok: same, detail: String(back.length) });
      } catch (error) {
        out.push({ name: "threw", ok: false, detail: String(error && error.stack ? error.stack : error) });
      }
      postMessage(out);
    `);
    expectAllPassed(probes);
  });

  it("serializes two tabs holding the cache lock, so neither tears the other's flush", async () => {
    const source = serve(`
      import { CACHE_LOCK, webLocks } from "/dist/persistence.js";
      addEventListener("message", async (event) => {
        const held = await webLocks(CACHE_LOCK, async () => {
          const entered = Date.now();
          await new Promise((done) => setTimeout(done, 250));
          return [entered, Date.now()];
        });
        postMessage({ id: event.data, held });
      });
    `);
    const windows = await page.evaluate(async (url) => {
      const workers = [new Worker(url, { type: "module" }), new Worker(url, { type: "module" })];
      try {
        const answers = workers.map(
          (worker, index) =>
            new Promise<{ id: number; held: [number, number] }>((done, fail) => {
              const timer = setTimeout(() => fail(new Error("no answer")), 30_000);
              worker.addEventListener("message", (event) => {
                clearTimeout(timer);
                done(event.data as { id: number; held: [number, number] });
              });
              worker.addEventListener("error", (event) => {
                clearTimeout(timer);
                fail(new Error(`${event.message} (${event.filename}:${event.lineno})`));
              });
              worker.postMessage(index);
            }),
        );
        return await Promise.all(answers);
      } finally {
        for (const worker of workers) {
          worker.terminate();
        }
      }
    }, source);

    const held = windows.map((answer) => answer.held).sort((a, b) => a[0] - b[0]);
    expect(held).toHaveLength(2);
    const [first, second] = held as [[number, number], [number, number]];
    expect(
      second[0],
      `the two tabs overlapped: ${JSON.stringify(held)}; the lock did not exclude`,
    ).toBeGreaterThanOrEqual(first[1] - 1);
  }, 120_000);
});
