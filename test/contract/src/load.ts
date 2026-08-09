import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hydrate, type Transcript, transcriptSchema } from "./schema.js";

export const transcriptDir = join(dirname(fileURLToPath(import.meta.url)), "..", "transcripts");

export function transcriptNames(): string[] {
  return readdirSync(transcriptDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

export function loadTranscript(name: string): Transcript {
  const raw = JSON.parse(readFileSync(join(transcriptDir, `${name}.json`), "utf8"));
  const parsed = transcriptSchema.parse(raw);
  return {
    ...parsed,
    steps: parsed.steps.map((step) => ({
      from: step.from,
      message: hydrate(step.message) as Record<string, unknown>,
    })),
  };
}

export function loadAllTranscripts(): Transcript[] {
  return transcriptNames().map(loadTranscript);
}
