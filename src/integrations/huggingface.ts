/**
 * Hugging Face instrumentation, mirroring {@link instrumentOpenAI}.
 *
 * Wraps a Hugging Face client-like object (anything exposing the inference
 * methods below) so each call records a `model_call` event on the active trace
 * with provider `"huggingface"`. No token is ever read, logged, or attached to
 * an event.
 */

import type { ModelCallDraft } from "../models";
import { getCurrentTrace, type TraceBuilder } from "../tracing";
import { diffMilliseconds, normalizeError, nowIso } from "../utils";
import {
  HUGGINGFACE_PROVIDER,
  isHuggingFace,
  normalizeProvider,
} from "../providers/huggingface";

type AnyAsyncFunction = (...args: any[]) => Promise<any>;

export interface HuggingFaceInstrumentationOptions {
  trace?: TraceBuilder;
  /**
   * Provider label recorded on the event. Defaults to `"huggingface"`; any HF
   * alias is normalized to the canonical name.
   */
  provider?: string;
}

function resolveTrace(trace?: TraceBuilder): TraceBuilder | undefined {
  return trace ?? getCurrentTrace();
}

function resolveProvider(provider?: string): string {
  if (!provider) return HUGGINGFACE_PROVIDER;
  if (isHuggingFace(provider)) return HUGGINGFACE_PROVIDER;
  return normalizeProvider(provider) ?? provider;
}

/**
 * Build a `model_call` draft from an inference call. The first argument is the
 * model id; the remaining arguments are the inputs (prompt / inputs / params).
 */
function toModelCall(
  provider: string,
  startedAt: string,
  endedAt: string,
  args: unknown[],
  response: unknown,
  error?: unknown,
): ModelCallDraft {
  const [model, input, parameters] = args;
  return {
    type: "model_call",
    provider,
    model: typeof model === "string" && model.length > 0 ? model : "unknown",
    input: parameters !== undefined ? { input, parameters } : input,
    output: error ? undefined : response,
    startedAt,
    endedAt,
    latencyMs: diffMilliseconds(startedAt, endedAt),
    error: error ? normalizeError(error) : undefined,
  };
}

function wrapInferenceMethod(
  fn: AnyAsyncFunction,
  options: HuggingFaceInstrumentationOptions,
): AnyAsyncFunction {
  const provider = resolveProvider(options.provider);
  return async (...args: unknown[]) => {
    const trace = resolveTrace(options.trace);
    const startedAt = nowIso();
    try {
      const response = await fn(...args);
      const endedAt = nowIso();
      if (trace) {
        trace.addModelCall(
          toModelCall(provider, startedAt, endedAt, args, response),
        );
      }
      return response;
    } catch (error) {
      const endedAt = nowIso();
      if (trace) {
        trace.addModelCall(
          toModelCall(provider, startedAt, endedAt, args, undefined, error),
        );
      }
      throw error;
    }
  };
}

/**
 * Wrap a Hugging Face client-like object so its inference methods record
 * `model_call` events. Recognized methods: `generateText`, `embeddings`,
 * `textGeneration`, `featureExtraction`. Unknown shapes are returned unchanged.
 */
export function instrumentHuggingFace<T extends Record<string, any>>(
  client: T,
  options: HuggingFaceInstrumentationOptions = {},
): T {
  const wrapped = { ...client } as Record<string, any>;
  const methods = [
    "generateText",
    "embeddings",
    "textGeneration",
    "featureExtraction",
  ];

  for (const method of methods) {
    if (typeof client[method] === "function") {
      wrapped[method] = wrapInferenceMethod(
        client[method].bind(client),
        options,
      );
    }
  }

  return wrapped as T;
}
