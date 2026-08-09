import { z } from "zod";

export const encodedBinarySchema = z.union([
  z.object({ $text: z.string() }),
  z.object({ $bytes: z.array(z.number().int().min(0).max(255)) }),
]);

export type EncodedBinary = z.infer<typeof encodedBinarySchema>;

export const transcriptStepSchema = z.object({
  from: z.enum(["host", "worker"]),
  message: z.record(z.string(), z.unknown()),
});

export type TranscriptStep = z.infer<typeof transcriptStepSchema>;

export const transcriptSchema = z.object({
  name: z.string(),
  summary: z.string(),
  protocolVersion: z.string(),
  steps: z.array(transcriptStepSchema).min(1),
});

export type Transcript = z.infer<typeof transcriptSchema>;

const textEncoder = new TextEncoder();

export function isEncodedBinary(value: unknown): value is EncodedBinary {
  return encodedBinarySchema.safeParse(value).success;
}

export function decodeBinary(value: EncodedBinary): Uint8Array {
  if ("$text" in value) {
    return textEncoder.encode(value.$text);
  }
  return Uint8Array.from(value.$bytes);
}

export function hydrate(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(hydrate);
  }
  if (value !== null && typeof value === "object") {
    if (isEncodedBinary(value)) {
      return decodeBinary(value as EncodedBinary);
    }
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = hydrate(inner);
    }
    return out;
  }
  return value;
}
