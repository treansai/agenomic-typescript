import type { ModelCallDraft } from "../models";
import type { ProtectOverlay } from "../protect";
import { getCurrentTrace, type TraceBuilder } from "../tracing";
import { diffMilliseconds, normalizeError, nowIso } from "../utils";

type AnyAsyncFunction = (...args: any[]) => Promise<any>;

export type OpenAIRequestKind = "chat" | "responses";

export interface OpenAIInstrumentationOptions {
  trace?: TraceBuilder;
  provider?: string;
  /** Protect instruction overlay injected first, deterministically and idempotently, in the pre call window. */
  overlay?: string | ProtectOverlay;
}

function resolveTrace(trace?: TraceBuilder): TraceBuilder | undefined {
  return trace ?? getCurrentTrace();
}

function overlayText(overlay: string | ProtectOverlay | undefined): string | undefined {
  const text = typeof overlay === "string" ? overlay : overlay?.text;
  return text && text.length > 0 ? text : undefined;
}

/** Pure request transform: returns a new request carrying the overlay, or the same one when already present. */
export function applyOverlay(
  kind: OpenAIRequestKind,
  request: Record<string, unknown>,
  overlay: string | ProtectOverlay | undefined,
): Record<string, unknown> {
  const text = overlayText(overlay);
  if (text === undefined) return request;
  if (kind === "chat") {
    const messages = Array.isArray(request.messages) ? (request.messages as unknown[]) : [];
    const first = messages[0] as { role?: unknown; content?: unknown } | undefined;
    if (first?.role === "system" && first.content === text) return request;
    return { ...request, messages: [{ role: "system", content: text }, ...messages] };
  }
  const instructions = typeof request.instructions === "string" ? request.instructions : "";
  if (instructions === text || instructions.startsWith(`${text}\n\n`)) return request;
  return { ...request, instructions: instructions.length > 0 ? `${text}\n\n${instructions}` : text };
}

function toModelCall(
  provider: string,
  startedAt: string,
  endedAt: string,
  request: Record<string, unknown>,
  response: Record<string, unknown>,
  error?: unknown,
): ModelCallDraft {
  const usage = response.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
      }
    | undefined;
  const firstChoice = Array.isArray(response.choices)
    ? (response.choices[0] as
        | { message?: { content?: unknown } }
        | undefined)
    : undefined;
  const input =
    "input" in request
      ? typeof request.instructions === "string"
        ? { instructions: request.instructions, input: request.input }
        : request.input
      : request.messages ?? request.prompt;

  return {
    type: "model_call",
    provider,
    model:
      typeof request.model === "string" && request.model.length > 0
        ? request.model
        : "unknown",
    input,
    output:
      response.output_text ??
      response.output ??
      firstChoice?.message?.content ??
      response,
    startedAt,
    endedAt,
    latencyMs: diffMilliseconds(startedAt, endedAt),
    usage: usage
      ? {
          inputTokens: usage.input_tokens ?? usage.prompt_tokens,
          outputTokens: usage.output_tokens ?? usage.completion_tokens,
          totalTokens: usage.total_tokens,
        }
      : undefined,
    error: error ? normalizeError(error) : undefined,
  };
}

function wrapCreateMethod(
  fn: AnyAsyncFunction,
  kind: OpenAIRequestKind,
  options: OpenAIInstrumentationOptions,
): AnyAsyncFunction {
  return async (...args: unknown[]) => {
    const trace = resolveTrace(options.trace);
    const original = ((args[0] as Record<string, unknown> | undefined) ?? {});
    const request = applyOverlay(kind, original, options.overlay);
    const forwarded = request === original ? args : [request, ...args.slice(1)];
    const startedAt = nowIso();

    try {
      const response = await fn(...forwarded);
      const endedAt = nowIso();

      if (trace) {
        trace.addModelCall(
          toModelCall(
            options.provider ?? "openai",
            startedAt,
            endedAt,
            request,
            (response as Record<string, unknown>) ?? {},
          ),
        );
      }

      return response;
    } catch (error) {
      const endedAt = nowIso();
      if (trace) {
        trace.addModelCall(
          toModelCall(
            options.provider ?? "openai",
            startedAt,
            endedAt,
            request,
            {},
            error,
          ),
        );
      }

      throw error;
    }
  };
}

export function instrumentOpenAI<T extends Record<string, any>>(
  client: T,
  options: OpenAIInstrumentationOptions = {},
): T {
  const wrapped = { ...client } as Record<string, any>;

  if (client.responses?.create) {
    wrapped.responses = {
      ...client.responses,
      create: wrapCreateMethod(
        client.responses.create.bind(client.responses),
        "responses",
        options,
      ),
    };
  }

  if (client.chat?.completions?.create) {
    wrapped.chat = {
      ...client.chat,
      completions: {
        ...client.chat.completions,
        create: wrapCreateMethod(
          client.chat.completions.create.bind(client.chat.completions),
          "chat",
          options,
        ),
      },
    };
  }

  return wrapped as T;
}
