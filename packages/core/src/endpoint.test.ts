import { describe, expect, it, vi } from "vitest";
import { workerEndpoint } from "./endpoint.js";
import { UnsupportedError } from "./errors.js";

describe("workerEndpoint", () => {
  it("explains itself when the environment has no Worker", () => {
    expect(() => workerEndpoint("./worker.js")).toThrow(UnsupportedError);
    expect(() => workerEndpoint("./worker.js")).toThrow(/options\.endpoint/);
  });

  it("bridges worker messages onto the endpoint listener shape", () => {
    const handlers = new Set<(event: MessageEvent) => void>();
    const posted: unknown[] = [];
    const terminate = vi.fn();

    class FakeWorker {
      postMessage(message: unknown) {
        posted.push(message);
      }
      addEventListener(_type: string, handler: (event: MessageEvent) => void) {
        handlers.add(handler);
      }
      removeEventListener(_type: string, handler: (event: MessageEvent) => void) {
        handlers.delete(handler);
      }
      terminate = terminate;
    }

    vi.stubGlobal("Worker", FakeWorker);

    try {
      const endpoint = workerEndpoint("./worker.js");
      const seen: unknown[] = [];
      const listener = (event: { data: unknown }) => seen.push(event.data);

      endpoint.addEventListener("message", listener);
      endpoint.postMessage({ type: "dispose" });
      for (const handler of handlers) {
        handler({ data: "hello" } as MessageEvent);
      }

      expect(posted).toEqual([{ type: "dispose" }]);
      expect(seen).toEqual(["hello"]);

      endpoint.removeEventListener("message", listener);
      expect(handlers.size).toBe(0);

      endpoint.removeEventListener("message", listener);

      endpoint.terminate();
      expect(terminate).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
