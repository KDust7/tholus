import { describe, expect, it } from "vitest";
import {
  type ArtifactBudget,
  type Budgets,
  evaluate,
  formatFindings,
  hasFatalFinding,
  humanBytes,
  type Measurement,
  percentChange,
} from "./report.js";

const artifact: ArtifactBudget = {
  path: "a.wasm",
  label: "engine wasm",
  rawBudgetBytes: 1000,
  brotliBudgetBytes: 300,
  required: false,
};

const budgets: Budgets = {
  regressionThresholdPercent: 10,
  artifacts: [artifact],
};

function measure(overrides: Partial<Measurement> = {}): Measurement {
  return {
    path: "a.wasm",
    label: "engine wasm",
    present: true,
    rawBytes: 900,
    brotliBytes: 250,
    gzipBytes: 280,
    ...overrides,
  };
}

describe("humanBytes", () => {
  it("scales to mebibytes", () => {
    expect(humanBytes(5 * 1024 * 1024)).toBe("5.00 MiB");
  });

  it("scales to kibibytes", () => {
    expect(humanBytes(2048)).toBe("2.0 KiB");
  });

  it("keeps small values in bytes", () => {
    expect(humanBytes(512)).toBe("512 B");
  });
});

describe("percentChange", () => {
  it("computes growth", () => {
    expect(percentChange(100, 120)).toBe(20);
  });

  it("computes shrinkage", () => {
    expect(percentChange(100, 80)).toBe(-20);
  });

  it("treats growth from zero as infinite", () => {
    expect(percentChange(0, 10)).toBe(Number.POSITIVE_INFINITY);
  });

  it("treats zero to zero as unchanged", () => {
    expect(percentChange(0, 0)).toBe(0);
  });
});

describe("evaluate", () => {
  it("passes an artifact inside budget", () => {
    const [finding] = evaluate(budgets, [measure()]);
    expect(finding?.verdict).toBe("ok");
    expect(finding?.fatal).toBe(false);
  });

  it("warns without failing when the advisory budget is exceeded", () => {
    const [finding] = evaluate(budgets, [measure({ rawBytes: 5000 })]);
    expect(finding?.verdict).toBe("over-budget");
    expect(finding?.fatal).toBe(false);
    expect(finding?.notes.join(" ")).toContain("V8 stops caching");
  });

  it("fails when brotli size regresses beyond the threshold", () => {
    const baseline = { "a.wasm": measure({ brotliBytes: 200 }) };
    const [finding] = evaluate(budgets, [measure({ brotliBytes: 260 })], { baseline });
    expect(finding?.verdict).toBe("regressed");
    expect(finding?.fatal).toBe(true);
  });

  it("accepts a small regression within the threshold", () => {
    const baseline = { "a.wasm": measure({ brotliBytes: 250 }) };
    const [finding] = evaluate(budgets, [measure({ brotliBytes: 260 })], { baseline });
    expect(finding?.verdict).toBe("ok");
    expect(finding?.notes.join(" ")).toContain("4.0%");
  });

  it("tolerates an unbuilt optional artifact", () => {
    const [finding] = evaluate(budgets, [measure({ present: false })]);
    expect(finding?.verdict).toBe("missing");
    expect(finding?.fatal).toBe(false);
  });

  it("fails when a required artifact is missing", () => {
    const required: Budgets = {
      ...budgets,
      artifacts: [{ ...artifact, required: true }],
    };
    const [finding] = evaluate(required, [measure({ present: false })]);
    expect(finding?.fatal).toBe(true);
  });

  it("ignores a baseline entry that was never built", () => {
    const baseline = { "a.wasm": measure({ present: false, brotliBytes: 0 }) };
    const [finding] = evaluate(budgets, [measure()], { baseline });
    expect(finding?.verdict).toBe("ok");
  });
});

describe("formatting", () => {
  it("renders measurements and notes", () => {
    const findings = evaluate(budgets, [measure({ rawBytes: 5000 })]);
    const text = formatFindings(findings);
    expect(text).toContain("engine wasm");
    expect(text).toContain("raw 4.9 KiB");
  });

  it("renders an unbuilt artifact", () => {
    const findings = evaluate(budgets, [measure({ present: false })]);
    expect(formatFindings(findings)).toContain("not built");
  });

  it("detects fatal findings", () => {
    expect(hasFatalFinding(evaluate(budgets, [measure()]))).toBe(false);
  });
});
