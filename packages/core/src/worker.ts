import { createEngineWorker, type EngineExports } from "./engine-worker.js";

interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

const scope = globalThis as unknown as WorkerScope;
const engineUrl = new URL("../assets/engine.js", import.meta.url).href;

const worker = createEngineWorker({
  load: async (): Promise<EngineExports> => (await import(engineUrl)) as EngineExports,
  emit: (message) => {
    scope.postMessage(message);
  },
});

scope.addEventListener("message", (event) => {
  worker.receive(event.data);
});
