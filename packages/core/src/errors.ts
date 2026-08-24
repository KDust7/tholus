import type { ErrorCode, StructuredErrorInfo } from "@tholus/engine-protocol";

export abstract class EngineError extends Error {
  abstract readonly code: ErrorCode;
  readonly data: unknown;

  constructor(message: string, data?: unknown) {
    super(message);
    this.name = new.target.name;
    this.data = data;
  }
}

export class NetworkError extends EngineError {
  readonly code = "network" as const;
}

export class ResolutionConflictError extends EngineError {
  readonly code = "resolution-conflict" as const;
}

export class PackageNotFoundError extends EngineError {
  readonly code = "package-not-found" as const;
}

export class HashMismatchError extends EngineError {
  readonly code = "hash-mismatch" as const;
}

export class NoRuntimeAttachedError extends EngineError {
  readonly code = "no-runtime-attached" as const;
}

export class SdistNeedsRuntimeError extends EngineError {
  readonly code = "sdist-needs-runtime" as const;
}

export class RuntimeRequiredError extends EngineError {
  readonly code = "runtime-required" as const;
}

export class BuildFailedError extends EngineError {
  readonly code = "build-failed" as const;
}

export class UnsupportedError extends EngineError {
  readonly code = "unsupported" as const;
}

export class InvalidConfigError extends EngineError {
  readonly code = "invalid-config" as const;
}

export class CancelledError extends EngineError {
  readonly code = "cancelled" as const;
}

export class EngineCrashedError extends EngineError {
  readonly code = "engine-crashed" as const;
}

export class ProtocolMismatchError extends EngineError {
  readonly code = "protocol-mismatch" as const;
}

const CONSTRUCTORS: Record<ErrorCode, new (message: string, data?: unknown) => EngineError> = {
  network: NetworkError,
  "resolution-conflict": ResolutionConflictError,
  "package-not-found": PackageNotFoundError,
  "hash-mismatch": HashMismatchError,
  "no-runtime-attached": NoRuntimeAttachedError,
  "sdist-needs-runtime": SdistNeedsRuntimeError,
  "runtime-required": RuntimeRequiredError,
  "build-failed": BuildFailedError,
  unsupported: UnsupportedError,
  "invalid-config": InvalidConfigError,
  cancelled: CancelledError,
  "engine-crashed": EngineCrashedError,
  "protocol-mismatch": ProtocolMismatchError,
};

export function toEngineError(info: StructuredErrorInfo): EngineError {
  const Constructor = CONSTRUCTORS[info.code];
  return new Constructor(info.message, info.data);
}
