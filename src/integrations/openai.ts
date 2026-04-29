import type { ModelCallDraft } from "../models";
import { getCurrentTrace, type TraceBuilder } from "../tracing";
import { diffMilliseconds, normalizeError, nowIso } from "../utils";

type AnyAsyncFunction = (...args: any[]) => Promise<any>;

export interface OpenAIInstrumentationOptions {
  trace?: TraceBuilder;
  provider?: string;
}

function resolveTrace(trace?: TraceBuilder): TraceBuilder | undefined {
  return trace ?? getCurrentTrace();
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

  return {
    type: "model_call",
    provider,
    model:
      typeof request.model === "string" && request.model.length > 0
        ? request.model
        : "unknown",
    input: "input" in request ? request.input : request.messages ?? request.prompt,
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
  options: OpenAIInstrumentationOptions,
): AnyAsyncFunction {
  return async (...args: unknown[]) => {
    const trace = resolveTrace(options.trace);
    const request = ((args[0] as Record<string, unknown> | undefined) ?? {});
    const startedAt = nowIso();

    try {
      const response = await fn(...args);
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
          options,
        ),
      },
    };
  }

  return wrapped as T;
}
