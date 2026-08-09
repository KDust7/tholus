import { createMockEngine, type MockScript } from "@uv-wasm/mock-engine";
import { describe, expect, it } from "vitest";
import { parseShow, runCommand } from "./commands.js";
import { createEngine } from "./engine.js";
import { ResolutionConflictError, UnsupportedError } from "./errors.js";

async function engineFor(script: MockScript) {
  const mock = createMockEngine(script);
  const engine = await createEngine({ endpoint: () => mock });
  return { engine, mock };
}

describe("venv", () => {
  it("creates an environment at the default location", async () => {
    const { engine, mock } = await engineFor({ commands: [{ argv: ["venv"], exitCode: 0 }] });

    const created = await engine.venv.create();

    expect(created.path).toBe(".venv");
    const exec = mock.received.find((message) => message.type === "exec");
    expect(exec?.type === "exec" && exec.argv).toEqual(["venv"]);
    engine.terminate();
  });

  it("passes through path, python version, prompt, and clear", async () => {
    const argv = ["venv", "env", "--python", "3.14", "--prompt", "demo", "--clear"];
    const { engine, mock } = await engineFor({ commands: [{ argv, exitCode: 0 }] });

    await engine.venv.create({
      path: "env",
      pythonVersion: "3.14",
      prompt: "demo",
      clear: true,
    });

    const exec = mock.received.find((message) => message.type === "exec");
    expect(exec?.type === "exec" && exec.argv).toEqual(argv);
    engine.terminate();
  });

  it("raises the engine's structured cause on failure", async () => {
    const { engine } = await engineFor({
      commands: [
        {
          argv: ["venv"],
          exitCode: 1,
          error: { code: "unsupported", message: "no interpreter" },
        },
      ],
    });

    await expect(engine.venv.create()).rejects.toBeInstanceOf(UnsupportedError);
    engine.terminate();
  });
});

describe("pip install", () => {
  const installArgv = ["pip", "install", "rich"];

  it("reports what changed from the structured event", async () => {
    const { engine } = await engineFor({
      commands: [
        {
          argv: installArgv,
          steps: [
            { kind: "stderr", text: "Resolved 1 package\n" },
            {
              kind: "event",
              event: {
                type: "install-report",
                invocationId: "inv-1",
                installed: [{ name: "rich", version: "13.9.4" }],
                removed: [],
                unchanged: 2,
              },
            },
          ],
          exitCode: 0,
        },
      ],
    });

    const report = await engine.pip.install({ packages: ["rich"] });

    expect(report.installed).toEqual([{ name: "rich", version: "13.9.4" }]);
    expect(report.unchanged).toBe(2);
    engine.terminate();
  });

  it("lists packages awaiting runtime finalisation", async () => {
    const { engine } = await engineFor({
      commands: [
        {
          argv: ["pip", "install", "numpy"],
          steps: [
            {
              kind: "event",
              event: {
                type: "runtime-finalize",
                invocationId: "inv-1",
                package: { name: "numpy", version: "2.4.3" },
                action: "dynlibs",
                state: "start",
              },
            },
          ],
          exitCode: 0,
        },
      ],
    });

    const report = await engine.pip.install({ packages: ["numpy"] });

    expect(report.needsRuntimeFinalize).toEqual([{ name: "numpy", version: "2.4.3" }]);
    engine.terminate();
  });

  it("returns an empty report when the engine emitted no summary", async () => {
    const { engine } = await engineFor({ commands: [{ argv: installArgv, exitCode: 0 }] });

    const report = await engine.pip.install({ packages: ["rich"] });

    expect(report).toEqual({ installed: [], removed: [], unchanged: 0, needsRuntimeFinalize: [] });
    engine.terminate();
  });

  it("builds the argv for requirements, constraints, and flags", async () => {
    const argv = [
      "pip",
      "install",
      "-r",
      "requirements.txt",
      "-c",
      "constraints.txt",
      "--upgrade",
      "--reinstall",
      "--dry-run",
      "--require-hashes",
      "rich",
    ];
    const { engine, mock } = await engineFor({ commands: [{ argv, exitCode: 0 }] });

    await engine.pip.install({
      packages: ["rich"],
      requirements: ["requirements.txt"],
      constraints: ["constraints.txt"],
      upgrade: true,
      reinstall: true,
      dryRun: true,
      requireHashes: true,
    });

    const exec = mock.received.find((message) => message.type === "exec");
    expect(exec?.type === "exec" && exec.argv).toEqual(argv);
    engine.terminate();
  });

  it("targets a specific environment", async () => {
    const argv = ["pip", "install", "rich", "--python", "/work/.venv"];
    const { engine, mock } = await engineFor({ commands: [{ argv, exitCode: 0 }] });

    await engine.pip.install({ packages: ["rich"], venv: "/work/.venv" });

    const exec = mock.received.find((message) => message.type === "exec");
    expect(exec?.type === "exec" && exec.argv).toEqual(argv);
    engine.terminate();
  });

  it("surfaces a resolution conflict as a typed error", async () => {
    const { engine } = await engineFor({
      commands: [
        {
          argv: installArgv,
          exitCode: 1,
          error: { code: "resolution-conflict", message: "no solution found" },
        },
      ],
    });

    await expect(engine.pip.install({ packages: ["rich"] })).rejects.toBeInstanceOf(
      ResolutionConflictError,
    );
    engine.terminate();
  });

  it("falls back to stderr when the engine reported no cause", async () => {
    const { engine } = await engineFor({
      commands: [
        { argv: installArgv, exitCode: 1, steps: [{ kind: "stderr", text: "disk on fire\n" }] },
      ],
    });

    await expect(engine.pip.install({ packages: ["rich"] })).rejects.toThrow("disk on fire");
    engine.terminate();
  });
});

