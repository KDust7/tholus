import { describe, expect, it } from "vitest";

import { parseByteRange } from "./replay-server.js";

describe("byte ranges the replay server has to answer", () => {
  it("reads a closed range", () => {
    expect(parseByteRange("bytes=0-99", 500)).toEqual({ start: 0, end: 99 });
  });

  it("reads an open-ended range as the rest of the body", () => {
    expect(parseByteRange("bytes=400-", 500)).toEqual({ start: 400, end: 499 });
  });

  it("reads a suffix range as the tail, which is how a zip directory is fetched", () => {
    expect(parseByteRange("bytes=-64", 500)).toEqual({ start: 436, end: 499 });
  });

  it("clamps a range that runs past the end", () => {
    expect(parseByteRange("bytes=490-9999", 500)).toEqual({ start: 490, end: 499 });
  });

  it("takes the whole body when the suffix is longer than it", () => {
    expect(parseByteRange("bytes=-9999", 500)).toEqual({ start: 0, end: 499 });
  });

  it("has no range to report when the header is absent", () => {
    expect(parseByteRange(undefined, 500)).toBeUndefined();
  });

  it("refuses a start past the end", () => {
    expect(parseByteRange("bytes=600-700", 500)).toBeUndefined();
  });

  it("refuses an inverted range", () => {
    expect(parseByteRange("bytes=300-100", 500)).toBeUndefined();
  });

  it("refuses a unit it does not speak", () => {
    expect(parseByteRange("items=0-10", 500)).toBeUndefined();
  });

  it("refuses a range with neither end", () => {
    expect(parseByteRange("bytes=-", 500)).toBeUndefined();
  });

  it("refuses a zero-length suffix", () => {
    expect(parseByteRange("bytes=-0", 500)).toBeUndefined();
  });
});
