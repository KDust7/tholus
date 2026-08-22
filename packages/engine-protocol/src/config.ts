import { z } from "zod";

export const fsBackendSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("memory") }),
  z.object({ kind: z.literal("opfs"), root: z.string().optional() }),
  z.object({ kind: z.literal("delegate") }),
]);
export type FsBackendSpec = z.infer<typeof fsBackendSpecSchema>;

export const cacheSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("opfs"),
    scope: z.string().optional(),
    abiTag: z.string().optional(),
    budgetBytes: z.number().int().positive().optional(),
  }),
  z.object({ kind: z.literal("memory") }),
  z.object({ kind: z.literal("none") }),
]);
export type CacheSpec = z.infer<typeof cacheSpecSchema>;

export const indexStrategySchema = z.enum([
  "first-index",
  "unsafe-first-match",
  "unsafe-best-match",
]);

export const indexOptionsSchema = z.object({
  indexUrl: z.string().optional(),
  extraIndexUrls: z.array(z.string()).optional(),
  indexStrategy: indexStrategySchema.optional(),
  pyodideIndex: z.url().optional(),
});
export type IndexOptions = z.infer<typeof indexOptionsSchema>;

export const transportSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("platform") }),
  z.object({ kind: z.literal("fetch"), rewriteHead: z.boolean().optional() }),
  z.object({
    kind: z.literal("libcurl"),
    moduleUrl: z.string(),
    wasmUrl: z.string().optional(),
    relayUrl: z.string(),
    userAgent: z.string().optional(),
    maxConnections: z.number().int().positive().optional(),
    connectionCache: z.number().int().positive().optional(),
    connectionsPerHost: z.number().int().positive().optional(),
  }),
]);
export type TransportSpec = z.infer<typeof transportSpecSchema>;

export const engineConfigSchema = z.object({
  fs: fsBackendSpecSchema.default({ kind: "memory" }),
  cache: cacheSpecSchema.default({ kind: "memory" }),
  transport: transportSpecSchema.default({ kind: "platform" }),
  index: indexOptionsSchema.default({}),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().default("/work"),
  logFilter: z.string().optional(),
});
export type EngineConfig = z.infer<typeof engineConfigSchema>;

export const buildIdentitySchema = z.object({
  engine: z.string(),
  uv: z.string(),
  protocol: z.string(),
});
export type BuildIdentity = z.infer<typeof buildIdentitySchema>;
