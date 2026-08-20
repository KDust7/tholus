import { z } from "zod";

export const errorCodeSchema = z.enum([
  "network",
  "resolution-conflict",
  "package-not-found",
  "hash-mismatch",
  "no-runtime-attached",
  "sdist-needs-runtime",
  "runtime-required",
  "build-failed",
  "unsupported",
  "invalid-config",
  "cancelled",
  "engine-crashed",
  "protocol-mismatch",
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const structuredErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  data: z.unknown().optional(),
});

export type StructuredErrorInfo = z.infer<typeof structuredErrorSchema>;
