import type { AgentLockClient } from "../client";
import type { CreateTraceInput, RedactionInput, RedactionMode } from "../models";
import { TraceBuilder, withTraceContext } from "../tracing";

export interface NextRouteTraceOptions<TContext = unknown> {
  client: AgentLockClient;
  agentId: string;
  release?: string;
  redact?: RedactionInput;
  redactionMode?: RedactionMode;
  localOnly?: boolean;
  metadata?: Record<string, unknown>;
  runMetadata?: Record<string, unknown>;
  tags?: string[];
  mapRequest?: (
    request: Request,
    context: TContext,
  ) => Promise<unknown> | unknown;
  mapResponse?: (
    response: Response,
    request: Request,
    context: TContext,
  ) => Promise<unknown> | unknown;
}

export function serializeRequestSnapshot(request: Request): Record<string, unknown> {
  return {
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers.entries()),
  };
}

export function serializeResponseSnapshot(response: Response): Record<string, unknown> {
  return {
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
  };
}

export function withTracedRoute<TContext = unknown>(
  options: NextRouteTraceOptions<TContext>,
  handler: (
    request: Request,
    context: TContext,
    trace: TraceBuilder,
  ) => Promise<Response> | Response,
): (request: Request, context: TContext) => Promise<Response> {
  return async (request: Request, context: TContext): Promise<Response> => {
    const createInput: CreateTraceInput = {
      agentId: options.agentId,
      release: options.release,
      redact: options.redact,
      redactionMode: options.redactionMode,
      metadata: options.metadata,
      runMetadata: options.runMetadata,
      tags: options.tags,
      input: options.mapRequest
        ? await options.mapRequest(request, context)
        : serializeRequestSnapshot(request),
    };
    const trace = options.client.createTrace(createInput);

    try {
      const response = await withTraceContext(trace, async () =>
        Promise.resolve(handler(request, context, trace)),
      );
      const output = options.mapResponse
        ? await options.mapResponse(response, request, context)
        : serializeResponseSnapshot(response);

      trace.complete({ output, status: "success" });
      if (!options.localOnly) {
        await trace.emit();
      }

      return response;
    } catch (error) {
      trace.fail(error);
      if (!options.localOnly) {
        await trace.emit();
      }

      throw error;
    }
  };
}
