import { parseHostMessage, parseWorkerMessage } from "@tholus/engine-protocol";
import { type MatchFailure, matchValue } from "./match.js";
import type { Transcript } from "./schema.js";

export interface EngineEndpoint {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  terminate(): void;
}

export interface ReplayMismatch {
  step: number;
  reason: string;
  failures?: MatchFailure[];
}

export interface ReplayResult {
  transcript: string;
  ok: boolean;
  mismatches: ReplayMismatch[];
  observed: unknown[];
}

export interface ReplayOptions {
  timeoutMs?: number;
  settleMs?: number;
}

class MessageQueue {
  private readonly pending: unknown[] = [];
  private readonly waiters: ((value: unknown) => void)[] = [];

  push(message: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }
    this.pending.push(message);
  }

  next(timeoutMs: number): Promise<unknown> {
    const ready = this.pending.shift();
    if (ready !== undefined) {
      return Promise.resolve(ready);
    }
    return new Promise((resolve, reject) => {
      const settle = (value: unknown) => {
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(settle);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new Error(`timed out after ${timeoutMs}ms waiting for a worker message`));
      }, timeoutMs);
      this.waiters.push(settle);
    });
  }

  get backlog(): unknown[] {
    return [...this.pending];
  }
}

export async function replayTranscript(
  endpoint: EngineEndpoint,
  transcript: Transcript,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const settleMs = options.settleMs ?? 25;
  const queue = new MessageQueue();
  const listener = (event: { data: unknown }) => queue.push(event.data);
  endpoint.addEventListener("message", listener);

  const mismatches: ReplayMismatch[] = [];
  const observed: unknown[] = [];

  try {
    for (const [index, step] of transcript.steps.entries()) {
      if (step.from === "host") {
        parseHostMessage(step.message);
        endpoint.postMessage(step.message);
        continue;
      }

      let actual: unknown;
      try {
        actual = await queue.next(timeoutMs);
      } catch (error) {
        mismatches.push({
          step: index,
          reason: error instanceof Error ? error.message : String(error),
        });
        break;
      }

      observed.push(actual);

      try {
        parseWorkerMessage(actual);
      } catch (error) {
        mismatches.push({
          step: index,
          reason: `worker message failed schema validation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        continue;
      }

      const failures = matchValue(step.message, actual);
      if (failures.length > 0) {
        mismatches.push({ step: index, reason: "worker message did not match", failures });
      }
    }

    await new Promise((resolve) => setTimeout(resolve, settleMs));
    const extra = queue.backlog;
    if (extra.length > 0) {
      mismatches.push({
        step: transcript.steps.length,
        reason: `worker sent ${extra.length} message(s) beyond the transcript: ${extra
          .map((message) => (message as { type?: string }).type ?? "unknown")
          .join(", ")}`,
      });
    }
  } finally {
    endpoint.removeEventListener("message", listener);
  }

  return { transcript: transcript.name, ok: mismatches.length === 0, mismatches, observed };
}
