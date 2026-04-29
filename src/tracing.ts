import { AsyncLocalStorage } from "node:async_hooks";

import type {
  AgentRun,
  CompleteTraceInput,
  CreateTraceInput,
  HumanFeedbackDraft,
  MemoryAccessDraft,
  ModelCallDraft,
  PolicyCheckDraft,
  RedactionRule,
  RunCompletedDraft,
  ToolCallDraft,
  TraceAgentRunOptions,
  TraceEnvelope,
  TraceEvent,
  TraceEventDraft,
} from "./models";
import { redactTraceEnvelope } from "./redaction";
import { TraceEnvelopeSchema } from "./schemas";
import {
  SDK_METADATA,
  TRACE_SPEC_VERSION,
  cloneValue,
  createId,
  diffMilliseconds,
  maybeHash,
  normalizeError,
  nowIso,
} from "./utils";

interface TraceEmitter {
  emitTrace(trace: TraceEnvelope): Promise<void>;
}

interface TraceBuilderOptions extends CreateTraceInput {
  client?: TraceEmitter;
}

const activeTraceStorage = new AsyncLocalStorage<TraceBuilder>();

function normalizeEventDraftError(
  event: TraceEventDraft,
): ReturnType<typeof normalizeError> | undefined {
  if (!("error" in event) || event.error === undefined) {
    return undefined;
  }

  return normalizeError(event.error);
}

export function withTraceContext<T>(
  trace: TraceBuilder,
  handler: () => Promise<T>,
): Promise<T> {
  return activeTraceStorage.run(trace, handler);
}

export function getCurrentTrace(): TraceBuilder | undefined {
  return activeTraceStorage.getStore();
}

export class TraceBuilder {
  private readonly client?: TraceEmitter;
  private readonly redactionRules: RedactionRule[];
  private readonly redactionMode: CreateTraceInput["redactionMode"];
  private readonly envelopeMetadata?: Record<string, unknown>;
  private readonly events: TraceEvent[] = [];
  private finalized = false;
  private readonly runState: AgentRun;

  constructor(options: TraceBuilderOptions) {
    const traceId = options.traceId ?? createId("trace");
    const runId = options.runId ?? createId("run");
    const startedAt = options.startedAt ?? nowIso();

    this.client = options.client;
    this.redactionMode = options.redactionMode ?? "mask";
    this.redactionRules = (options.redact ?? []).map((entry) =>
      typeof entry === "string"
        ? { path: entry, mode: this.redactionMode ?? "mask" }
        : entry,
    );
    this.envelopeMetadata = {
      sdk: SDK_METADATA,
      ...cloneValue(options.metadata ?? {}),
    };
    this.runState = {
      traceId,
      runId,
      agentId: options.agentId,
      release: options.release,
      sessionId: options.sessionId,
      parentRunId: options.parentRunId,
      startedAt,
      status: "running",
      input: cloneValue(options.input),
      inputHash: maybeHash(options.input),
      tags: cloneValue(options.tags),
      metadata: cloneValue(options.runMetadata),
    };
  }

  get traceId(): string {
    return this.runState.traceId;
  }

  get runId(): string {
    return this.runState.runId;
  }

  get run(): AgentRun {
    return cloneValue(this.runState);
  }

  private assertOpen(): void {
    if (this.finalized) {
      throw new Error("Trace has already been finalized.");
    }
  }

  private materializeEvent(event: TraceEventDraft): TraceEvent {
    const timestamp =
      event.timestamp ??
      ("startedAt" in event && event.startedAt ? event.startedAt : nowIso());

    const latencyMs =
      "latencyMs" in event && event.latencyMs !== undefined
        ? event.latencyMs
        : "startedAt" in event && "endedAt" in event
          ? diffMilliseconds(event.startedAt, event.endedAt)
          : undefined;

    switch (event.type) {
      case "model_call":
        return {
          id: createId("evt"),
          traceId: this.runState.traceId,
          runId: this.runState.runId,
          timestamp,
          type: "model_call",
          provider: event.provider,
          model: event.model,
          input: cloneValue(event.input),
          output: cloneValue(event.output),
          inputHash: event.inputHash ?? maybeHash(event.input),
          outputHash: event.outputHash ?? maybeHash(event.output),
          startedAt: event.startedAt,
          endedAt: event.endedAt,
          latencyMs,
          usage: cloneValue(event.usage),
          metadata: cloneValue(event.metadata),
          error: normalizeEventDraftError(event),
        };
      case "tool_call":
        return {
          id: createId("evt"),
          traceId: this.runState.traceId,
          runId: this.runState.runId,
          timestamp,
          type: "tool_call",
          toolName: event.toolName,
          input: cloneValue(event.input),
          output: cloneValue(event.output),
          inputHash: event.inputHash ?? maybeHash(event.input),
          outputHash: event.outputHash ?? maybeHash(event.output),
          startedAt: event.startedAt,
          endedAt: event.endedAt,
          latencyMs,
          status: event.status ?? (event.error ? "error" : "ok"),
          metadata: cloneValue(event.metadata),
          error: normalizeEventDraftError(event),
        };
      case "memory_access":
        return {
          id: createId("evt"),
          traceId: this.runState.traceId,
          runId: this.runState.runId,
          timestamp,
          type: "memory_access",
          store: event.store,
          operation: event.operation,
          key: event.key,
          query: cloneValue(event.query),
          resultCount: event.resultCount,
          metadata: cloneValue(event.metadata),
        };
      case "policy_check":
        return {
          id: createId("evt"),
          traceId: this.runState.traceId,
          runId: this.runState.runId,
          timestamp,
          type: "policy_check",
          policyName: event.policyName,
          outcome: event.outcome,
          detail: event.detail,
          metadata: cloneValue(event.metadata),
        };
      case "human_feedback":
        return {
          id: createId("evt"),
          traceId: this.runState.traceId,
          runId: this.runState.runId,
          timestamp,
          type: "human_feedback",
          reviewerId: event.reviewerId,
          rating: event.rating,
          comment: event.comment,
          disposition: event.disposition,
          metadata: cloneValue(event.metadata),
        };
      case "run_completed":
        return {
          id: createId("evt"),
          traceId: this.runState.traceId,
          runId: this.runState.runId,
          timestamp,
          type: "run_completed",
          status: event.status,
          output: cloneValue(event.output),
          outputHash: event.outputHash ?? maybeHash(event.output),
          durationMs: event.durationMs,
          metadata: cloneValue(event.metadata),
          error: normalizeEventDraftError(event),
        };
    }
  }

