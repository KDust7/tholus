import { z } from "zod";
import { buildIdentitySchema, engineConfigSchema } from "./config.js";
import { structuredErrorSchema } from "./errors.js";
import { engineEventSchema } from "./events.js";

export const binarySchema = z.custom<Uint8Array>((value) => value instanceof Uint8Array, {
  message: "expected a Uint8Array",
});

export const ttySizeSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type TtySize = z.infer<typeof ttySizeSchema>;

export const ttyConfigSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  colors: z.enum(["truecolor", "256", "16"]).optional(),
});
export type TtyConfig = z.infer<typeof ttyConfigSchema>;

export const promptPolicySchema = z.union([
  z.enum(["confirm", "deny", "error"]),
  z.object({ answers: z.record(z.string(), z.string()) }),
]);
export type PromptPolicy = z.infer<typeof promptPolicySchema>;

export const streamNameSchema = z.enum(["stdout", "stderr"]);
export type StreamName = z.infer<typeof streamNameSchema>;

export const initMessageSchema = z.object({
  type: z.literal("init"),
  id: z.string(),
  protocolVersion: z.string(),
  config: engineConfigSchema,
});

export const execMessageSchema = z.object({
  type: z.literal("exec"),
  invocationId: z.string(),
  argv: z.array(z.string()),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  tty: ttyConfigSchema.optional(),
  stdin: z.boolean().default(false),
  promptPolicy: promptPolicySchema.optional(),
});

export const stdinResponseMessageSchema = z.object({
  type: z.literal("stdinResponse"),
  id: z.string(),
  data: z.string().nullable(),
});

export const resizeMessageSchema = z.object({
  type: z.literal("resize"),
  invocationId: z.string(),
  size: ttySizeSchema,
});

export const cancelMessageSchema = z.object({
  type: z.literal("cancel"),
  invocationId: z.string(),
  reason: z.string().optional(),
});

export const ackMessageSchema = z.object({
  type: z.literal("ack"),
  invocationId: z.string(),
  stream: streamNameSchema,
  bytes: z.number().int().nonnegative(),
});

export const disposeMessageSchema = z.object({
  type: z.literal("dispose"),
});

export const hostMessageSchema = z.discriminatedUnion("type", [
  initMessageSchema,
  execMessageSchema,
  stdinResponseMessageSchema,
  resizeMessageSchema,
  cancelMessageSchema,
  ackMessageSchema,
  disposeMessageSchema,
]);
export type HostMessage = z.infer<typeof hostMessageSchema>;

export const initResultMessageSchema = z.object({
  type: z.literal("initResult"),
  id: z.string(),
  outcome: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), build: buildIdentitySchema }),
    z.object({ ok: z.literal(false), error: structuredErrorSchema }),
  ]),
});

export const bootProgressMessageSchema = z.object({
  type: z.literal("bootProgress"),
  phase: z.enum(["compile-start", "compile-done", "init-start", "ready"]),
  ms: z.number().nonnegative().optional(),
});

export const outputMessageSchema = z.object({
  type: z.literal("output"),
  invocationId: z.string(),
  stream: streamNameSchema,
  seq: z.number().int().nonnegative(),
  data: binarySchema,
});

export const eventMessageSchema = z.object({
  type: z.literal("event"),
  event: engineEventSchema,
});

export const stdinRequestMessageSchema = z.object({
  type: z.literal("stdinRequest"),
  id: z.string(),
  invocationId: z.string(),
  prompt: z.string().optional(),
  echo: z.boolean(),
});

export const exitMessageSchema = z.object({
  type: z.literal("exit"),
  invocationId: z.string(),
  code: z.number().int(),
  cancelled: z.boolean(),
  durationMs: z.number().nonnegative(),
  error: structuredErrorSchema.optional(),
});

export const fatalMessageSchema = z.object({
  type: z.literal("fatal"),
  message: z.string(),
  stack: z.string().optional(),
});

export const workerMessageSchema = z.discriminatedUnion("type", [
  initResultMessageSchema,
  bootProgressMessageSchema,
  outputMessageSchema,
  eventMessageSchema,
  stdinRequestMessageSchema,
  exitMessageSchema,
  fatalMessageSchema,
]);
export type WorkerMessage = z.infer<typeof workerMessageSchema>;

export type InitMessage = z.infer<typeof initMessageSchema>;
export type ExecMessage = z.infer<typeof execMessageSchema>;
export type StdinResponseMessage = z.infer<typeof stdinResponseMessageSchema>;
export type ResizeMessage = z.infer<typeof resizeMessageSchema>;
export type CancelMessage = z.infer<typeof cancelMessageSchema>;
export type AckMessage = z.infer<typeof ackMessageSchema>;
export type DisposeMessage = z.infer<typeof disposeMessageSchema>;
export type InitResultMessage = z.infer<typeof initResultMessageSchema>;
export type BootProgressMessage = z.infer<typeof bootProgressMessageSchema>;
export type OutputMessage = z.infer<typeof outputMessageSchema>;
export type EventMessage = z.infer<typeof eventMessageSchema>;
export type StdinRequestMessage = z.infer<typeof stdinRequestMessageSchema>;
export type ExitMessage = z.infer<typeof exitMessageSchema>;
export type FatalMessage = z.infer<typeof fatalMessageSchema>;

export const HOST_MESSAGE_TYPES = [
  "init",
  "exec",
  "stdinResponse",
  "resize",
  "cancel",
  "ack",
  "dispose",
] as const;

export const WORKER_MESSAGE_TYPES = [
  "initResult",
  "bootProgress",
  "output",
  "event",
  "stdinRequest",
  "exit",
  "fatal",
] as const;

export const EXIT_CODE_CANCELLED = 130;
export const EXIT_CODE_USAGE = 2;