describe("pip uninstall", () => {
  it("reports removals", async () => {
    const { engine } = await engineFor({
      commands: [
        {
          argv: ["pip", "uninstall", "rich"],
          steps: [
            {
              kind: "event",
              event: {
                type: "install-report",
                invocationId: "inv-1",
                installed: [],
                removed: [{ name: "rich", version: "13.9.4" }],
                unchanged: 0,
              },
            },
          ],
          exitCode: 0,
        },
      ],
    });

    const report = await engine.pip.uninstall(["rich"]);

    expect(report.removed).toEqual([{ name: "rich", version: "13.9.4" }]);
    engine.terminate();
  });
});

describe("pip list", () => {
  it("parses the json listing", async () => {
    const payload = JSON.stringify([
      { name: "rich", version: "13.9.4" },
      { name: "idna", version: "3.10" },
    ]);
    const { engine } = await engineFor({
      commands: [
        {
          argv: ["pip", "list", "--format", "json"],
          steps: [{ kind: "stdout", text: payload }],
          exitCode: 0,
        },
      ],
    });

    const packages = await engine.pip.list();

    expect(packages).toEqual([
      { name: "rich", version: "13.9.4" },
      { name: "idna", version: "3.10" },
    ]);
    engine.terminate();
  });

  it("treats empty output as an empty environment", async () => {
    const { engine } = await engineFor({
      commands: [{ argv: ["pip", "list", "--format", "json"], exitCode: 0 }],
    });

    expect(await engine.pip.list()).toEqual([]);
    engine.terminate();
  });

  it("skips entries missing a name or version", async () => {
    const payload = JSON.stringify([{ name: "rich" }, { name: "idna", version: "3.10" }, 7]);
    const { engine } = await engineFor({
      commands: [
        {
          argv: ["pip", "list", "--format", "json"],
          steps: [{ kind: "stdout", text: payload }],
          exitCode: 0,
        },
      ],
    });

    expect(await engine.pip.list()).toEqual([{ name: "idna", version: "3.10" }]);
    engine.terminate();
  });

  it("rejects output that is not json", async () => {
    const { engine } = await engineFor({
      commands: [
        {
          argv: ["pip", "list", "--format", "json"],
          steps: [{ kind: "stdout", text: "not json" }],
          exitCode: 0,
        },
      ],
    });

    await expect(engine.pip.list()).rejects.toBeInstanceOf(UnsupportedError);
    engine.terminate();
  });
});

