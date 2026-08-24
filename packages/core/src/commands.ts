import type { EngineEvent, PackageRef, StructuredErrorInfo } from "@tholus/engine-protocol";
import type { Engine, ExecOptions } from "./engine.js";
import { type EngineError, toEngineError, UnsupportedError } from "./errors.js";
import { collectText } from "./text.js";

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  venv?: string;
  signal?: AbortSignal;
  onEvent?: (event: EngineEvent) => void;
}

export interface CommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
  events: EngineEvent[];
}

export interface InstalledPackage {
  name: string;
  version: string;
}

export interface PackageDetail {
  name: string;
  version: string;
  location?: string;
  requires: string[];
  requiredBy: string[];
}

export interface InstallReport {
  installed: PackageRef[];
  removed: PackageRef[];
  unchanged: number;
  needsRuntimeFinalize: PackageRef[];
}

export interface InstallRequest extends CommandOptions {
  packages?: string[];
  requirements?: string[];
  constraints?: string[];
  upgrade?: boolean;
  reinstall?: boolean;
  dryRun?: boolean;
  requireHashes?: boolean;
}

export interface CompileRequest extends CommandOptions {
  requirements: string[];
  constraints?: string[];
  generateHashes?: boolean;
  universal?: boolean;
  pythonVersion?: string;
  pythonPlatform?: string;
}

export interface CompileResult {
  text: string;
  events: EngineEvent[];
}

export interface SyncRequest extends CommandOptions {
  requirements: string[];
  requireHashes?: boolean;
}

export interface VenvRequest extends CommandOptions {
  path?: string;
  pythonVersion?: string;
  prompt?: string;
  clear?: boolean;
}

