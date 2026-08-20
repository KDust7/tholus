import type { EngineConfig } from "@uv-wasm/engine-protocol";
import { indexEnv } from "./index-env.js";

export const UV_NO_CACHE = "UV_NO_CACHE";
export const RUST_LOG = "RUST_LOG";

function unsupported(what: string, why: string): Error {
  return new Error(`config.${what} is not supported yet: ${why}`);
}

function storageEnv(config: EngineConfig): Record<string, string> {
  if (config.fs.kind !== "memory") {
    throw unsupported(
      `fs.kind "${config.fs.kind}"`,
      "the engine only has the in-memory filesystem; OPFS and a delegated backend are phase 4",
    );
  }
  switch (config.cache.kind) {
    case "memory":
      return {};
    case "none":
      return { [UV_NO_CACHE]: "1" };
    default:
      throw unsupported(
        `cache.kind "${config.cache.kind}"`,
        'the OPFS cold store is phase 4; use "memory" or "none"',
      );
  }
}

export function derivedEnv(config: EngineConfig): Record<string, string> {
  return {
    ...indexEnv(config.index),
    ...storageEnv(config),
    ...(config.logFilter === undefined ? {} : { [RUST_LOG]: config.logFilter }),
  };
}

export function resolveEnvironment(config: EngineConfig): Record<string, string> {
  const derived = derivedEnv(config);
  const collisions = Object.keys(derived).filter((name) => name in config.env);
  if (collisions.length > 0) {
    throw new Error(
      `config and config.env both set ${collisions.join(", ")}; ` +
        "set one or the other, so it is clear which the engine obeys",
    );
  }
  return { ...config.env, ...derived };
}
