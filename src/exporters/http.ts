import type { TraceEnvelope } from "../models";
import { TraceEnvelopeSchema } from "../schemas";

export interface HttpExporterOptions {
  apiKey?: string;
  headers?: Record<string, string>;
  /** Gateway agent UUID; skips the lookup when the envelope's agent id is not a UUID. */
  agentUuid?: string;
  /** Known mapping from agent references (`agent://org/name`) to gateway UUIDs. */
  agentIds?: Record<string, string>;
}

export interface GatewayTraceRequest {
  agent_id: string;
  external_id: string;
  payload: unknown;
  events: Array<{ event_type: string; payload: unknown }>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function isBatchEndpoint(endpoint: string): boolean {
  return trimTrailingSlashes(endpoint).endsWith("/v1/traces/batch");
}

export function gatewayBase(endpoint: string): string {
  const trimmed = trimTrailingSlashes(endpoint);
  for (const suffix of ["/v1/traces/batch", "/v1/traces"]) {
    if (trimmed.endsWith(suffix)) return trimmed.slice(0, -suffix.length);
  }
  return trimmed;
}

function authHeaders(options: HttpExporterOptions): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    ...options.headers,
  };
}

export async function resolveAgentUuid(
  endpoint: string,
  agent: string,
  options: HttpExporterOptions = {},
): Promise<string> {
  if (options.agentUuid) return options.agentUuid;
  if (isUuid(agent)) return agent;
  const known = options.agentIds?.[agent];
  if (known) return known;

  const response = await fetch(`${gatewayBase(endpoint)}/v1/agents`, {
    method: "GET",
    headers: authHeaders(options),
  });
  if (!response.ok) {
    throw new Error(
      `Agenomic agent lookup failed with ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json()) as {
    agents?: Array<{ id: string; name?: string; slug?: string }>;
  };
  const tail = trimTrailingSlashes(agent).split("/").pop() ?? agent;
  const match = (body.agents ?? []).find(
    (item) =>
      item.slug === agent ||
      item.slug === tail ||
      item.name === agent ||
      item.name === tail,
  );
  if (!match) {
    throw new Error(`Cannot resolve agent "${agent}" to a registered agent id`);
  }
  if (options.agentIds) options.agentIds[agent] = match.id;
  return match.id;
}

export function toGatewayTrace(
  trace: TraceEnvelope,
  agentUuid: string,
): GatewayTraceRequest {
  return {
    agent_id: agentUuid,
    external_id: trace.run.traceId,
    payload: trace,
    events: trace.events.map((event) => ({
      event_type: event.type,
      payload: event,
    })),
  };
}

export async function sendTraceToHttp(
  endpoint: string,
  trace: TraceEnvelope,
  options: HttpExporterOptions = {},
): Promise<void> {
  const parsed = TraceEnvelopeSchema.parse(trace);
  const agentUuid = await resolveAgentUuid(endpoint, parsed.run.agentId, options);
  const request = toGatewayTrace(parsed, agentUuid);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: authHeaders(options),
    body: JSON.stringify(isBatchEndpoint(endpoint) ? { items: [request] } : request),
  });

  if (!response.ok) {
    throw new Error(
      `Agenomic ingestion failed with ${response.status} ${response.statusText}`,
    );
  }
}
