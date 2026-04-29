import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { TraceEnvelope } from "../models";
import { TraceEnvelopeSchema } from "../schemas";

export async function exportTracesToJsonl(
  path: string,
  traces: TraceEnvelope[],
): Promise<void> {
  const parsed = traces.map((trace) => TraceEnvelopeSchema.parse(trace));
  const jsonl = parsed.map((trace) => JSON.stringify(trace)).join("\n");

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, jsonl.length > 0 ? `${jsonl}\n` : "", "utf8");
}
