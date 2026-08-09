import {
  type HostMessage,
  hostMessageSchema,
  type WorkerMessage,
  workerMessageSchema,
} from "./messages.js";
import { PROTOCOL_VERSION } from "./version.js";

export class ProtocolError extends Error {
  readonly issues: unknown;

  constructor(message: string, issues?: unknown) {
    super(message);
    this.name = "ProtocolError";
    this.issues = issues;
  }
}

export function parseHostMessage(value: unknown): HostMessage {
  const result = hostMessageSchema.safeParse(value);
  if (!result.success) {
    throw new ProtocolError("invalid host message", result.error.issues);
  }
  return result.data;
}

export function parseWorkerMessage(value: unknown): WorkerMessage {
  const result = workerMessageSchema.safeParse(value);
  if (!result.success) {
    throw new ProtocolError("invalid worker message", result.error.issues);
  }
  return result.data;
}

export function isCompatibleProtocol(remoteVersion: string): boolean {
  return remoteVersion === PROTOCOL_VERSION;
}

export function assertCompatibleProtocol(remoteVersion: string): void {
  if (!isCompatibleProtocol(remoteVersion)) {
    throw new ProtocolError(
      `protocol mismatch: host speaks ${PROTOCOL_VERSION}, engine speaks ${remoteVersion}`,
    );
  }
}
