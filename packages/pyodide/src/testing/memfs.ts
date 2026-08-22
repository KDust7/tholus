import type { PyodideFileSystem } from "../facts.js";

const FORMAT = 0o170000;
const DIRECTORY = 0o040000;
const REGULAR = 0o100000;
const LINK = 0o120000;

type Node =
  | { kind: "file"; bytes: Uint8Array }
  | { kind: "symlink"; target: string }
  | { kind: "directory" };

export class MemFs implements PyodideFileSystem {
  readonly nodes = new Map<string, Node>();

  private ensureParents(path: string): void {
    const parts = path.split("/");
    for (let index = 2; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join("/");
      if (directory !== "" && !this.nodes.has(directory)) {
        this.nodes.set(directory, { kind: "directory" });
      }
    }
  }

  writeFile(path: string, data: Uint8Array): void {
    this.ensureParents(path);
    this.nodes.set(path, { kind: "file", bytes: data });
  }

  mkdirTree(path: string): void {
    const parts = path.split("/");
    for (let index = 2; index <= parts.length; index += 1) {
      const directory = parts.slice(0, index).join("/");
      if (directory !== "" && !this.nodes.has(directory)) {
        this.nodes.set(directory, { kind: "directory" });
      }
    }
  }

  symlink(target: string, link: string): void {
    this.ensureParents(link);
    this.nodes.set(link, { kind: "symlink", target });
  }

  analyzePath(path: string): { exists: boolean } {
    return { exists: this.nodes.has(path) };
  }

  readFile(path: string, _options: { encoding: "binary" }): Uint8Array {
    const node = this.nodes.get(path);
    if (node?.kind !== "file") {
      throw new Error(`${path} is not a file`);
    }
    return node.bytes;
  }

  readdir(path: string): string[] {
    if (this.nodes.get(path)?.kind !== "directory") {
      throw new Error(`${path} is not a directory`);
    }
    const prefix = `${path}/`;
    const names = new Set<string>([".", ".."]);
    for (const known of this.nodes.keys()) {
      if (!known.startsWith(prefix)) {
        continue;
      }
      const head = known.slice(prefix.length).split("/")[0];
      if (head !== undefined && head !== "") {
        names.add(head);
      }
    }
    return [...names];
  }

  lstat(path: string): { mode: number } {
    const node = this.nodes.get(path);
    if (node === undefined) {
      throw new Error(`${path} was not found`);
    }
    const kinds = { directory: DIRECTORY, symlink: LINK, file: REGULAR };
    return { mode: kinds[node.kind] };
  }

  readlink(path: string): string {
    const node = this.nodes.get(path);
    if (node?.kind !== "symlink") {
      throw new Error(`${path} is not a symlink`);
    }
    return node.target;
  }

  unlink(path: string): void {
    if (!this.nodes.delete(path)) {
      throw new Error(`${path} was not found`);
    }
  }

  rmdir(path: string): void {
    if (this.readdir(path).some((name) => name !== "." && name !== "..")) {
      throw new Error(`${path} is not empty`);
    }
    this.nodes.delete(path);
  }

  isDir(mode: number): boolean {
    return (mode & FORMAT) === DIRECTORY;
  }

  isFile(mode: number): boolean {
    return (mode & FORMAT) === REGULAR;
  }

  isLink(mode: number): boolean {
    return (mode & FORMAT) === LINK;
  }

  paths(): string[] {
    return [...this.nodes.keys()].sort();
  }
}
