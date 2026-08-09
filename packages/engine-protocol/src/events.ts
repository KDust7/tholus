import { z } from "zod";

export const packageRefSchema = z.object({
  name: z.string(),
  version: z.string(),
});

export type PackageRef = z.infer<typeof packageRefSchema>;

export const logLevelSchema = z.enum(["trace", "debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const enginePhaseSchema = z.enum([
  "resolving",
  "downloading",
  "building",
  "installing",
  "uninstalling",
  "auditing",
]);
export type EnginePhase = z.infer<typeof enginePhaseSchema>;

export const spanStateSchema = z.enum(["start", "end"]);

export const progressKindSchema = z.enum(["download", "build", "install", "checkout"]);
export const progressUnitSchema = z.enum(["bytes", "items"]);

export const engineEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("log"),
    invocationId: z.string().optional(),
    level: logLevelSchema,
    message: z.string(),
    target: z.string().optional(),
  }),
  z.object({
    type: z.literal("phase"),
    invocationId: z.string(),
    phase: enginePhaseSchema,
    state: spanStateSchema,
  }),
  z.object({
    type: z.literal("progress"),
    invocationId: z.string(),
    progressId: z.string(),
    kind: progressKindSchema,
    subject: z.string().optional(),
    current: z.number().nonnegative(),
    total: z.number().nonnegative().optional(),
    unit: progressUnitSchema,
  }),
  z.object({
    type: z.literal("request"),
    invocationId: z.string().optional(),
    method: z.string(),
    url: z.string(),
    status: z.number().int().optional(),
    fromCache: z.boolean(),
    bytes: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("resolution-complete"),
    invocationId: z.string(),
    packageCount: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("install-report"),
    invocationId: z.string(),
    installed: z.array(packageRefSchema),
    removed: z.array(packageRefSchema),
    unchanged: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("runtime-finalize"),
    invocationId: z.string(),
    package: packageRefSchema,
    action: z.enum(["dynlibs", "build"]),
    state: spanStateSchema,
  }),
]);

export type EngineEvent = z.infer<typeof engineEventSchema>;
