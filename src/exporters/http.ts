import type { TraceEnvelope } from "../models";
import { TraceEnvelopeSchema } from "../schemas";

export interface HttpExporterOptions {
  apiKey?: string;
  headers?: Record<string, string>;
}

export async function sendTraceToHttp(
  endpoint: string,
  trace: TraceEnvelope,
  options: HttpExporterOptions = {},
): Promise<void> {
  const payload = TraceEnvelopeSchema.parse(trace);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      ...options.headers,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(
      `Agenomic ingestion failed with ${response.status} ${response.statusText}`,
    );
  }
}
