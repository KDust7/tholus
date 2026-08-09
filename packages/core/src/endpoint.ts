import { UnsupportedError } from "./errors.js";

export interface EngineEndpoint {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  terminate(): void;
}

export type EndpointFactory = () => EngineEndpoint | Promise<EngineEndpoint>;

export function workerEndpoint(url: URL | string): EngineEndpoint {
  if (typeof Worker === "undefined") {
    throw new UnsupportedError(
      "this environment has no Worker constructor; supply options.endpoint to run the engine elsewhere",
    );
  }

  const worker = new Worker(url, { type: "module" });
  const wrappers = new Map<(event: { data: unknown }) => void, (event: MessageEvent) => void>();

  return {
    postMessage(message: unknown): void {
      worker.postMessage(message);
    },
    addEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
      const wrapper = (event: MessageEvent) => listener({ data: event.data });
      wrappers.set(listener, wrapper);
      worker.addEventListener("message", wrapper);
    },
    removeEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
      const wrapper = wrappers.get(listener);
      if (!wrapper) {
        return;
      }
      wrappers.delete(listener);
      worker.removeEventListener("message", wrapper);
    },
    terminate(): void {
      wrappers.clear();
      worker.terminate();
    },
  };
}
