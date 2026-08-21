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

export interface PersistenceOptions {
  store: ColdStore;
  vfs: PersistenceVfs;
  root: string;
  abiTag: string;
  lock: LockRunner;
  now?: () => number;
  budgetBytes?: number;
}

export interface FlushReport {
  written: string[];
  removed: string[];
  failed: string[];
  evicted: string[];
}

export interface HydrateReport {
  hydrated: string[];
  missing: string[];
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

  return {
    hydrate: () =>
      lock(CACHE_LOCK, async () => {
        const entries = manifestEntries(await read());
        const missing = await hydrateCacheTree(vfs, root, entries, (path) => store.read(path));
        const lost = new Set(missing);
        return {
          hydrated: entries.map((entry) => entry.path).filter((path) => !lost.has(path)),
          missing,
        };
      }),

    flush: () =>
      lock(CACHE_LOCK, async () => {
        const manifest = await read();
        const live = readCacheTree(vfs, root);
        const plan = planFlush(live, manifest);

        const written: string[] = [];
        const failed: string[] = [];
        for (const path of plan.writes) {
          try {
            await store.write(path, vfs.fsRead(`${root}/${path}`));
            written.push(path);
          } catch {
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
        const evicted =
          options.budgetBytes === undefined ? [] : planEviction(committed, options.budgetBytes);
        for (const path of evicted) {
          try {
            await store.remove(path);
          } catch {
            failed.push(path);
          }
        }

        await store.writeManifest(JSON.stringify(without(committed, evicted)));
        return { written, removed, failed, evicted };
      }),
  };
}
