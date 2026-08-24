import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { engineConfigSchema } from "../config.js";
import { structuredErrorSchema } from "../errors.js";
import { engineEventSchema } from "../events.js";
import { hostMessageSchema, workerMessageSchema } from "../messages.js";
import { PROTOCOL_VERSION } from "../version.js";

const artifacts = {
  "host-message": hostMessageSchema,
  "worker-message": workerMessageSchema,
  "engine-event": engineEventSchema,
  "engine-config": engineConfigSchema,
  "structured-error": structuredErrorSchema,
} as const;

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schema");
await mkdir(outDir, { recursive: true });

const written: string[] = [];
for (const [name, schema] of Object.entries(artifacts)) {
  const json = z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
  const document = {
    $id: `https://tholus.invalid/protocol/${PROTOCOL_VERSION}/${name}.json`,
    ...json,
  };
  const path = join(outDir, `${name}.json`);
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  written.push(name);
}

await writeFile(
  join(outDir, "index.json"),
  `${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, schemas: written }, null, 2)}\n`,
  "utf8",
);

process.stdout.write(`emitted ${written.length} schemas for protocol ${PROTOCOL_VERSION}\n`);
