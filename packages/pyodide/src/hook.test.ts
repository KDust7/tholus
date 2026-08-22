import { describe, expect, it } from "vitest";

import type { PyodideLike } from "./facts.js";
import { callOf, type HookRequest, parseResult, RUNNER, runHook } from "./hook.js";

const request = (overrides: Partial<HookRequest> = {}): HookRequest => ({
  script: "print('hello')",
  cwd: "/src",
  env: { PEP517: "1" },
  ...overrides,
});

const payloadOf = (call: string): Record<string, unknown> => {
  const quoted = call.slice(call.indexOf("(") + 1, call.lastIndexOf(")"));
  return JSON.parse(JSON.parse(quoted) as string) as Record<string, unknown>;
};

describe("the hook call carries its arguments as one json payload", () => {
  it("passes a single quoted argument, so nothing else is interpolated into python", () => {
    const call = callOf(request(), ["/site"]);
    const inner = call.slice("_uvwasm_run_hook(".length, -1);

    expect(call.startsWith("_uvwasm_run_hook(") && call.endsWith(")")).toBe(true);
    expect(
      typeof JSON.parse(inner),
      "the argument must be one string literal; an object or a second value would mean python is parsing our data",
    ).toBe("string");
  });

  it("hands over the script, the working directory, the env and the path", () => {
    expect(payloadOf(callOf(request(), ["/site"]))).toEqual({
      script: "print('hello')",
      cwd: "/src",
      env: { PEP517: "1" },
      sitePackages: ["/site"],
    });
  });

  it("survives a script full of quotes, backslashes and newlines", () => {
    const nasty = `print('''  " '' \\ \n ''')`;
    expect(payloadOf(callOf(request({ script: nasty }), []))["script"]).toBe(nasty);
  });

  it("cannot be closed early by a quote in a path uv chose", () => {
    const hostile = `/src"); import os; os.system("echo pwned`;
    expect(payloadOf(callOf(request({ cwd: hostile }), []))["cwd"]).toBe(hostile);
  });
});

describe("a hook result is read back defensively", () => {
  it("reads what the runtime reported", () => {
    expect(parseResult('{"stdout":["a"],"stderr":["b"],"code":3}')).toEqual({
      stdout: ["a"],
      stderr: ["b"],
      code: 3,
    });
  });

  it("treats a result with no exit code as a failure, never as success", () => {
    expect(parseResult('{"stdout":[]}').code).toBe(1);
  });
});

describe("running a hook installs the runner first", () => {
  it("defines the runner, then calls it, in that order", () => {
    const ran: string[] = [];
    const pyodide = {
      runPython(code: string) {
        ran.push(code);
        return code.includes("_uvwasm_run_hook(") ? '{"stdout":["ok"],"stderr":[],"code":0}' : "";
      },
    } as unknown as PyodideLike;

    const result = runHook(pyodide, request(), ["/site"]);
    expect(ran[0]).toBe(RUNNER);
    expect(ran[1]?.startsWith("_uvwasm_run_hook(")).toBe(true);
    expect(result).toEqual({ stdout: ["ok"], stderr: [], code: 0 });
  });
});
