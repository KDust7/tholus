import { createMockEngine } from "@uv-wasm/mock-engine";
import { describe, expect, it } from "vitest";
import { canonicalScript } from "./canonical-script.js";
import { loadAllTranscripts, loadTranscript, transcriptNames } from "./load.js";
import { type EngineEndpoint, replayTranscript } from "./replay.js";

describe("transcript corpus", () => {
  it("ships transcripts", () => {
    expect(transcriptNames().length).toBeGreaterThan(0);
  });

  it("parses every transcript and pins them to one protocol version", () => {
    const transcripts = loadAllTranscripts();
    for (const transcript of transcripts) {
      expect(transcript.protocolVersion).toBe("0");
      expect(transcript.steps.length).toBeGreaterThan(0);
    }
  });

  it("decodes text payloads into bytes", () => {
    const transcript = loadTranscript("exec-stdout-exit");
    const output = transcript.steps.find(
      (step) => (step.message as { type?: string }).type === "output",
    );
    expect(output).toBeDefined();
    const message = output?.message as { data?: unknown } | undefined;
    expect(message?.data).toBeInstanceOf(Uint8Array);
  });
});

describe("mock engine conformance", () => {
  for (const name of transcriptNames()) {
    it(`satisfies ${name}`, async () => {
      const engine = createMockEngine(canonicalScript);
      const result = await replayTranscript(engine, loadTranscript(name));
      engine.terminate();

      if (!result.ok) {
        throw new Error(
          `${name} diverged:\n${JSON.stringify(result.mismatches, null, 2)}\nobserved:\n${JSON.stringify(
            result.observed,
            null,
            2,
          )}`,
        );
      }
      expect(result.ok).toBe(true);
    });
  }
});

describe("replay harness", () => {
  it("reports a mismatch when the engine deviates", async () => {
    const engine = createMockEngine({
      commands: [{ argv: ["pip", "list"], steps: [{ kind: "stdout", text: "wrong\n" }] }],
    });
    const result = await replayTranscript(engine, loadTranscript("exec-stdout-exit"));
    engine.terminate();

    expect(result.ok).toBe(false);
    expect(result.mismatches[0]?.reason).toContain("did not match");
  });

  it("reports silence as a mismatch rather than hanging", async () => {
    const silent: EngineEndpoint = {
      postMessage: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      terminate: () => {},
    };

    const result = await replayTranscript(silent, loadTranscript("init-handshake"), {
      timeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    expect(result.mismatches[0]?.reason).toContain("timed out");
  });

  it("flags a message the transcript never anticipated", async () => {
    const engine = createMockEngine({
      commands: [
        {
          argv: ["pip", "list"],
          steps: [
            { kind: "stdout", text: "rich    13.9.4\n" },
            { kind: "stdout", text: "unexpected\n" },
          ],
        },
      ],
    });
    const result = await replayTranscript(engine, loadTranscript("exec-stdout-exit"));
    engine.terminate();

    expect(result.ok).toBe(false);
  });
});
