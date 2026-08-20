import { describe, expect, it } from "vitest";

import {
  applyIndexEnv,
  indexEnv,
  UV_DEFAULT_INDEX,
  UV_INDEX,
  UV_INDEX_STRATEGY,
} from "./index-env.js";

const PYODIDE = "https://index.pyodide.org/314.0.5";

describe("index configuration becomes the environment uv already reads", () => {
  it("derives nothing from an empty index config", () => {
    expect(indexEnv({})).toEqual({});
  });

  it("routes indexUrl to the default index rather than the extras", () => {
    expect(indexEnv({ indexUrl: "https://example.invalid/simple" })).toEqual({
      [UV_DEFAULT_INDEX]: "https://example.invalid/simple",
    });
  });

  it("joins extra indexes with the whitespace uv splits on", () => {
    expect(indexEnv({ extraIndexUrls: ["https://a.invalid", "https://b.invalid"] })).toEqual({
      [UV_INDEX]: "https://a.invalid https://b.invalid",
    });
  });

  it("passes the pyodide index through verbatim", () => {
    expect(indexEnv({ pyodideIndex: PYODIDE })).toEqual({ [UV_INDEX]: PYODIDE });
  });

  it("puts the pyodide index ahead of the host's extras, because earlier wins", () => {
    expect(indexEnv({ pyodideIndex: PYODIDE, extraIndexUrls: ["https://a.invalid"] })).toEqual({
      [UV_INDEX]: `${PYODIDE} https://a.invalid`,
    });
  });

  it("carries the index strategy", () => {
    expect(indexEnv({ indexStrategy: "unsafe-best-match" })).toEqual({
      [UV_INDEX_STRATEGY]: "unsafe-best-match",
    });
  });

  it("adds the derived variables to the host's environment", () => {
    expect(applyIndexEnv({ HOME: "/home/browser" }, { pyodideIndex: PYODIDE })).toEqual({
      HOME: "/home/browser",
      [UV_INDEX]: PYODIDE,
    });
  });

  it("leaves the environment it was given untouched", () => {
    const env = { HOME: "/home/browser" };
    applyIndexEnv(env, { pyodideIndex: PYODIDE });
    expect(env).toEqual({ HOME: "/home/browser" });
  });

  it("refuses to guess when the environment already sets the same variable", () => {
    expect(() =>
      applyIndexEnv({ [UV_INDEX]: "https://host.invalid" }, { pyodideIndex: PYODIDE }),
    ).toThrow(/config.index and config.env both set UV_INDEX/);
  });

  it("names every colliding variable, not just the first", () => {
    expect(() =>
      applyIndexEnv(
        { [UV_INDEX]: "https://host.invalid", [UV_INDEX_STRATEGY]: "first-index" },
        { pyodideIndex: PYODIDE, indexStrategy: "first-index" },
      ),
    ).toThrow(/UV_INDEX, UV_INDEX_STRATEGY/);
  });

  it("does not collide when the config derives nothing", () => {
    expect(applyIndexEnv({ [UV_INDEX]: "https://host.invalid" }, {})).toEqual({
      [UV_INDEX]: "https://host.invalid",
    });
  });
});