  recordEvent(event: TraceEventDraft): TraceEvent {
    this.assertOpen();
    const materialized = this.materializeEvent(event);
    this.events.push(materialized);
    return cloneValue(materialized);
  }

  addEvent(event: TraceEventDraft): this {
    this.recordEvent(event);
    return this;
  }

  addModelCall(event: ModelCallDraft): this {
    return this.addEvent(event);
  }

  addToolCall(event: ToolCallDraft): this {
    return this.addEvent(event);
  }

  addMemoryAccess(event: MemoryAccessDraft): this {
    return this.addEvent(event);
  }

  addPolicyCheck(event: PolicyCheckDraft): this {
    return this.addEvent(event);
  }

  addHumanFeedback(event: HumanFeedbackDraft): this {
    return this.addEvent(event);
  }

  complete(input: CompleteTraceInput = {}): this {
    this.assertOpen();
    this.finalized = true;

    const endedAt = nowIso();
    const status = input.status ?? (input.error ? "error" : "success");
    this.runState.endedAt = endedAt;
    this.runState.durationMs = diffMilliseconds(this.runState.startedAt, endedAt);
    this.runState.status = status;
    this.runState.output = cloneValue(input.output);
    this.runState.outputHash = maybeHash(input.output);
    this.runState.error = input.error ? normalizeError(input.error) : undefined;

    const completionEvent: RunCompletedDraft = {
      type: "run_completed",
      timestamp: endedAt,
      status,
      output: cloneValue(input.output),
      outputHash: maybeHash(input.output),
      durationMs: this.runState.durationMs,
      error: input.error ? normalizeError(input.error) : undefined,
    };

    this.events.push(this.materializeEvent(completionEvent));
    return this;
  }

  fail(error: unknown, output?: unknown): this {
    return this.complete({
      status: "error",
      output,
      error,
    });
  }

  build(): TraceEnvelope {
    const envelope: TraceEnvelope = {
      specVersion: TRACE_SPEC_VERSION,
      generatedAt: nowIso(),
      run: cloneValue(this.runState),
      events: cloneValue(this.events),
      metadata: cloneValue(this.envelopeMetadata),
    };

    const redacted =
      this.redactionRules.length > 0
        ? redactTraceEnvelope(
            envelope,
            this.redactionRules,
            this.redactionMode ?? "mask",
          )
        : envelope;

    return TraceEnvelopeSchema.parse(redacted);
  }

  async emit(): Promise<TraceEnvelope> {
    const trace = this.build();
    if (this.client) {
      await this.client.emitTrace(trace);
    }
    return trace;
  }
}

export function traceAgentRun<TInput, TOutput>(
  options: TraceAgentRunOptions,
  handler: (payload: TInput, trace: TraceBuilder) => Promise<TOutput> | TOutput,
): (payload: TInput) => Promise<TOutput> {
  return async (payload: TInput): Promise<TOutput> => {
    const trace = options.client.createTrace({
      agentId: options.agentId,
      release: options.release,
      input: payload,
      metadata: options.metadata,
      runMetadata: options.runMetadata,
      tags: options.tags,
      redact: options.redact,
      redactionMode: options.redactionMode,
    }) as TraceBuilder;

    try {
      const result = await withTraceContext(trace, async () =>
        Promise.resolve(handler(payload, trace)),
      );
      trace.complete({ output: result, status: "success" });

      if (!options.localOnly) {
        await trace.emit();
      }

      return result;
    } catch (error) {
      trace.fail(error);

      if (!options.localOnly) {
        await trace.emit();
      }

      throw error;
    }
  };
}
