# @tholus/engine-protocol

97 public exports.

```ts
export type AckMessage = z.infer<typeof ackMessageSchema>;

ackMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"ack">;
    invocationId: z.ZodString;
    stream: z.ZodEnum<{
        stdout: "stdout";
        stderr: "stderr";
    }>;
    bytes: z.ZodNumber;
}, z.core.$strip>

export declare function assertCompatibleProtocol(remoteVersion: string): void;

export type AttachRuntimeMessage = z.infer<typeof attachRuntimeMessageSchema>;

attachRuntimeMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"attachRuntime">;
}, z.core.$strip>

binarySchema: z.ZodCustom<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>

export type BootProgressMessage = z.infer<typeof bootProgressMessageSchema>;

bootProgressMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"bootProgress">;
    phase: z.ZodEnum<{
        "compile-start": "compile-start";
        "compile-done": "compile-done";
        "init-start": "init-start";
        ready: "ready";
    }>;
    ms: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>

export type BuildIdentity = z.infer<typeof buildIdentitySchema>;

buildIdentitySchema: z.ZodObject<{
    engine: z.ZodString;
    uv: z.ZodString;
    protocol: z.ZodString;
}, z.core.$strip>

export type CacheSpec = z.infer<typeof cacheSpecSchema>;

cacheSpecSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"opfs">;
    scope: z.ZodOptional<z.ZodString>;
    abiTag: z.ZodOptional<z.ZodString>;
    budgetBytes: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"memory">;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"none">;
}, z.core.$strip>], "kind">

export type CancelMessage = z.infer<typeof cancelMessageSchema>;

cancelMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"cancel">;
    invocationId: z.ZodString;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>

export type DetachRuntimeMessage = z.infer<typeof detachRuntimeMessageSchema>;

detachRuntimeMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"detachRuntime">;
}, z.core.$strip>

export type DisposeMessage = z.infer<typeof disposeMessageSchema>;

disposeMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"dispose">;
}, z.core.$strip>

export type EngineConfig = z.infer<typeof engineConfigSchema>;

engineConfigSchema: z.ZodObject<{
    fs: z.ZodDefault<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"memory">;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"opfs">;
        root: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"delegate">;
    }, z.core.$strip>], "kind">>;
    cache: z.ZodDefault<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"opfs">;
        scope: z.ZodOptional<z.ZodString>;
        abiTag: z.ZodOptional<z.ZodString>;
        budgetBytes: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"memory">;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"none">;
    }, z.core.$strip>], "kind">>;
    transport: z.ZodDefault<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"platform">;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"fetch">;
        rewriteHead: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"libcurl">;
        moduleUrl: z.ZodString;
        wasmUrl: z.ZodOptional<z.ZodString>;
        relayUrl: z.ZodString;
        userAgent: z.ZodOptional<z.ZodString>;
        maxConnections: z.ZodOptional<z.ZodNumber>;
        connectionCache: z.ZodOptional<z.ZodNumber>;
        connectionsPerHost: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>], "kind">>;
    index: z.ZodDefault<z.ZodObject<{
        indexUrl: z.ZodOptional<z.ZodString>;
        extraIndexUrls: z.ZodOptional<z.ZodArray<z.ZodString>>;
        indexStrategy: z.ZodOptional<z.ZodEnum<{
            "first-index": "first-index";
            "unsafe-first-match": "unsafe-first-match";
            "unsafe-best-match": "unsafe-best-match";
        }>>;
        pyodideIndex: z.ZodOptional<z.ZodURL>;
    }, z.core.$strip>>;
    env: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    cwd: z.ZodDefault<z.ZodString>;
    logFilter: z.ZodOptional<z.ZodString>;
}, z.core.$strip>

export type EngineEvent = z.infer<typeof engineEventSchema>;

engineEventSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"log">;
    invocationId: z.ZodOptional<z.ZodString>;
    level: z.ZodEnum<{
        error: "error";
        trace: "trace";
        debug: "debug";
        info: "info";
        warn: "warn";
    }>;
    message: z.ZodString;
    target: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"phase">;
    invocationId: z.ZodString;
    phase: z.ZodEnum<{
        resolving: "resolving";
        downloading: "downloading";
        building: "building";
        installing: "installing";
        uninstalling: "uninstalling";
        auditing: "auditing";
    }>;
    state: z.ZodEnum<{
        start: "start";
        end: "end";
    }>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"progress">;
    invocationId: z.ZodString;
    progressId: z.ZodString;
    kind: z.ZodEnum<{
        download: "download";
        build: "build";
        install: "install";
        checkout: "checkout";
    }>;
    subject: z.ZodOptional<z.ZodString>;
    current: z.ZodNumber;
    total: z.ZodOptional<z.ZodNumber>;
    unit: z.ZodEnum<{
        bytes: "bytes";
        items: "items";
    }>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"request">;
    invocationId: z.ZodOptional<z.ZodString>;
    method: z.ZodString;
    url: z.ZodString;
    status: z.ZodOptional<z.ZodNumber>;
    fromCache: z.ZodBoolean;
    bytes: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"resolution-complete">;
    invocationId: z.ZodString;
    packageCount: z.ZodNumber;
    durationMs: z.ZodNumber;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"install-report">;
    invocationId: z.ZodString;
    installed: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        version: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    removed: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        version: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    unchanged: z.ZodNumber;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"runtime-finalize">;
    invocationId: z.ZodString;
    package: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    action: z.ZodEnum<{
        build: "build";
        dynlibs: "dynlibs";
    }>;
    state: z.ZodEnum<{
        start: "start";
        end: "end";
    }>;
}, z.core.$strip>], "type">

export type EnginePhase = z.infer<typeof enginePhaseSchema>;

enginePhaseSchema: z.ZodEnum<{
    resolving: "resolving";
    downloading: "downloading";
    building: "building";
    installing: "installing";
    uninstalling: "uninstalling";
    auditing: "auditing";
}>

export type ErrorCode = z.infer<typeof errorCodeSchema>;

errorCodeSchema: z.ZodEnum<{
    network: "network";
    "resolution-conflict": "resolution-conflict";
    "package-not-found": "package-not-found";
    "hash-mismatch": "hash-mismatch";
    "no-runtime-attached": "no-runtime-attached";
    "sdist-needs-runtime": "sdist-needs-runtime";
    "runtime-required": "runtime-required";
    "build-failed": "build-failed";
    unsupported: "unsupported";
    "invalid-config": "invalid-config";
    cancelled: "cancelled";
    "engine-crashed": "engine-crashed";
    "protocol-mismatch": "protocol-mismatch";
}>

export type EventMessage = z.infer<typeof eventMessageSchema>;

eventMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"event">;
    event: z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"log">;
        invocationId: z.ZodOptional<z.ZodString>;
        level: z.ZodEnum<{
            error: "error";
            trace: "trace";
            debug: "debug";
            info: "info";
            warn: "warn";
        }>;
        message: z.ZodString;
        target: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"phase">;
        invocationId: z.ZodString;
        phase: z.ZodEnum<{
            resolving: "resolving";
            downloading: "downloading";
            building: "building";
            installing: "installing";
            uninstalling: "uninstalling";
            auditing: "auditing";
        }>;
        state: z.ZodEnum<{
            start: "start";
            end: "end";
        }>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"progress">;
        invocationId: z.ZodString;
        progressId: z.ZodString;
        kind: z.ZodEnum<{
            download: "download";
            build: "build";
            install: "install";
            checkout: "checkout";
        }>;
        subject: z.ZodOptional<z.ZodString>;
        current: z.ZodNumber;
        total: z.ZodOptional<z.ZodNumber>;
        unit: z.ZodEnum<{
            bytes: "bytes";
            items: "items";
        }>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"request">;
        invocationId: z.ZodOptional<z.ZodString>;
        method: z.ZodString;
        url: z.ZodString;
        status: z.ZodOptional<z.ZodNumber>;
        fromCache: z.ZodBoolean;
        bytes: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"resolution-complete">;
        invocationId: z.ZodString;
        packageCount: z.ZodNumber;
        durationMs: z.ZodNumber;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"install-report">;
        invocationId: z.ZodString;
        installed: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodOptional<z.ZodString>;
            source: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        removed: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodOptional<z.ZodString>;
            source: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        unchanged: z.ZodNumber;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"runtime-finalize">;
        invocationId: z.ZodString;
        package: z.ZodObject<{
            name: z.ZodString;
            version: z.ZodOptional<z.ZodString>;
            source: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        action: z.ZodEnum<{
            build: "build";
            dynlibs: "dynlibs";
        }>;
        state: z.ZodEnum<{
            start: "start";
            end: "end";
        }>;
    }, z.core.$strip>], "type">;
}, z.core.$strip>

export type ExecMessage = z.infer<typeof execMessageSchema>;

execMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"exec">;
    invocationId: z.ZodString;
    argv: z.ZodArray<z.ZodString>;
    cwd: z.ZodOptional<z.ZodString>;
    env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    tty: z.ZodOptional<z.ZodObject<{
        cols: z.ZodNumber;
        rows: z.ZodNumber;
        colors: z.ZodOptional<z.ZodEnum<{
            truecolor: "truecolor";
            256: "256";
            16: "16";
        }>>;
    }, z.core.$strip>>;
    stdin: z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>>;
    promptPolicy: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
        error: "error";
        confirm: "confirm";
        deny: "deny";
    }>, z.ZodObject<{
        answers: z.ZodRecord<z.ZodString, z.ZodString>;
    }, z.core.$strip>]>>;
}, z.core.$strip>

EXIT_CODE_CANCELLED = 130

EXIT_CODE_USAGE = 2

export type ExitMessage = z.infer<typeof exitMessageSchema>;

exitMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"exit">;
    invocationId: z.ZodString;
    code: z.ZodNumber;
    cancelled: z.ZodBoolean;
    durationMs: z.ZodNumber;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodEnum<{
            network: "network";
            "resolution-conflict": "resolution-conflict";
            "package-not-found": "package-not-found";
            "hash-mismatch": "hash-mismatch";
            "no-runtime-attached": "no-runtime-attached";
            "sdist-needs-runtime": "sdist-needs-runtime";
            "runtime-required": "runtime-required";
            "build-failed": "build-failed";
            unsupported: "unsupported";
            "invalid-config": "invalid-config";
            cancelled: "cancelled";
            "engine-crashed": "engine-crashed";
            "protocol-mismatch": "protocol-mismatch";
        }>;
        message: z.ZodString;
        data: z.ZodOptional<z.ZodUnknown>;
    }, z.core.$strip>>;
}, z.core.$strip>

export type ExportTreeMessage = z.infer<typeof exportTreeMessageSchema>;

exportTreeMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"exportTree">;
    id: z.ZodString;
    path: z.ZodString;
}, z.core.$strip>

export type ExportTreeResultMessage = z.infer<typeof exportTreeResultMessageSchema>;

exportTreeResultMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"exportTreeResult">;
    id: z.ZodString;
    outcome: z.ZodDiscriminatedUnion<[z.ZodObject<{
        ok: z.ZodLiteral<true>;
        entries: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"file">;
            path: z.ZodString;
            offset: z.ZodNumber;
            length: z.ZodNumber;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"symlink">;
            path: z.ZodString;
            target: z.ZodString;
        }, z.core.$strip>], "kind">>;
        bytes: z.ZodCustom<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>;
    }, z.core.$strip>, z.ZodObject<{
        ok: z.ZodLiteral<false>;
        error: z.ZodObject<{
            code: z.ZodEnum<{
                network: "network";
                "resolution-conflict": "resolution-conflict";
                "package-not-found": "package-not-found";
                "hash-mismatch": "hash-mismatch";
                "no-runtime-attached": "no-runtime-attached";
                "sdist-needs-runtime": "sdist-needs-runtime";
                "runtime-required": "runtime-required";
                "build-failed": "build-failed";
                unsupported: "unsupported";
                "invalid-config": "invalid-config";
                cancelled: "cancelled";
                "engine-crashed": "engine-crashed";
                "protocol-mismatch": "protocol-mismatch";
            }>;
            message: z.ZodString;
            data: z.ZodOptional<z.ZodUnknown>;
        }, z.core.$strip>;
    }, z.core.$strip>], "ok">;
}, z.core.$strip>

export type FatalMessage = z.infer<typeof fatalMessageSchema>;

fatalMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"fatal">;
    message: z.ZodString;
    stack: z.ZodOptional<z.ZodString>;
}, z.core.$strip>

export type FsBackendSpec = z.infer<typeof fsBackendSpecSchema>;

fsBackendSpecSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"memory">;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"opfs">;
    root: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"delegate">;
}, z.core.$strip>], "kind">

export type HookRequestMessage = z.infer<typeof hookRequestMessageSchema>;

hookRequestMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"hookRequest">;
    id: z.ZodString;
    script: z.ZodString;
    cwd: z.ZodString;
    env: z.ZodRecord<z.ZodString, z.ZodString>;
    sitePackages: z.ZodArray<z.ZodString>;
    trees: z.ZodArray<z.ZodObject<{
        root: z.ZodString;
        collect: z.ZodEnum<{
            new: "new";
            changes: "changes";
        }>;
        entries: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"file">;
            path: z.ZodString;
            offset: z.ZodNumber;
            length: z.ZodNumber;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"symlink">;
            path: z.ZodString;
            target: z.ZodString;
        }, z.core.$strip>], "kind">>;
        bytes: z.ZodCustom<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>;
    }, z.core.$strip>>;
}, z.core.$strip>

export type HookResultMessage = z.infer<typeof hookResultMessageSchema>;

hookResultMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"hookResult">;
    id: z.ZodString;
    outcome: z.ZodDiscriminatedUnion<[z.ZodObject<{
        ok: z.ZodLiteral<true>;
        stdout: z.ZodArray<z.ZodString>;
        stderr: z.ZodArray<z.ZodString>;
        code: z.ZodNumber;
        writes: z.ZodArray<z.ZodObject<{
            root: z.ZodString;
            entries: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"file">;
                path: z.ZodString;
                offset: z.ZodNumber;
                length: z.ZodNumber;
            }, z.core.$strip>, z.ZodObject<{
                kind: z.ZodLiteral<"symlink">;
                path: z.ZodString;
                target: z.ZodString;
            }, z.core.$strip>], "kind">>;
            bytes: z.ZodCustom<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>;
            removed: z.ZodArray<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>, z.ZodObject<{
        ok: z.ZodLiteral<false>;
        error: z.ZodObject<{
            code: z.ZodEnum<{
                network: "network";
                "resolution-conflict": "resolution-conflict";
                "package-not-found": "package-not-found";
                "hash-mismatch": "hash-mismatch";
                "no-runtime-attached": "no-runtime-attached";
                "sdist-needs-runtime": "sdist-needs-runtime";
                "runtime-required": "runtime-required";
                "build-failed": "build-failed";
                unsupported: "unsupported";
                "invalid-config": "invalid-config";
                cancelled: "cancelled";
                "engine-crashed": "engine-crashed";
                "protocol-mismatch": "protocol-mismatch";
            }>;
            message: z.ZodString;
            data: z.ZodOptional<z.ZodUnknown>;
        }, z.core.$strip>;
    }, z.core.$strip>], "ok">;
}, z.core.$strip>

export type HookTree = z.infer<typeof hookTreeSchema>;

hookTreeSchema: z.ZodObject<{
    root: z.ZodString;
    collect: z.ZodEnum<{
        new: "new";
        changes: "changes";
    }>;
    entries: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"file">;
        path: z.ZodString;
        offset: z.ZodNumber;
        length: z.ZodNumber;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"symlink">;
        path: z.ZodString;
        target: z.ZodString;
    }, z.core.$strip>], "kind">>;
    bytes: z.ZodCustom<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>;
}, z.core.$strip>

export type HookWrite = z.infer<typeof hookWriteSchema>;

hookWriteSchema: z.ZodObject<{
    root: z.ZodString;
    entries: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"file">;
        path: z.ZodString;
        offset: z.ZodNumber;
        length: z.ZodNumber;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"symlink">;
        path: z.ZodString;
        target: z.ZodString;
    }, z.core.$strip>], "kind">>;
    bytes: z.ZodCustom<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>;
    removed: z.ZodArray<z.ZodString>;
}, z.core.$strip>

HOST_MESSAGE_TYPES: readonly ["init", "exec", "resize", "cancel", "ack", "dispose", "exportTree", "attachRuntime", "detachRuntime", "hookResult"]

export type HostMessage = z.infer<typeof hostMessageSchema>;

hostMessageSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"init">;
    id: z.ZodString;
    protocolVersion: z.ZodString;
    config: z.ZodObject<{
        fs: z.ZodDefault<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"memory">;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"opfs">;
            root: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"delegate">;
        }, z.core.$strip>], "kind">>;
        cache: z.ZodDefault<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"opfs">;
            scope: z.ZodOptional<z.ZodString>;
            abiTag: z.ZodOptional<z.ZodString>;
            budgetBytes: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"memory">;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"none">;
        }, z.core.$strip>], "kind">>;
        transport: z.ZodDefault<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"platform">;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"fetch">;
            rewriteHead: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"libcurl">;
            moduleUrl: z.ZodString;
            wasmUrl: z.ZodOptional<z.ZodString>;
            relayUrl: z.ZodString;
            userAgent: z.ZodOptional<z.ZodString>;
            maxConnections: z.ZodOptional<z.ZodNumber>;
            connectionCache: z.ZodOptional<z.ZodNumber>;
            connectionsPerHost: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>], "kind">>;
        index: z.ZodDefault<z.ZodObject<{
            indexUrl: z.ZodOptional<z.ZodString>;
            extraIndexUrls: z.ZodOptional<z.ZodArray<z.ZodString>>;
            indexStrategy: z.ZodOptional<z.ZodEnum<{
                "first-index": "first-index";
                "unsafe-first-match": "unsafe-first-match";
                "unsafe-best-match": "unsafe-best-match";
            }>>;
            pyodideIndex: z.ZodOptional<z.ZodURL>;
        }, z.core.$strip>>;
        env: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        cwd: z.ZodDefault<z.ZodString>;
        logFilter: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"exec">;
    invocationId: z.ZodString;
    argv: z.ZodArray<z.ZodString>;
    cwd: z.ZodOptional<z.ZodString>;
    env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    tty: z.ZodOptional<z.ZodObject<{
        cols: z.ZodNumber;
        rows: z.ZodNumber;
        colors: z.ZodOptional<z.ZodEnum<{
            truecolor: "truecolor";
            256: "256";
            16: "16";
        }>>;
    }, z.core.$strip>>;
    stdin: z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>>;
    promptPolicy: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
        error: "error";
        confirm: "confirm";
        deny: "deny";
    }>, z.ZodObject<{
        answers: z.ZodRecord<z.ZodString, z.ZodString>;
    }, z.core.$strip>]>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"resize">;
    invocationId: z.ZodString;
    size: z.ZodObject<{
        cols: z.ZodNumber;
        rows: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"cancel">;
    invocationId: z.ZodString;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"ack">;
    invocationId: z.ZodString;
    stream: z.ZodEnum<{
        stdout: "stdout";
        stderr: "stderr";
    }>;
    bytes: z.ZodNumber;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"dispose">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"exportTree">;
    id: z.ZodString;
    path: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"attachRuntime">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"detachRuntime">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"hookResult">;
    id: z.ZodString;
    outcome: z.ZodDiscriminatedUnion<[z.ZodObject<{
        ok: z.ZodLiteral<true>;
        stdout: z.ZodArray<z.ZodString>;
        stderr: z.ZodArray<z.ZodString>;
        code: z.ZodNumber;
        writes: z.ZodArray<z.ZodObject<{
            root: z.ZodString;
            entries: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
                kind: z.ZodLiteral<"file">;
                path: z.ZodString;
                offset: z.ZodNumber;
                length: z.ZodNumber;
            }, z.core.$strip>, z.ZodObject<{
                kind: z.ZodLiteral<"symlink">;
                path: z.ZodString;
                target: z.ZodString;
            }, z.core.$strip>], "kind">>;
            bytes: z.ZodCustom<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>;
            removed: z.ZodArray<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>, z.ZodObject<{
        ok: z.ZodLiteral<false>;
        error: z.ZodObject<{
            code: z.ZodEnum<{
                network: "network";
                "resolution-conflict": "resolution-conflict";
                "package-not-found": "package-not-found";
                "hash-mismatch": "hash-mismatch";
                "no-runtime-attached": "no-runtime-attached";
                "sdist-needs-runtime": "sdist-needs-runtime";
                "runtime-required": "runtime-required";
                "build-failed": "build-failed";
                unsupported: "unsupported";
                "invalid-config": "invalid-config";
                cancelled: "cancelled";
                "engine-crashed": "engine-crashed";
                "protocol-mismatch": "protocol-mismatch";
            }>;
            message: z.ZodString;
            data: z.ZodOptional<z.ZodUnknown>;
        }, z.core.$strip>;
    }, z.core.$strip>], "ok">;
}, z.core.$strip>], "type">

export type IndexOptions = z.infer<typeof indexOptionsSchema>;

indexOptionsSchema: z.ZodObject<{
    indexUrl: z.ZodOptional<z.ZodString>;
    extraIndexUrls: z.ZodOptional<z.ZodArray<z.ZodString>>;
    indexStrategy: z.ZodOptional<z.ZodEnum<{
        "first-index": "first-index";
        "unsafe-first-match": "unsafe-first-match";
        "unsafe-best-match": "unsafe-best-match";
    }>>;
    pyodideIndex: z.ZodOptional<z.ZodURL>;
}, z.core.$strip>

indexStrategySchema: z.ZodEnum<{
    "first-index": "first-index";
    "unsafe-first-match": "unsafe-first-match";
    "unsafe-best-match": "unsafe-best-match";
}>

export type InitMessage = z.infer<typeof initMessageSchema>;

initMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"init">;
    id: z.ZodString;
    protocolVersion: z.ZodString;
    config: z.ZodObject<{
        fs: z.ZodDefault<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"memory">;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"opfs">;
            root: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"delegate">;
        }, z.core.$strip>], "kind">>;
        cache: z.ZodDefault<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"opfs">;
            scope: z.ZodOptional<z.ZodString>;
            abiTag: z.ZodOptional<z.ZodString>;
            budgetBytes: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"memory">;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"none">;
        }, z.core.$strip>], "kind">>;
        transport: z.ZodDefault<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"platform">;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"fetch">;
            rewriteHead: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"libcurl">;
            moduleUrl: z.ZodString;
            wasmUrl: z.ZodOptional<z.ZodString>;
            relayUrl: z.ZodString;
            userAgent: z.ZodOptional<z.ZodString>;
            maxConnections: z.ZodOptional<z.ZodNumber>;
            connectionCache: z.ZodOptional<z.ZodNumber>;
            connectionsPerHost: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>], "kind">>;
        index: z.ZodDefault<z.ZodObject<{
            indexUrl: z.ZodOptional<z.ZodString>;
            extraIndexUrls: z.ZodOptional<z.ZodArray<z.ZodString>>;
            indexStrategy: z.ZodOptional<z.ZodEnum<{
                "first-index": "first-index";
                "unsafe-first-match": "unsafe-first-match";
                "unsafe-best-match": "unsafe-best-match";
            }>>;
            pyodideIndex: z.ZodOptional<z.ZodURL>;
        }, z.core.$strip>>;
        env: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        cwd: z.ZodDefault<z.ZodString>;
        logFilter: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>

export type InitResultMessage = z.infer<typeof initResultMessageSchema>;

initResultMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"initResult">;
    id: z.ZodString;
    outcome: z.ZodDiscriminatedUnion<[z.ZodObject<{
        ok: z.ZodLiteral<true>;
        build: z.ZodObject<{
            engine: z.ZodString;
            uv: z.ZodString;
            protocol: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        ok: z.ZodLiteral<false>;
        error: z.ZodObject<{
            code: z.ZodEnum<{
                network: "network";
                "resolution-conflict": "resolution-conflict";
                "package-not-found": "package-not-found";
                "hash-mismatch": "hash-mismatch";
                "no-runtime-attached": "no-runtime-attached";
                "sdist-needs-runtime": "sdist-needs-runtime";
                "runtime-required": "runtime-required";
                "build-failed": "build-failed";
                unsupported: "unsupported";
                "invalid-config": "invalid-config";
                cancelled: "cancelled";
                "engine-crashed": "engine-crashed";
                "protocol-mismatch": "protocol-mismatch";
            }>;
            message: z.ZodString;
            data: z.ZodOptional<z.ZodUnknown>;
        }, z.core.$strip>;
    }, z.core.$strip>], "ok">;
}, z.core.$strip>

export declare function isCompatibleProtocol(remoteVersion: string): boolean;

export type LogLevel = z.infer<typeof logLevelSchema>;

logLevelSchema: z.ZodEnum<{
    error: "error";
    trace: "trace";
    debug: "debug";
    info: "info";
    warn: "warn";
}>

MAX_STDIN_BYTES: number

export type OutputMessage = z.infer<typeof outputMessageSchema>;

outputMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"output">;
    invocationId: z.ZodString;
    stream: z.ZodEnum<{
        stdout: "stdout";
        stderr: "stderr";
    }>;
    seq: z.ZodNumber;
    data: z.ZodCustom<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>;
}, z.core.$strip>

export type PackageRef = z.infer<typeof packageRefSchema>;

packageRefSchema: z.ZodObject<{
    name: z.ZodString;
    version: z.ZodOptional<z.ZodString>;
    source: z.ZodOptional<z.ZodString>;
}, z.core.$strip>

export declare function parseHostMessage(value: unknown): HostMessage;

export declare function parseWorkerMessage(value: unknown): WorkerMessage;

progressKindSchema: z.ZodEnum<{
    download: "download";
    build: "build";
    install: "install";
    checkout: "checkout";
}>

progressUnitSchema: z.ZodEnum<{
    bytes: "bytes";
    items: "items";
}>

export type PromptPolicy = z.infer<typeof promptPolicySchema>;

promptPolicySchema: z.ZodUnion<readonly [z.ZodEnum<{
    error: "error";
    confirm: "confirm";
    deny: "deny";
}>, z.ZodObject<{
    answers: z.ZodRecord<z.ZodString, z.ZodString>;
}, z.core.$strip>]>

PROTOCOL_VERSION = "0"

export declare class ProtocolError extends Error {
    readonly issues: unknown;
    constructor(message: string, issues?: unknown);
}

export type ProtocolVersion = typeof PROTOCOL_VERSION;

export interface ProxyTransport {
    fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export type ResizeMessage = z.infer<typeof resizeMessageSchema>;

resizeMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"resize">;
    invocationId: z.ZodString;
    size: z.ZodObject<{
        cols: z.ZodNumber;
        rows: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>

spanStateSchema: z.ZodEnum<{
    start: "start";
    end: "end";
}>

stdinSchema: z.ZodCustom<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>

export type StreamName = z.infer<typeof streamNameSchema>;

streamNameSchema: z.ZodEnum<{
    stdout: "stdout";
    stderr: "stderr";
}>

export type StructuredErrorInfo = z.infer<typeof structuredErrorSchema>;

structuredErrorSchema: z.ZodObject<{
    code: z.ZodEnum<{
        network: "network";
        "resolution-conflict": "resolution-conflict";
        "package-not-found": "package-not-found";
        "hash-mismatch": "hash-mismatch";
        "no-runtime-attached": "no-runtime-attached";
        "sdist-needs-runtime": "sdist-needs-runtime";
        "runtime-required": "runtime-required";
        "build-failed": "build-failed";
        unsupported: "unsupported";
        "invalid-config": "invalid-config";
        cancelled: "cancelled";
        "engine-crashed": "engine-crashed";
        "protocol-mismatch": "protocol-mismatch";
    }>;
    message: z.ZodString;
    data: z.ZodOptional<z.ZodUnknown>;
}, z.core.$strip>

export type TransportSpec = z.infer<typeof transportSpecSchema>;

transportSpecSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"platform">;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"fetch">;
    rewriteHead: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"libcurl">;
    moduleUrl: z.ZodString;
    wasmUrl: z.ZodOptional<z.ZodString>;
    relayUrl: z.ZodString;
    userAgent: z.ZodOptional<z.ZodString>;
    maxConnections: z.ZodOptional<z.ZodNumber>;
    connectionCache: z.ZodOptional<z.ZodNumber>;
    connectionsPerHost: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>], "kind">

export type TreeEntry = z.infer<typeof treeEntrySchema>;

treeEntrySchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"file">;
    path: z.ZodString;
    offset: z.ZodNumber;
    length: z.ZodNumber;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"symlink">;
    path: z.ZodString;
    target: z.ZodString;
}, z.core.$strip>], "kind">

export type TtyConfig = z.infer<typeof ttyConfigSchema>;

ttyConfigSchema: z.ZodObject<{
    cols: z.ZodNumber;
    rows: z.ZodNumber;
    colors: z.ZodOptional<z.ZodEnum<{
        truecolor: "truecolor";
        256: "256";
        16: "16";
    }>>;
}, z.core.$strip>

export type TtySize = z.infer<typeof ttySizeSchema>;

ttySizeSchema: z.ZodObject<{
    cols: z.ZodNumber;
    rows: z.ZodNumber;
}, z.core.$strip>

WORKER_MESSAGE_TYPES: readonly ["initResult", "bootProgress", "output", "event", "exit", "fatal", "exportTreeResult", "hookRequest"]

export type WorkerMessage = z.infer<typeof workerMessageSchema>;

workerMessageSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"initResult">;
    id: z.ZodString;
    outcome: z.ZodDiscriminatedUnion<[z.ZodObject<{
        ok: z.ZodLiteral<true>;
        build: z.ZodObject<{
            engine: z.ZodString;
            uv: z.ZodString;
            protocol: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>, z.ZodObject<{
        ok: z.ZodLiteral<false>;
        error: z.ZodObject<{
            code: z.ZodEnum<{
                network: "network";
                "resolution-conflict": "resolution-conflict";
                "package-not-found": "package-not-found";
                "hash-mismatch": "hash-mismatch";
                "no-runtime-attached": "no-runtime-attached";
                "sdist-needs-runtime": "sdist-needs-runtime";
                "runtime-required": "runtime-required";
                "build-failed": "build-failed";
                unsupported: "unsupported";
                "invalid-config": "invalid-config";
                cancelled: "cancelled";
                "engine-crashed": "engine-crashed";
                "protocol-mismatch": "protocol-mismatch";
            }>;
            message: z.ZodString;
            data: z.ZodOptional<z.ZodUnknown>;
        }, z.core.$strip>;
    }, z.core.$strip>], "ok">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"bootProgress">;
    phase: z.ZodEnum<{
        "compile-start": "compile-start";
        "compile-done": "compile-done";
        "init-start": "init-start";
        ready: "ready";
    }>;
    ms: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"output">;
    invocationId: z.ZodString;
    stream: z.ZodEnum<{
        stdout: "stdout";
        stderr: "stderr";
    }>;
    seq: z.ZodNumber;
    data: z.ZodCustom<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"event">;
    event: z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"log">;
        invocationId: z.ZodOptional<z.ZodString>;
        level: z.ZodEnum<{
            error: "error";
            trace: "trace";
            debug: "debug";
            info: "info";
            warn: "warn";
        }>;
        message: z.ZodString;
        target: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"phase">;
        invocationId: z.ZodString;
        phase: z.ZodEnum<{
            resolving: "resolving";
            downloading: "downloading";
            building: "building";
            installing: "installing";
            uninstalling: "uninstalling";
            auditing: "auditing";
        }>;
        state: z.ZodEnum<{
            start: "start";
            end: "end";
        }>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"progress">;
        invocationId: z.ZodString;
        progressId: z.ZodString;
        kind: z.ZodEnum<{
            download: "download";
            build: "build";
            install: "install";
            checkout: "checkout";
        }>;
        subject: z.ZodOptional<z.ZodString>;
        current: z.ZodNumber;
        total: z.ZodOptional<z.ZodNumber>;
        unit: z.ZodEnum<{
            bytes: "bytes";
            items: "items";
        }>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"request">;
        invocationId: z.ZodOptional<z.ZodString>;
        method: z.ZodString;
        url: z.ZodString;
        status: z.ZodOptional<z.ZodNumber>;
        fromCache: z.ZodBoolean;
        bytes: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"resolution-complete">;
        invocationId: z.ZodString;
        packageCount: z.ZodNumber;
        durationMs: z.ZodNumber;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"install-report">;
        invocationId: z.ZodString;
        installed: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodOptional<z.ZodString>;
            source: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        removed: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodOptional<z.ZodString>;
            source: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        unchanged: z.ZodNumber;
    }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"runtime-finalize">;
        invocationId: z.ZodString;
        package: z.ZodObject<{
            name: z.ZodString;
            version: z.ZodOptional<z.ZodString>;
            source: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        action: z.ZodEnum<{
            build: "build";
            dynlibs: "dynlibs";
        }>;
        state: z.ZodEnum<{
            start: "start";
            end: "end";
        }>;
    }, z.core.$strip>], "type">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"exit">;
    invocationId: z.ZodString;
    code: z.ZodNumber;
    cancelled: z.ZodBoolean;
    durationMs: z.ZodNumber;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodEnum<{
            network: "network";
            "resolution-conflict": "resolution-conflict";
            "package-not-found": "package-not-found";
            "hash-mismatch": "hash-mismatch";
            "no-runtime-attached": "no-runtime-attached";
            "sdist-needs-runtime": "sdist-needs-runtime";
            "runtime-required": "runtime-required";
            "build-failed": "build-failed";
            unsupported: "unsupported";
            "invalid-config": "invalid-config";
            cancelled: "cancelled";
            "engine-crashed": "engine-crashed";
            "protocol-mismatch": "protocol-mismatch";
        }>;
        message: z.ZodString;
        data: z.ZodOptional<z.ZodUnknown>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"fatal">;
    message: z.ZodString;
    stack: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"exportTreeResult">;
    id: z.ZodString;
    outcome: z.ZodDiscriminatedUnion<[z.ZodObject<{
        ok: z.ZodLiteral<true>;
        entries: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"file">;
            path: z.ZodString;
            offset: z.ZodNumber;
            length: z.ZodNumber;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"symlink">;
            path: z.ZodString;
            target: z.ZodString;
        }, z.core.$strip>], "kind">>;
        bytes: z.ZodCustom<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>;
    }, z.core.$strip>, z.ZodObject<{
        ok: z.ZodLiteral<false>;
        error: z.ZodObject<{
            code: z.ZodEnum<{
                network: "network";
                "resolution-conflict": "resolution-conflict";
                "package-not-found": "package-not-found";
                "hash-mismatch": "hash-mismatch";
                "no-runtime-attached": "no-runtime-attached";
                "sdist-needs-runtime": "sdist-needs-runtime";
                "runtime-required": "runtime-required";
                "build-failed": "build-failed";
                unsupported: "unsupported";
                "invalid-config": "invalid-config";
                cancelled: "cancelled";
                "engine-crashed": "engine-crashed";
                "protocol-mismatch": "protocol-mismatch";
            }>;
            message: z.ZodString;
            data: z.ZodOptional<z.ZodUnknown>;
        }, z.core.$strip>;
    }, z.core.$strip>], "ok">;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"hookRequest">;
    id: z.ZodString;
    script: z.ZodString;
    cwd: z.ZodString;
    env: z.ZodRecord<z.ZodString, z.ZodString>;
    sitePackages: z.ZodArray<z.ZodString>;
    trees: z.ZodArray<z.ZodObject<{
        root: z.ZodString;
        collect: z.ZodEnum<{
            new: "new";
            changes: "changes";
        }>;
        entries: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"file">;
            path: z.ZodString;
            offset: z.ZodNumber;
            length: z.ZodNumber;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"symlink">;
            path: z.ZodString;
            target: z.ZodString;
        }, z.core.$strip>], "kind">>;
        bytes: z.ZodCustom<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>;
    }, z.core.$strip>>;
}, z.core.$strip>], "type">
```
