import { type CacheVfs, type HydrateVfs, hydrateCacheTree, readCacheTree } from "./cache-tree.js";
import {
  type CacheEntry,
  commitFlush,
  loadManifest,
  type Manifest,
  planEviction,
  planFlush,
} from "./cold-store.js";
import type { ColdStore } from "./opfs-store.js";

export const CACHE_LOCK = "uv-wasm-cache";

export type LockRunner = <T>(name: string, run: () => Promise<T>) => Promise<T>;

export type PersistenceVfs = CacheVfs & HydrateVfs & { fsRead(path: string): Uint8Array };

export const QUOTA_SHARE = 0.5;
export const QUOTA_HIGH_WATER = 0.9;

export interface StorageRoom {
  quota: number;
  usage: number;
}

export interface PersistenceOptions {
  store: ColdStore;
  vfs: PersistenceVfs;
  root: string;
  abiTag: string;
  lock: LockRunner;
  now?: () => number;
  budgetBytes?: number;
  quota?: () => Promise<StorageRoom | undefined>;
}

export interface FlushReport {
  written: string[];
  removed: string[];
  failed: string[];
  quotaExceeded: boolean;
  nearQuota: boolean;
}

export const originQuota = async (): Promise<StorageRoom | undefined> => {
  const estimate = await navigator.storage.estimate();
  return estimate.quota === undefined || estimate.usage === undefined
    ? undefined
    : { quota: estimate.quota, usage: estimate.usage };
};

function isOutOfRoom(error: unknown): boolean {
  return error instanceof Error && error.name === "QuotaExceededError";
}

export interface HydrateReport {
  hydrated: string[];
  missing: string[];
  evicted: string[];
  orphaned: string[];
}

export interface Persistence {
  hydrate(): Promise<HydrateReport>;
  flush(): Promise<FlushReport>;
}

export const webLocks: LockRunner = (name, run) => navigator.locks.request(name, run);

function manifestEntries(manifest: Manifest): CacheEntry[] {
  return Object.entries(manifest.entries).map(([path, entry]) =>
    entry.kind === "file"
      ? { kind: "file", path, size: entry.size }
      : { kind: "symlink", path, target: entry.target },
  );
}

function without(manifest: Manifest, paths: readonly string[]): Manifest {
  const dropped = new Set(paths);
  const entries = Object.fromEntries(
    Object.entries(manifest.entries).filter(([path]) => !dropped.has(path)),
  );
  return { ...manifest, entries };
}

export function createPersistence(options: PersistenceOptions): Persistence {
  const { store, vfs, root, abiTag, lock } = options;
  const now = options.now ?? (() => Date.now());

  const read = async (): Promise<Manifest> => loadManifest(await store.readManifest(), abiTag);

  const room = async (): Promise<StorageRoom | undefined> => options.quota?.();

  const budgetFrom = (available: StorageRoom | undefined): number | undefined =>
    options.budgetBytes ?? (available && Math.floor(available.quota * QUOTA_SHARE));

  return {
    hydrate: () =>
      lock(CACHE_LOCK, async () => {
        const stored = await read();
        const budget = budgetFrom(options.budgetBytes === undefined ? await room() : undefined);
        const evicted = budget === undefined ? [] : planEviction(stored, budget);
        const manifest = without(stored, evicted);

        const orphaned: string[] = [];
        if (evicted.length > 0) {
          await store.writeManifest(JSON.stringify(manifest));
          for (const path of evicted) {
            try {
              await store.remove(path);
            } catch {
              orphaned.push(path);
            }
          }
        }

        const entries = manifestEntries(manifest);
        const missing = await hydrateCacheTree(vfs, root, entries, (path) => store.read(path));
        const lost = new Set(missing);
        return {
          hydrated: entries.map((entry) => entry.path).filter((path) => !lost.has(path)),
          missing,
          evicted,
          orphaned,
        };
      }),

    flush: () =>
      lock(CACHE_LOCK, async () => {
        const manifest = await read();
        const live = readCacheTree(vfs, root);
        const plan = planFlush(live, manifest);

        const written: string[] = [];
        const failed: string[] = [];
        let quotaExceeded = false;
        for (const path of plan.writes) {
          try {
            await store.write(path, vfs.fsRead(`${root}/${path}`));
            written.push(path);
          } catch (error) {
            quotaExceeded ||= isOutOfRoom(error);
            failed.push(path);
          }
        }

        const removed: string[] = [];
        for (const path of plan.deletes) {
          try {
            await store.remove(path);
            removed.push(path);
          } catch {
            failed.push(path);
          }
        }

        const committed = commitFlush(manifest, live, written, now());
        await store.writeManifest(JSON.stringify(committed));

        const available = await room();
        return {
          written,
          removed,
          failed,
          quotaExceeded,
          nearQuota:
            available !== undefined && available.usage >= available.quota * QUOTA_HIGH_WATER,
        };
      }),
  };
}
