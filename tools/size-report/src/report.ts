export interface ArtifactBudget {
  path: string;
  label: string;
  rawBudgetBytes: number;
  brotliBudgetBytes: number;
  required?: boolean;
}

export interface Budgets {
  regressionThresholdPercent: number;
  artifacts: ArtifactBudget[];
}

export interface Measurement {
  path: string;
  label: string;
  present: boolean;
  rawBytes: number;
  brotliBytes: number;
  gzipBytes: number;
}

export type Verdict = "ok" | "missing" | "over-budget" | "regressed";

export interface ArtifactFinding {
  label: string;
  path: string;
  verdict: Verdict;
  measurement: Measurement;
  notes: string[];
  fatal: boolean;
}

export interface ReportOptions {
  baseline?: Record<string, Measurement> | undefined;
}

export function humanBytes(bytes: number): string {
  const mib = 1024 * 1024;
  const kib = 1024;
  if (bytes >= mib) {
    return `${(bytes / mib).toFixed(2)} MiB`;
  }
  if (bytes >= kib) {
    return `${(bytes / kib).toFixed(1)} KiB`;
  }
  return `${bytes} B`;
}

export function percentChange(before: number, after: number): number {
  if (before === 0) {
    return after === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return ((after - before) / before) * 100;
}

export function evaluate(
  budgets: Budgets,
  measurements: Measurement[],
  options: ReportOptions = {},
): ArtifactFinding[] {
  return measurements.map((measurement) => {
    const budget = budgets.artifacts.find((entry) => entry.path === measurement.path);
    const notes: string[] = [];

    if (!measurement.present) {
      const required = budget?.required ?? false;
      return {
        label: measurement.label,
        path: measurement.path,
        verdict: "missing",
        measurement,
        notes: [required ? "required artifact is missing" : "artifact not built yet"],
        fatal: required,
      };
    }

    let verdict: Verdict = "ok";
    let fatal = false;

    if (budget) {
      if (measurement.rawBytes > budget.rawBudgetBytes) {
        verdict = "over-budget";
        notes.push(
          `raw ${humanBytes(measurement.rawBytes)} exceeds the ${humanBytes(
            budget.rawBudgetBytes,
          )} advisory budget; past this size V8 stops caching compiled code and every visit pays a full recompile`,
        );
      }
      if (measurement.brotliBytes > budget.brotliBudgetBytes) {
        verdict = "over-budget";
        notes.push(
          `brotli ${humanBytes(measurement.brotliBytes)} exceeds the ${humanBytes(
            budget.brotliBudgetBytes,
          )} advisory budget`,
        );
      }
    }

    const previous = options.baseline?.[measurement.path];
    if (previous?.present) {
      const change = percentChange(previous.brotliBytes, measurement.brotliBytes);
      if (change > budgets.regressionThresholdPercent) {
        verdict = "regressed";
        fatal = true;
        notes.push(
          `brotli size grew ${change.toFixed(1)}% against the baseline (${humanBytes(
            previous.brotliBytes,
          )} to ${humanBytes(measurement.brotliBytes)})`,
        );
      } else {
        notes.push(`brotli change against baseline: ${change.toFixed(1)}%`);
      }
    }

    return { label: measurement.label, path: measurement.path, verdict, measurement, notes, fatal };
  });
}

export function formatFindings(findings: ArtifactFinding[]): string {
  const lines = findings.map((finding) => {
    const { measurement } = finding;
    const head = measurement.present
      ? `${finding.label}: raw ${humanBytes(measurement.rawBytes)}, brotli ${humanBytes(
          measurement.brotliBytes,
        )}, gzip ${humanBytes(measurement.gzipBytes)}`
      : `${finding.label}: not built`;
    const notes = finding.notes.map((note) => `    - ${note}`);
    return [`  ${head}`, ...notes].join("\n");
  });
  return lines.join("\n");
}

export function hasFatalFinding(findings: ArtifactFinding[]): boolean {
  return findings.some((finding) => finding.fatal);
}
