export const MANIFEST_SCHEMA_VERSION = 1;

export interface ManifestEntry {
  size: number;
  usedAt: number;
}

export interface Manifest {
  schemaVersion: number;
  abiTag: string;
  entries: Record<string, ManifestEntry>;
}

export interface CacheFile {
  path: string;
  size: number;
}

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

export function planFlush(live: readonly CacheFile[], manifest: Manifest): FlushPlan {
  const seen = new Set<string>();
  const writes: string[] = [];
  for (const file of live) {
    seen.add(file.path);
    const stored = manifest.entries[file.path];
    if (stored === undefined || stored.size !== file.size) {
      writes.push(file.path);
    }
  }
  const deletes = Object.keys(manifest.entries).filter((path) => !seen.has(path));
  return { writes, deletes };
}

export function commitFlush(
  manifest: Manifest,
  live: readonly CacheFile[],
  plan: FlushPlan,
  now: number,
): Manifest {
  const sizes = new Map(live.map((file) => [file.path, file.size]));
  const entries: Record<string, ManifestEntry> = {};
  for (const [path, entry] of Object.entries(manifest.entries)) {
    if (!plan.deletes.includes(path)) {
      entries[path] = entry;
    }
  }
  for (const path of plan.writes) {
    entries[path] = { size: sizes.get(path) ?? 0, usedAt: now };
  }
  return { ...manifest, entries };
}

const ARCHIVE = /(^|\/)archive-v\d+\//;
const BUILT_WHEEL = /(^|\/)(built-wheels|sdists)-v\d+\//;

function evictionRank(path: string): number {
  if (ARCHIVE.test(path)) {
    return 0;
  }
  if (BUILT_WHEEL.test(path)) {
    return 2;
  }
  return 1;
}

export function planEviction(manifest: Manifest, budgetBytes: number): string[] {
  const entries = Object.entries(manifest.entries);
  let total = entries.reduce((sum, [, entry]) => sum + entry.size, 0);
  if (total <= budgetBytes) {
    return [];
  }

  const ordered = [...entries].sort(([leftPath, left], [rightPath, right]) => {
    const rank = evictionRank(leftPath) - evictionRank(rightPath);
    if (rank !== 0) {
      return rank;
    }
    if (left.usedAt !== right.usedAt) {
      return left.usedAt - right.usedAt;
    }
    return leftPath < rightPath ? -1 : 1;
  });

  const evicted: string[] = [];
  for (const [path, entry] of ordered) {
    if (total <= budgetBytes) {
      break;
    }
    evicted.push(path);
    total -= entry.size;
  }
  return evicted;
}
