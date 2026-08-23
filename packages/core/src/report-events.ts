import type { EngineEvent, EnginePhase, PackageRef } from "@uv-wasm/engine-protocol";

const ESCAPE = String.fromCharCode(27);
const ANSI = new RegExp(`${ESCAPE}\\[[0-9;]*[A-Za-z]`, "g");

const SUMMARY =
  /^(Resolved|Prepared|Installed|Uninstalled|Audited)(?: (\d+) packages?(?: [a-z][a-z ]*)?)? in (\d+m \d{2}s|\d+(?:\.\d+)?ms|\d+(?:\.\d+)?s)$/;

const WOULD = /^Would (download|install|uninstall) (\d+) packages?$/;

const CHANGE = /^ ([+~-]) (\S+?)(?:==(\S+)| @ (\S+))?$/;

const BUILDING = /^\s*(Building|Built) (\S+?)(?:==(\S+)| @ (\S+))?$/;

const PHASE_OF: Record<string, EnginePhase> = {
  Resolved: "resolving",
  Prepared: "downloading",
  Installed: "installing",
  Uninstalled: "uninstalling",
  Audited: "auditing",
};

const WOULD_PHASE_OF: Record<string, EnginePhase> = {
  download: "downloading",
  install: "installing",
  uninstall: "uninstalling",
};

const MINUTES = /^(\d+)m (\d{2})s$/;
const SECONDS = /^(\d+(?:\.\d+)?)(ms|s)$/;
const MULTIPLIER: Record<string, number> = { ms: 1, s: 1000 };

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export function millisecondsOf(elapsed: string): number {
  const minutes = MINUTES.exec(elapsed);
  if (minutes) {
    return Number(minutes[1]) * 60_000 + Number(minutes[2]) * 1000;
  }
  const seconds = SECONDS.exec(elapsed);
  if (!seconds) {
    return 0;
  }
  return Number(seconds[1]) * (MULTIPLIER[seconds[2] as string] ?? 1);
}

function refOf(name: string, version: string | undefined, url: string | undefined): PackageRef {
  return {
    name,
    ...(version === undefined ? {} : { version }),
    ...(url === undefined ? {} : { source: url }),
  };
}

interface Pending {
  installed: PackageRef[];
  removed: PackageRef[];
  unchanged: number;
}

export interface ReportReader {
  push(chunk: string): EngineEvent[];
  flush(): EngineEvent[];
}

export function createReportReader(invocationId: string): ReportReader {
  let carry = "";
  let open: EnginePhase | undefined;
  let changes: Pending = { installed: [], removed: [], unchanged: 0 };
  let reported = false;

  const closePhase = (next: EnginePhase, into: EngineEvent[]): void => {
    if (open !== undefined && open !== next) {
      into.push({ type: "phase", invocationId, phase: open, state: "end" });
    }
    if (open !== next) {
      into.push({ type: "phase", invocationId, phase: next, state: "start" });
    }
    into.push({ type: "phase", invocationId, phase: next, state: "end" });
    open = undefined;
  };

  const line = (raw: string, into: EngineEvent[]): void => {
    const text = stripAnsi(raw).replace(/\r/g, "").trimEnd();

    const change = CHANGE.exec(text);
    if (change) {
      const ref = refOf(change[2] as string, change[3], change[4]);
      if (change[1] === "+") {
        changes.installed.push(ref);
      } else if (change[1] === "-") {
        changes.removed.push(ref);
      } else {
        changes.unchanged += 1;
      }
      return;
    }

    const building = BUILDING.exec(text);
    if (building) {
      into.push({
        type: "runtime-finalize",
        invocationId,
        package: refOf(building[2] as string, building[3], building[4]),
        action: "build",
        state: building[1] === "Building" ? "start" : "end",
      });
      if (building[1] === "Building" && open !== "building") {
        into.push({ type: "phase", invocationId, phase: "building", state: "start" });
        open = "building";
      }
      return;
    }

    const would = WOULD.exec(text);
    if (would) {
      const phase = WOULD_PHASE_OF[would[1] as string] as EnginePhase;
      closePhase(phase, into);
      if (phase === "installing" || phase === "uninstalling") {
        reported = true;
      }
      return;
    }

    const summary = SUMMARY.exec(text);
    if (!summary) {
      return;
    }
    const phase = PHASE_OF[summary[1] as string] as EnginePhase;
    const count = summary[2] === undefined ? 0 : Number(summary[2]);
    const durationMs = millisecondsOf(summary[3] as string);

    closePhase(phase, into);

    if (phase === "resolving") {
      into.push({
        type: "resolution-complete",
        invocationId,
        packageCount: count,
        durationMs,
      });
    }
    if (phase === "installing" || phase === "uninstalling") {
      reported = true;
    }
  };

  const drain = (): EngineEvent[] => {
    if (!reported) {
      return [];
    }
    reported = false;
    const settled = changes;
    changes = { installed: [], removed: [], unchanged: 0 };
    return [
      {
        type: "install-report",
        invocationId,
        installed: settled.installed,
        removed: settled.removed,
        unchanged: settled.unchanged,
      },
    ];
  };

  return {
    push(chunk: string): EngineEvent[] {
      const events: EngineEvent[] = [];
      carry += chunk;
      let cut = carry.indexOf("\n");
      while (cut !== -1) {
        line(carry.slice(0, cut), events);
        carry = carry.slice(cut + 1);
        cut = carry.indexOf("\n");
      }
      return events;
    },

    flush(): EngineEvent[] {
      const events: EngineEvent[] = [];
      if (carry.length > 0) {
        line(carry, events);
        carry = "";
      }
      if (open !== undefined) {
        events.push({ type: "phase", invocationId, phase: open, state: "end" });
        open = undefined;
      }
      events.push(...drain());
      return events;
    },
  };
}
