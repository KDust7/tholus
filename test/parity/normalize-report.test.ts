import { describe, expect, it } from "vitest";

import { normalizeReport } from "./normalize-report.js";

describe("uv's four elapsed shapes all normalize, not just the fast ones", () => {
  it("folds away sub-millisecond, millisecond and second durations", () => {
    expect(normalizeReport("Resolved 1 package in 0.05ms")).toBe(
      "Resolved 1 package in <DURATION>",
    );
    expect(normalizeReport("Resolved 1 package in 126ms")).toBe("Resolved 1 package in <DURATION>");
    expect(normalizeReport("Resolved 1 package in 1.50s")).toBe("Resolved 1 package in <DURATION>");
  });

  it("folds away the minutes form, which only appears when the machine is slow", () => {
    expect(
      normalizeReport("Prepared 1 package in 1m 34s"),
      "uv switches to `{m}m {ss}s` past sixty seconds, and a gate that misses it fails on a " +
        "loaded runner rather than on a defect",
    ).toBe("Prepared 1 package in <DURATION>");
    expect(normalizeReport("Installed 2 packages in 12m 05s")).toBe(
      "Installed 2 packages in <DURATION>",
    );
  });

  it("folds the interpreter line whichever way uv names it", () => {
    expect(normalizeReport("Using CPython 3.14.0 interpreter at: /bin/python3")).toBe(
      "Using Python <ENVIRONMENT>",
    );
    expect(normalizeReport("Using Python 3.14.0 environment at: .venv")).toBe(
      "Using Python <ENVIRONMENT>",
    );
  });

  it("leaves everything else exactly as uv wrote it", () => {
    const report = " + idna==3.11\n   Building zipp==3.23.0\n      Built zipp==3.23.0";
    expect(normalizeReport(report)).toBe(report);
  });

  it("does not swallow a version that merely looks like a duration", () => {
    expect(normalizeReport(" + idna==3.11ms")).toBe(" + idna==3.11ms");
  });
});
