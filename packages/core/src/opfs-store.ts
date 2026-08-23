import { STORAGE_SCOPE } from "./brand.js";

export const STORE_ROOT = STORAGE_SCOPE;
export const STORE_VERSION = "v1";
export const CACHE_DIRECTORY = "cache";
export const MANIFEST_FILE = "manifest.json";

export interface ColdStore {
  readManifest(): Promise<string | undefined>;
  writeManifest(raw: string): Promise<void>;
  read(path: string): Promise<Uint8Array | undefined>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && error.name === "NotFoundError";
}

async function descend(
  from: FileSystemDirectoryHandle,
  segments: readonly string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle | undefined> {
  let at = from;
  for (const segment of segments) {
    try {
      at = await at.getDirectoryHandle(segment, { create });
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
  }
  return at;
}

async function fileAt(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<{ directory: FileSystemDirectoryHandle; name: string } | undefined> {
  const segments = path.split("/").filter((segment) => segment !== "");
  const name = segments.pop();
  if (name === undefined) {
    return undefined;
  }
  const directory = await descend(root, segments, create);
  return directory === undefined ? undefined : { directory, name };
}

async function readFile(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<Uint8Array | undefined> {
  const found = await fileAt(root, path, false);
  if (found === undefined) {
    return undefined;
  }
  let handle: FileSystemFileHandle;
  try {
    handle = await found.directory.getFileHandle(found.name);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
  const access = await handle.createSyncAccessHandle();
  try {
    const bytes = new Uint8Array(access.getSize());
    access.read(bytes, { at: 0 });
    return bytes;
  } finally {
    access.close();
  }
}

async function writeFile(
  root: FileSystemDirectoryHandle,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const found = await fileAt(root, path, true);
  if (found === undefined) {
    throw new Error(`${path} does not name a file in the cold store`);
  }
  const handle = await found.directory.getFileHandle(found.name, { create: true });
  const access = await handle.createSyncAccessHandle();
  try {
    access.truncate(0);
    access.write(bytes, { at: 0 });
    access.flush();
  } finally {
    access.close();
  }
}

async function removeFile(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  const found = await fileAt(root, path, false);
  if (found === undefined) {
    return;
  }
  try {
    await found.directory.removeEntry(found.name);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

export async function openColdStore(
  origin: FileSystemDirectoryHandle,
  scope: string = STORE_VERSION,
): Promise<ColdStore> {
  const owned = await origin.getDirectoryHandle(STORE_ROOT, { create: true });
  const version = await owned.getDirectoryHandle(scope, { create: true });
  const cache = await version.getDirectoryHandle(CACHE_DIRECTORY, { create: true });

  return {
    readManifest: () => readFile(version, MANIFEST_FILE).then(decodeText),
    writeManifest: (raw) => writeFile(version, MANIFEST_FILE, new TextEncoder().encode(raw)),
    read: (path) => readFile(cache, path),
    write: (path, bytes) => writeFile(cache, path, bytes),
    remove: (path) => removeFile(cache, path),
  };
}

function decodeText(bytes: Uint8Array | undefined): string | undefined {
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}