function execOptions(
  options: CommandOptions,
  stdout: (chunk: Uint8Array) => void,
  stderr: (chunk: Uint8Array) => void,
  events: EngineEvent[],
): ExecOptions {
  return {
    stdout,
    stderr,
    onEvent: (event) => {
      events.push(event);
      options.onEvent?.(event);
    },
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function withVenv(argv: string[], options: CommandOptions): string[] {
  return options.venv === undefined ? argv : [...argv, "--python", options.venv];
}

export async function runCommand(
  engine: Engine,
  argv: string[],
  options: CommandOptions = {},
): Promise<CommandOutcome> {
  const out = collectText();
  const err = collectText();
  const events: EngineEvent[] = [];

  const handle = engine.exec(argv, execOptions(options, out.sink, err.sink, events));
  const result = await handle.exit;

  return { code: result.code, stdout: out.text(), stderr: err.text(), events };
}

async function expectSuccess(
  engine: Engine,
  argv: string[],
  options: CommandOptions,
): Promise<CommandOutcome> {
  const out = collectText();
  const err = collectText();
  const events: EngineEvent[] = [];

  const handle = engine.exec(argv, execOptions(options, out.sink, err.sink, events));
  const result = await handle.exit;

  if (result.code !== 0) {
    throw failureFor(result.error, err.text(), argv);
  }
  return { code: result.code, stdout: out.text(), stderr: err.text(), events };
}

function failureFor(
  info: StructuredErrorInfo | undefined,
  stderr: string,
  argv: string[],
): EngineError {
  if (info) {
    return toEngineError(info);
  }
  const detail = stderr.trim();
  return new UnsupportedError(
    detail.length > 0 ? detail : `uv ${argv.join(" ")} failed without a reported cause`,
  );
}

function installReportFrom(events: EngineEvent[]): InstallReport {
  const report = [...events]
    .reverse()
    .find(
      (event): event is Extract<EngineEvent, { type: "install-report" }> =>
        event.type === "install-report",
    );
  const finalize = events
    .filter(
      (event): event is Extract<EngineEvent, { type: "runtime-finalize" }> =>
        event.type === "runtime-finalize" && event.state === "start",
    )
    .map((event) => event.package);

  return {
    installed: report?.installed ?? [],
    removed: report?.removed ?? [],
    unchanged: report?.unchanged ?? 0,
    needsRuntimeFinalize: finalize,
  };
}

function parseJsonArray(text: string, argv: string[]): unknown[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new UnsupportedError(`uv ${argv.join(" ")} did not return JSON`);
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

function toInstalledPackage(value: unknown): InstalledPackage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.version !== "string") {
    return undefined;
  }
  return { name: record.name, version: record.version };
}

export function createVenvApi(engine: Engine) {
  return {
    async create(request: VenvRequest = {}): Promise<{ path: string }> {
      const argv = ["venv"];
      if (request.path !== undefined) {
        argv.push(request.path);
      }
      if (request.pythonVersion !== undefined) {
        argv.push("--python", request.pythonVersion);
      }
      if (request.prompt !== undefined) {
        argv.push("--prompt", request.prompt);
      }
      if (request.clear) {
        argv.push("--clear");
      }
      await expectSuccess(engine, argv, request);
      return { path: request.path ?? ".venv" };
    },
  };
}

export function createPipApi(engine: Engine) {
  return {
    async install(request: InstallRequest = {}): Promise<InstallReport> {
      const argv = ["pip", "install"];
      for (const requirement of request.requirements ?? []) {
        argv.push("-r", requirement);
      }
      for (const constraint of request.constraints ?? []) {
        argv.push("-c", constraint);
      }
      if (request.upgrade) {
        argv.push("--upgrade");
      }
      if (request.reinstall) {
        argv.push("--reinstall");
      }
      if (request.dryRun) {
        argv.push("--dry-run");
      }
      if (request.requireHashes) {
        argv.push("--require-hashes");
      }
      argv.push(...(request.packages ?? []));

      const outcome = await expectSuccess(engine, withVenv(argv, request), request);
      return installReportFrom(outcome.events);
    },

    async uninstall(packages: string[], options: CommandOptions = {}): Promise<InstallReport> {
      const argv = withVenv(["pip", "uninstall", ...packages], options);
      const outcome = await expectSuccess(engine, argv, options);
      return installReportFrom(outcome.events);
    },

    async list(options: CommandOptions = {}): Promise<InstalledPackage[]> {
      const argv = withVenv(["pip", "list", "--format", "json"], options);
      const outcome = await expectSuccess(engine, argv, options);
      return parseJsonArray(outcome.stdout, argv)
        .map(toInstalledPackage)
        .filter((entry): entry is InstalledPackage => entry !== undefined);
    },

    async show(packages: string[], options: CommandOptions = {}): Promise<PackageDetail[]> {
      const argv = withVenv(["pip", "show", ...packages], options);
      const outcome = await expectSuccess(engine, argv, options);
      return parseShow(outcome.stdout);
    },

    async freeze(options: CommandOptions = {}): Promise<string> {
      const argv = withVenv(["pip", "freeze"], options);
      const outcome = await expectSuccess(engine, argv, options);
      return outcome.stdout;
    },

    async check(options: CommandOptions = {}): Promise<{ ok: boolean; problems: string[] }> {
      const argv = withVenv(["pip", "check"], options);
      const outcome = await runCommand(engine, argv, options);
      const problems = outcome.stderr
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return { ok: outcome.code === 0, problems: outcome.code === 0 ? [] : problems };
    },

    async compile(request: CompileRequest): Promise<CompileResult> {
      const argv = ["pip", "compile"];
      argv.push(...request.requirements);
      for (const constraint of request.constraints ?? []) {
        argv.push("-c", constraint);
      }
      if (request.generateHashes) {
        argv.push("--generate-hashes");
      }
      if (request.universal) {
        argv.push("--universal");
      }
      if (request.pythonVersion !== undefined) {
        argv.push("--python-version", request.pythonVersion);
      }
      if (request.pythonPlatform !== undefined) {
        argv.push("--python-platform", request.pythonPlatform);
      }

      const outcome = await expectSuccess(engine, argv, request);
      return { text: outcome.stdout, events: outcome.events };
    },

    async sync(request: SyncRequest): Promise<InstallReport> {
      const argv = ["pip", "sync", ...request.requirements];
      if (request.requireHashes) {
        argv.push("--require-hashes");
      }
      const outcome = await expectSuccess(engine, withVenv(argv, request), request);
      return installReportFrom(outcome.events);
    },
  };
}

export function parseShow(text: string): PackageDetail[] {
  const blocks = text
    .split(/\n---\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  const details: PackageDetail[] = [];
  for (const block of blocks) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const separator = line.indexOf(":");
      if (separator === -1) {
        continue;
      }
      fields.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }

    const name = fields.get("name");
    const version = fields.get("version");
    if (name === undefined || version === undefined) {
      continue;
    }

    const list = (key: string): string[] => {
      const raw = fields.get(key);
      if (raw === undefined || raw.length === 0) {
        return [];
      }
      return raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    };

    const location = fields.get("location");
    details.push({
      name,
      version,
      requires: list("requires"),
      requiredBy: list("required-by"),
      ...(location === undefined ? {} : { location }),
    });
  }
  return details;
}
