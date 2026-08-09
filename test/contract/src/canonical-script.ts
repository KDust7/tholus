import type { MockScript } from "@uv-wasm/mock-engine";

export const canonicalScript: MockScript = {
  commands: [
    {
      argv: ["pip", "list"],
      steps: [{ kind: "stdout", text: "rich    13.9.4\n" }],
      exitCode: 0,
    },
    {
      argv: ["pip", "install", "rich"],
      steps: [
        {
          kind: "event",
          event: { type: "phase", invocationId: "inv-1", phase: "resolving", state: "start" },
        },
        {
          kind: "event",
          event: {
            type: "resolution-complete",
            invocationId: "inv-1",
            packageCount: 4,
            durationMs: 31,
          },
        },
        { kind: "stderr", text: "Resolved 4 packages\n" },
        {
          kind: "event",
          event: {
            type: "install-report",
            invocationId: "inv-1",
            installed: [{ name: "rich", version: "13.9.4" }],
            removed: [],
            unchanged: 3,
          },
        },
      ],
      exitCode: 0,
    },
    {
      argv: ["pip", "uninstall", "rich"],
      steps: [
        { kind: "stderr", text: "Proceed? [y/n] " },
        { kind: "prompt", echo: true },
        { kind: "stderr", text: "Uninstalled 1 package\n" },
      ],
      exitCode: 0,
    },
    {
      argv: ["pip", "install", "slow"],
      steps: [{ kind: "prompt", echo: false }],
      exitCode: 0,
    },
    {
      argv: ["pip", "install", "conflicting"],
      steps: [{ kind: "stderr", text: "  x No solution found when resolving dependencies\n" }],
      exitCode: 1,
      error: {
        code: "resolution-conflict",
        message: "No solution found when resolving dependencies",
      },
    },
  ],
};
