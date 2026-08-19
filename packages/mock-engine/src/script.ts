import type { BuildIdentity, EngineEvent, StructuredErrorInfo } from "@uv-wasm/engine-protocol";

export type MockStep =
  | { kind: "stdout"; text: string }
  | { kind: "stderr"; text: string }
  | { kind: "event"; event: EngineEvent }
  | { kind: "pause" };

export interface MockCommand {
  argv: string[];
  steps?: MockStep[];
  exitCode?: number;
  error?: StructuredErrorInfo;
}

export interface MockScript {
  build?: BuildIdentity;
  protocolVersion?: string;
  commands?: MockCommand[];
  unknownCommand?: {
    exitCode: number;
    error?: StructuredErrorInfo;
    steps?: MockStep[];
  };
}

export function matchCommand(script: MockScript, argv: string[]): MockCommand | undefined {
  return script.commands?.find(
    (command) =>
      command.argv.length === argv.length &&
      command.argv.every((token, index) => token === argv[index]),
  );
}
