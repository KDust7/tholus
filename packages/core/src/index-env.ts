import type { IndexOptions } from "@tholus/engine-protocol";

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
