import type { IndexOptions } from "@uv-wasm/engine-protocol";

export const UV_DEFAULT_INDEX = "UV_DEFAULT_INDEX";
export const UV_INDEX = "UV_INDEX";
export const UV_INDEX_STRATEGY = "UV_INDEX_STRATEGY";

export function indexEnv(index: IndexOptions): Record<string, string> {
  const extras = [
    ...(index.pyodideIndex === undefined ? [] : [index.pyodideIndex]),
    ...(index.extraIndexUrls ?? []),
  ];
  return {
    ...(index.indexUrl === undefined ? {} : { [UV_DEFAULT_INDEX]: index.indexUrl }),
    ...(extras.length === 0 ? {} : { [UV_INDEX]: extras.join(" ") }),
    ...(index.indexStrategy === undefined ? {} : { [UV_INDEX_STRATEGY]: index.indexStrategy }),
  };
}

export function applyIndexEnv(
  env: Record<string, string>,
  index: IndexOptions,
): Record<string, string> {
  const derived = indexEnv(index);
  const collisions = Object.keys(derived).filter((name) => name in env);
  if (collisions.length > 0) {
    throw new Error(
      `config.index and config.env both set ${collisions.join(", ")}; ` +
        "set one or the other, so it is clear which index uv resolves against",
    );
  }
  return { ...env, ...derived };
}
