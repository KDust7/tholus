import { engineConfigSchema } from "@tholus/engine-protocol";
import { describe, expect, it } from "vitest";

import { cacheRoot, derivedEnv, RUST_LOG, resolveEnvironment, UV_NO_CACHE } from "./config-env.js";
import { UV_INDEX } from "./index-env.js";

const PYODIDE = "https://index.pyodide.org/314.0.5";
const parse = (input: unknown) => engineConfigSchema.parse(input);

describe("the engine config becomes the environment uv reads", () => {
  it("derives nothing from the defaults", () => {
    expect(derivedEnv(parse({}))).toEqual({});
  });

  it("turns a disabled cache into the variable uv already understands", () => {
    expect(derivedEnv(parse({ cache: { kind: "none" } }))).toEqual({ [UV_NO_CACHE]: "1" });
  });

  it("leaves the in-memory cache to uv's own defaults", () => {
    expect(derivedEnv(parse({ cache: { kind: "memory" } }))).toEqual({});
  });

  it("carries the log filter", () => {
    expect(derivedEnv(parse({ logFilter: "uv=debug" }))).toEqual({ [RUST_LOG]: "uv=debug" });
  });

  it("merges the index, the cache and the log filter together", () => {
    const env = derivedEnv(
      parse({ cache: { kind: "none" }, logFilter: "trace", index: { pyodideIndex: PYODIDE } }),
    );
    expect(env).toEqual({
      [UV_NO_CACHE]: "1",
      [RUST_LOG]: "trace",
      [UV_INDEX]: PYODIDE,
    });
  });

  it("adds the derived variables to the host's own environment", () => {
    expect(
      resolveEnvironment(parse({ env: { HOME: "/home/browser" }, logFilter: "warn" })),
    ).toEqual({ HOME: "/home/browser", [RUST_LOG]: "warn" });
  });

  it("refuses to guess when the environment already sets the same variable", () => {
    expect(() =>
      resolveEnvironment(parse({ env: { RUST_LOG: "info" }, logFilter: "warn" })),
    ).toThrow(/both set RUST_LOG/);
  });

  it("does not collide when the config derives nothing", () => {
    expect(resolveEnvironment(parse({ env: { RUST_LOG: "info" } }))).toEqual({ RUST_LOG: "info" });
  });
});

describe("a config the engine cannot honor fails rather than being ignored", () => {
  it.each(["opfs", "delegate"])("refuses the %s filesystem, and says what does work", (kind) => {
    expect(() => derivedEnv(parse({ fs: { kind } }))).toThrow(/only has the in-memory filesystem/);
    expect(
      () => derivedEnv(parse({ fs: { kind } })),
      "a host reading this must not go looking for a phase that has already shipped",
    ).toThrow(/cache: \{ kind: "opfs" \}/);
  });

  it("accepts the opfs cache, and derives no environment because uv already caches under HOME", () => {
    expect(derivedEnv(parse({ cache: { kind: "opfs" } }))).toEqual({});
  });

  it("has no resolution target to honor, because that is per-invocation", () => {
    const config = parse({ target: { pythonVersion: "3.13" } }) as Record<string, unknown>;
    expect(
      "target" in config,
      "the config still carries a resolution target; uv resolves per invocation, not per engine",
    ).toBe(false);
  });
});

describe("the cache root is derived the way uv derives it, so a flush finds the cache", () => {
  it("defaults to the home the engine seeds", () => {
    expect(cacheRoot({})).toBe("/home/browser/.cache/uv");
  });

  it("follows a home the host moved", () => {
    expect(cacheRoot({ HOME: "/root" })).toBe("/root/.cache/uv");
  });

  it("prefers an explicit cache directory over everything else", () => {
    expect(cacheRoot({ UV_CACHE_DIR: "/tmp/uv", HOME: "/root" })).toBe("/tmp/uv");
  });

  it("honors the xdg cache home between the two", () => {
    expect(cacheRoot({ XDG_CACHE_HOME: "/xdg", HOME: "/root" })).toBe("/xdg/uv");
  });

  it("ignores a relative xdg cache home, as the xdg spec requires", () => {
    expect(cacheRoot({ XDG_CACHE_HOME: "relative", HOME: "/root" })).toBe("/root/.cache/uv");
  });
});