describe("pip freeze and check", () => {
  it("returns freeze output verbatim", async () => {
    const { engine } = await engineFor({
      commands: [
        {
          argv: ["pip", "freeze"],
          steps: [{ kind: "stdout", text: "rich==13.9.4\n" }],
          exitCode: 0,
        },
      ],
    });

    expect(await engine.pip.freeze()).toBe("rich==13.9.4\n");
    engine.terminate();
  });

  it("reports a healthy environment", async () => {
    const { engine } = await engineFor({ commands: [{ argv: ["pip", "check"], exitCode: 0 }] });

    expect(await engine.pip.check()).toEqual({ ok: true, problems: [] });
    engine.terminate();
  });

  it("collects the problems when the check fails", async () => {
    const { engine } = await engineFor({
      commands: [
        {
          argv: ["pip", "check"],
          steps: [{ kind: "stderr", text: "rich 13.9.4 requires markdown-it-py\n" }],
          exitCode: 1,
        },
      ],
    });

    const outcome = await engine.pip.check();

    expect(outcome.ok).toBe(false);
    expect(outcome.problems).toEqual(["rich 13.9.4 requires markdown-it-py"]);
    engine.terminate();
  });
});

describe("pip compile and sync", () => {
  it("returns the compiled requirements", async () => {
    const argv = [
      "pip",
      "compile",
      "requirements.in",
      "--generate-hashes",
      "--universal",
      "--python-version",
      "3.14",
      "--python-platform",
      "wasm32-pyodide2026",
    ];
    const { engine } = await engineFor({
      commands: [{ argv, steps: [{ kind: "stdout", text: "rich==13.9.4\n" }], exitCode: 0 }],
    });

    const compiled = await engine.pip.compile({
      requirements: ["requirements.in"],
      generateHashes: true,
      universal: true,
      pythonVersion: "3.14",
      pythonPlatform: "wasm32-pyodide2026",
    });

    expect(compiled.text).toBe("rich==13.9.4\n");
    engine.terminate();
  });

  it("synchronizes from a compiled file", async () => {
    const argv = ["pip", "sync", "requirements.txt", "--require-hashes"];
    const { engine, mock } = await engineFor({ commands: [{ argv, exitCode: 0 }] });

    await engine.pip.sync({ requirements: ["requirements.txt"], requireHashes: true });

    const exec = mock.received.find((message) => message.type === "exec");
    expect(exec?.type === "exec" && exec.argv).toEqual(argv);
    engine.terminate();
  });
});

describe("runCommand", () => {
  it("returns the raw outcome without throwing on failure", async () => {
    const { engine } = await engineFor({
      commands: [{ argv: ["pip", "list"], exitCode: 3, steps: [{ kind: "stderr", text: "nope" }] }],
    });

    const outcome = await runCommand(engine, ["pip", "list"]);

    expect(outcome.code).toBe(3);
    expect(outcome.stderr).toBe("nope");
    engine.terminate();
  });
});

describe("parseShow", () => {
  it("parses a single package block", () => {
    const details = parseShow(
      [
        "Name: rich",
        "Version: 13.9.4",
        "Location: /work/.venv",
        "Requires: markdown-it-py, pygments",
        "Required-by:",
      ].join("\n"),
    );

    expect(details).toEqual([
      {
        name: "rich",
        version: "13.9.4",
        location: "/work/.venv",
        requires: ["markdown-it-py", "pygments"],
        requiredBy: [],
      },
    ]);
  });

  it("parses multiple blocks", () => {
    const text = ["Name: a", "Version: 1", "---", "Name: b", "Version: 2"].join("\n");
    expect(parseShow(text).map((detail) => detail.name)).toEqual(["a", "b"]);
  });

  it("ignores a block without a name", () => {
    expect(parseShow("Version: 1")).toEqual([]);
  });

  it("ignores unparseable lines", () => {
    const details = parseShow(["Name: a", "Version: 1", "garbage"].join("\n"));
    expect(details).toHaveLength(1);
  });

  it("returns nothing for empty input", () => {
    expect(parseShow("   ")).toEqual([]);
  });
});
