export const ANY = "$any";

export interface MatchFailure {
  path: string;
  expected: unknown;
  actual: unknown;
}

function describe(value: unknown): string {
  if (value instanceof Uint8Array) {
    return `Uint8Array(${value.length})`;
  }
  return JSON.stringify(value) ?? String(value);
}

export function matchValue(expected: unknown, actual: unknown, path = "$"): MatchFailure[] {
  if (expected === ANY) {
    return [];
  }

  if (expected instanceof Uint8Array || actual instanceof Uint8Array) {
    if (!(expected instanceof Uint8Array) || !(actual instanceof Uint8Array)) {
      return [{ path, expected, actual }];
    }
    if (expected.length !== actual.length) {
      return [{ path, expected: describe(expected), actual: describe(actual) }];
    }
    for (let index = 0; index < expected.length; index += 1) {
      if (expected[index] !== actual[index]) {
        return [{ path: `${path}[${index}]`, expected: expected[index], actual: actual[index] }];
      }
    }
    return [];
  }

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return [{ path, expected, actual }];
    }
    if (expected.length !== actual.length) {
      return [{ path: `${path}.length`, expected: expected.length, actual: actual.length }];
    }
    return expected.flatMap((item, index) => matchValue(item, actual[index], `${path}[${index}]`));
  }

  const expectedIsObject = expected !== null && typeof expected === "object";
  const actualIsObject = actual !== null && typeof actual === "object";
  if (expectedIsObject || actualIsObject) {
    if (!expectedIsObject || !actualIsObject) {
      return [{ path, expected, actual }];
    }
    const expectedEntries = Object.entries(expected as Record<string, unknown>).filter(
      ([, value]) => value !== undefined,
    );
    const actualEntries = Object.entries(actual as Record<string, unknown>).filter(
      ([, value]) => value !== undefined,
    );
    const expectedKeys = new Set(expectedEntries.map(([key]) => key));
    const actualKeys = new Set(actualEntries.map(([key]) => key));

    const failures: MatchFailure[] = [];
    for (const key of actualKeys) {
      if (!expectedKeys.has(key)) {
        failures.push({
          path: `${path}.${key}`,
          expected: "<absent>",
          actual: (actual as Record<string, unknown>)[key],
        });
      }
    }
    for (const [key, value] of expectedEntries) {
      if (!actualKeys.has(key)) {
        failures.push({ path: `${path}.${key}`, expected: value, actual: "<absent>" });
        continue;
      }
      failures.push(
        ...matchValue(value, (actual as Record<string, unknown>)[key], `${path}.${key}`),
      );
    }
    return failures;
  }

  return expected === actual ? [] : [{ path, expected, actual }];
}
