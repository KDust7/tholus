export const MANIFEST_SCHEMA_VERSION = 2;

export type ManifestEntry =
  | { kind: "file"; size: number; usedAt: number }
  | { kind: "symlink"; target: string; usedAt: number };

export interface Manifest {
  schemaVersion: number;
  abiTag: string;
  entries: Record<string, ManifestEntry>;
}

export type CacheEntry =
  | { kind: "file"; path: string; size: number }
  | { kind: "symlink"; path: string; target: string };

export interface FlushPlan {
  writes: string[];
  deletes: string[];
}

export function emptyManifest(abiTag: string): Manifest {
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, abiTag, entries: {} };
}

export function isReusable(manifest: Manifest, abiTag: string): boolean {
  return manifest.schemaVersion === MANIFEST_SCHEMA_VERSION && manifest.abiTag === abiTag;
}

export function loadManifest(raw: string | undefined, abiTag: string): Manifest {
  if (raw === undefined) {
    return emptyManifest(abiTag);
  }
  let parsed: Manifest;
  try {
    parsed = JSON.parse(raw) as Manifest;
  } catch {
    return emptyManifest(abiTag);
  }
  if (!isReusable(parsed, abiTag) || typeof parsed.entries !== "object") {
    return emptyManifest(abiTag);
  }
  return parsed;
}

const ARCHIVE = /^(archive-v\d+\/[^/]+)(?:\/|$)/;
const SOURCE_TREE = /^(sdists-v\d+\/.+?\/src)(?:\/|$)/;

export function cacheUnit(path: string): string {
  return ARCHIVE.exec(path)?.[1] ?? SOURCE_TREE.exec(path)?.[1] ?? path;
}

export function groupByUnit<T>(
  entries: readonly T[],
  pathOf: (entry: T) => string,
): Map<string, T[]> {
  const units = new Map<string, T[]>();
  for (const entry of entries) {
    const key = cacheUnit(pathOf(entry));
    const members = units.get(key);
    if (members === undefined) {
      units.set(key, [entry]);
    } else {
      members.push(entry);
    }
  }
  return units;
}

function isStale(entry: ManifestEntry | undefined, live: CacheEntry): boolean {
  if (entry === undefined || entry.kind !== live.kind) {
    return true;
  }
  return entry.kind === "file" && live.kind === "file"
    ? entry.size !== live.size
    : entry.kind === "symlink" && live.kind === "symlink" && entry.target !== live.target;
}

export function planFlush(live: readonly CacheEntry[], manifest: Manifest): FlushPlan {
  const files = new Set<string>();
  const writes: string[] = [];
  for (const entry of live) {
    if (entry.kind === "file") {
      files.add(entry.path);
    }
    if (entry.kind === "file" && isStale(manifest.entries[entry.path], entry)) {
      writes.push(entry.path);
    }
  }
  const deletes = Object.entries(manifest.entries)
    .filter(([path, entry]) => entry.kind === "file" && !files.has(path))
    .map(([path]) => path);
  return { writes, deletes };
}

function whole(
  entries: Record<string, ManifestEntry>,
  live: readonly CacheEntry[],
): Record<string, ManifestEntry> {
  const broken = new Set<string>();
  for (const entry of live) {
    if (entries[entry.path] === undefined) {
      broken.add(cacheUnit(entry.path));
    }
  }
  return broken.size === 0
    ? entries
    : Object.fromEntries(Object.entries(entries).filter(([path]) => !broken.has(cacheUnit(path))));
}

export function commitFlush(
  manifest: Manifest,
  live: readonly CacheEntry[],
  written: readonly string[],
  now: number,
): Manifest {
  const landed = new Set(written);
  const entries: Record<string, ManifestEntry> = {};
  for (const entry of live) {
    const stored = manifest.entries[entry.path];
    if (!isStale(stored, entry)) {
      entries[entry.path] = stored as ManifestEntry;
      continue;
    }
    if (entry.kind === "file" && !landed.has(entry.path)) {
      continue;
    }
    entries[entry.path] =
      entry.kind === "file"
        ? { kind: "file", size: entry.size, usedAt: now }
        : { kind: "symlink", target: entry.target, usedAt: now };
  }
  return { ...manifest, entries: whole(entries, live) };
}

const ARCHIVE_BUCKET = /(^|\/)archive-v\d+\//;
const BUILT_WHEEL = /(^|\/)(built-wheels|sdists)-v\d+\//;

function evictionRank(path: string): number {
  if (ARCHIVE_BUCKET.test(path)) {
    return 0;
  }
  if (BUILT_WHEEL.test(path)) {
    return 2;
  }
  return 1;
}

export function planEviction(manifest: Manifest, budgetBytes: number): string[] {
  const files = Object.entries(manifest.entries).filter(
    (pair): pair is [string, Extract<ManifestEntry, { kind: "file" }>] => pair[1].kind === "file",
  );
  let total = files.reduce((sum, [, entry]) => sum + entry.size, 0);
  if (total <= budgetBytes) {
    return [];
  }

  const units = [...groupByUnit(files, ([path]) => path)].map(([unit, members]) => ({
    unit,
    paths: members.map(([path]) => path),
    size: members.reduce((sum, [, entry]) => sum + entry.size, 0),
    usedAt: members.reduce((newest, [, entry]) => Math.max(newest, entry.usedAt), 0),
  }));

  const ordered = [...units].sort((left, right) => {
    const rank = evictionRank(left.unit) - evictionRank(right.unit);
    if (rank !== 0) {
      return rank;
    }
    if (left.usedAt !== right.usedAt) {
      return left.usedAt - right.usedAt;
    }
    return left.unit < right.unit ? -1 : 1;
  });

  const evicted: string[] = [];
  for (const unit of ordered) {
    if (total <= budgetBytes) {
      break;
    }
    evicted.push(...unit.paths);
    total -= unit.size;
  }
  return evicted;
}
