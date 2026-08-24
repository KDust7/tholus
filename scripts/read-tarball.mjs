import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const BLOCK = 512;
const NAME_AT = 0;
const NAME_LENGTH = 100;
const SIZE_AT = 124;
const SIZE_LENGTH = 12;

function trimmed(raw) {
  const end = raw.indexOf("\0");
  return end === -1 ? raw : raw.slice(0, end);
}

export function entriesOf(archive) {
  const entries = new Map();
  for (let at = 0; at + BLOCK <= archive.length; ) {
    const name = trimmed(
      archive.subarray(at + NAME_AT, at + NAME_AT + NAME_LENGTH).toString("utf8"),
    );
    if (name === "") {
      break;
    }
    const octal = archive
      .subarray(at + SIZE_AT, at + SIZE_AT + SIZE_LENGTH)
      .toString("utf8")
      .replace(/[^0-7]/g, "");
    const size = Number.parseInt(octal === "" ? "0" : octal, 8);
    const body = at + BLOCK;
    entries.set(name, archive.subarray(body, body + size));
    at = body + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

export function entriesOfTarball(path) {
  return entriesOf(gunzipSync(readFileSync(path)));
}

export function manifestOf(path) {
  const entries = entriesOfTarball(path);
  const found =
    entries.get("package/package.json") ??
    [...entries].find(([name]) => name.endsWith("/package.json"))?.[1];
  if (found === undefined) {
    throw new Error("the tarball carries no package.json");
  }
  return JSON.parse(found.toString("utf8"));
}
