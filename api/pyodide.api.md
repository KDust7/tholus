# @tholus/pyodide

30 public exports.

```ts
export declare class AbiMismatch extends Error {
    readonly offenders: string[];
    constructor(expected: string, offenders: string[]);
}

export declare function attachPyodide(engine: TreeSource, pyodide: PyodideLike): PyodideRuntime;

export declare function callOf(request: HookRequest, sitePackages: readonly string[]): string;

export declare function checkAbi(entries: readonly TreeEntry[], facts: PyodideFacts): void;

export declare function collectWrite(tree: HookTree, seen: readonly Seen[]): HookWrite;

export declare class DynlibApiUnavailable extends Error {
    constructor(version: string);
}

export interface HookInvocation {
    script: string;
    cwd: string;
    env: Record<string, string>;
    sitePackages: string[];
    trees: HookTree[];
}

export interface HookOutcome {
    stdout: string[];
    stderr: string[];
    code: number;
    writes: HookWrite[];
}

export interface HookRequest {
    script: string;
    cwd: string;
    env: Record<string, string>;
}

export interface HookResult {
    stdout: string[];
    stderr: string[];
    code: number;
}

MOUNT_ROOT = "/uv_envs"

export interface MountedEnv extends WrittenTree {
    path: string;
    from: string;
}

export interface MountOptions {
    name?: string;
    loadDynlibs?: true;
}

export declare function parentOf(path: string): string | undefined;

export declare function parseResult(raw: string): HookResult;

export declare function probePyodide(pyodide: PyodideLike): PyodideFacts;

export interface PyodideFacts {
    pyodideVersion: string;
    pythonVersion: string;
    extensionSuffix: string;
    platform: string;
    sitePackages: string;
}

export interface PyodideFileSystem {
    writeFile(path: string, data: Uint8Array, options?: {
        encoding?: string;
    }): void;
    mkdirTree(path: string): void;
    symlink(target: string, link: string): void;
    analyzePath(path: string): {
        exists: boolean;
    };
    readFile(path: string, options: {
        encoding: "binary";
    }): Uint8Array;
    readdir(path: string): string[];
    lstat(path: string): {
        mode: number;
    };
    readlink(path: string): string;
    unlink(path: string): void;
    rmdir(path: string): void;
    isDir(mode: number): boolean;
    isFile(mode: number): boolean;
    isLink(mode: number): boolean;
}

export interface PyodideLike {
    version: string;
    FS: PyodideFileSystem;
    runPython(code: string): unknown;
    _api?: {
        loadDynlib?: (path: string, global?: boolean) => Promise<void>;
    };
}

export declare class PyodideProbeFailed extends Error {
    constructor(cause: unknown);
}

export interface PyodideRuntime {
    facts: PyodideFacts;
    mount(sitePackages: string, options?: MountOptions): Promise<MountedEnv>;
    hook(invocation: HookInvocation): Promise<HookOutcome>;
}

export declare function removeMirror(fs: PyodideFileSystem, root: string): void;

export declare function runBuildHook(pyodide: PyodideLike, invocation: HookInvocation): HookOutcome;

export declare function runHook(pyodide: PyodideLike, request: HookRequest, sitePackages: readonly string[]): HookResult;

RUNNER = "\nimport contextlib, io, json, os, sys, traceback\n\ndef _uvwasm_run_hook(payload):\n    request = json.loads(payload)\n    out, err = io.StringIO(), io.StringIO()\n    saved_path = list(sys.path)\n    saved_cwd = os.getcwd()\n    saved_env = dict(os.environ)\n    code = 0\n    try:\n        os.environ.update(request[\"env\"])\n        sys.path[:0] = [entry for entry in request[\"sitePackages\"] if entry not in sys.path]\n        os.chdir(request[\"cwd\"])\n        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):\n            exec(compile(request[\"script\"], \"<pep517>\", \"exec\"), {\"__name__\": \"__main__\"})\n    except SystemExit as leaving:\n        if leaving.code is None:\n            code = 0\n        elif isinstance(leaving.code, int):\n            code = leaving.code\n        else:\n            print(leaving.code, file=err)\n            code = 1\n    except BaseException:\n        traceback.print_exc(file=err)\n        code = 1\n    finally:\n        try:\n            os.chdir(saved_cwd)\n        except OSError:\n            pass\n        sys.path[:] = saved_path\n        os.environ.clear()\n        os.environ.update(saved_env)\n    return json.dumps({\n        \"stdout\": out.getvalue().splitlines(),\n        \"stderr\": err.getvalue().splitlines(),\n        \"code\": code,\n    })\n"

export interface Seen {
    path: string;
    node: Node;
}

export interface TreeSource {
    exportTree(path: string): Promise<ExportedTree>;
}

export declare function walkMirror(fs: PyodideFileSystem, root: string): Seen[];

export declare function writeTree(fs: PyodideFileSystem, root: string, entries: readonly TreeEntry[], bytes: Uint8Array): WrittenTree;

export interface WrittenTree {
    files: number;
    links: number;
    bytes: number;
    dynlibs: string[];
}
```
