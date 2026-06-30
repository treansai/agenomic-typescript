export type RunStatus = "running" | "success" | "error" | "cancelled";
export type RedactionMode = "remove" | "mask" | "hash";
export type ToolCallStatus = "ok" | "error";
export type MemoryOperation = "read" | "write" | "search" | "delete";
export type PolicyOutcome = "allow" | "deny" | "review";
export type HumanFeedbackDisposition = "approve" | "reject" | "escalate";

export interface ErrorInfo {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}

export interface RedactionRule {
  path: string;
  mode: RedactionMode;
}

export type RedactionInput = Array<string | RedactionRule>;

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface EventBase {
  id: string;
  traceId: string;
  runId: string;
  type: TraceEventType;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ModelCall extends EventBase {
  type: "model_call";
  provider: string;
  model: string;
  input?: unknown;
  output?: unknown;
  inputHash?: string;
  outputHash?: string;
  startedAt?: string;
  endedAt?: string;
  latencyMs?: number;
  usage?: TokenUsage;
  error?: ErrorInfo;
}

export interface ToolCall extends EventBase {
  type: "tool_call";
  toolName: string;
  input?: unknown;
  output?: unknown;
  inputHash?: string;
  outputHash?: string;
  startedAt?: string;
  endedAt?: string;
  latencyMs?: number;
  status?: ToolCallStatus;
  error?: ErrorInfo;
}

export interface MemoryAccess extends EventBase {
  type: "memory_access";
  store: string;
  operation: MemoryOperation;
  key?: string;
  query?: unknown;
  resultCount?: number;
}

export interface PolicyCheck extends EventBase {
  type: "policy_check";
  policyName: string;
  outcome: PolicyOutcome;
  detail?: string;
}

export interface HumanFeedback extends EventBase {
  type: "human_feedback";
  reviewerId?: string;
  rating?: number;
  comment?: string;
  disposition?: HumanFeedbackDisposition;
}

export interface RunCompleted extends EventBase {
  type: "run_completed";
  status: Exclude<RunStatus, "running">;
  output?: unknown;
  outputHash?: string;
  durationMs?: number;
  error?: ErrorInfo;
}

export type TraceEventType =
  | "model_call"
  | "tool_call"
  | "memory_access"
  | "policy_check"
  | "human_feedback"
  | "run_completed";

export type TraceEvent =
  | ModelCall
  | ToolCall
  | MemoryAccess
  | PolicyCheck
  | HumanFeedback
  | RunCompleted;

export interface AgentRun {
  traceId: string;
  runId: string;
  agentId: string;
  release?: string;
  sessionId?: string;
  parentRunId?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: RunStatus;
  input?: unknown;
  output?: unknown;
  inputHash?: string;
  outputHash?: string;
  error?: ErrorInfo;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface TraceRedaction {
  rules: RedactionRule[];
  appliedAt: string;
}

export interface TraceEnvelope {
  specVersion: string;
  generatedAt: string;
  run: AgentRun;
  events: TraceEvent[];
  metadata?: Record<string, unknown>;
  redaction?: TraceRedaction;
}

interface EventDraftBase {
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export type ModelCallDraft = EventDraftBase &
  Omit<ModelCall, "id" | "traceId" | "runId" | "timestamp">;
export type ToolCallDraft = EventDraftBase &
  Omit<ToolCall, "id" | "traceId" | "runId" | "timestamp">;
export type MemoryAccessDraft = EventDraftBase &
  Omit<MemoryAccess, "id" | "traceId" | "runId" | "timestamp">;
export type PolicyCheckDraft = EventDraftBase &
  Omit<PolicyCheck, "id" | "traceId" | "runId" | "timestamp">;
export type HumanFeedbackDraft = EventDraftBase &
  Omit<HumanFeedback, "id" | "traceId" | "runId" | "timestamp">;
export type RunCompletedDraft = EventDraftBase &
  Omit<RunCompleted, "id" | "traceId" | "runId" | "timestamp">;

export type TraceEventDraft =
  | ModelCallDraft
  | ToolCallDraft
  | MemoryAccessDraft
  | PolicyCheckDraft
  | HumanFeedbackDraft
  | RunCompletedDraft;

export interface CreateTraceInput {
  agentId: string;
  traceId?: string;
  runId?: string;
  release?: string;
  sessionId?: string;
  parentRunId?: string;
  startedAt?: string;
  input?: unknown;
  tags?: string[];
  metadata?: Record<string, unknown>;
  runMetadata?: Record<string, unknown>;
  redact?: RedactionInput;
  redactionMode?: RedactionMode;
}

export interface CompleteTraceInput {
  output?: unknown;
  status?: Exclude<RunStatus, "running">;
  error?: unknown;
}

export interface AgenomicClientOptions {
  apiKey?: string;
  /** Trace-ingestion endpoint (may include the `/v1/traces` path). */
  endpoint?: string;
  /**
   * API base URL for resource APIs (e.g. tracking), e.g.
   * `https://api.agenomic.example`. When omitted, the base is derived from
   * `endpoint` with a trailing `/v1/traces` stripped.
   */
  baseUrl?: string;
  headers?: Record<string, string>;
}

export interface TraceAgentRunOptions {
  client: {
    createTrace(input: CreateTraceInput): {
      complete(input?: CompleteTraceInput): unknown;
      fail(error: unknown, output?: unknown): unknown;
      emit(): Promise<TraceEnvelope>;
    };
  };
  agentId: string;
  release?: string;
  redact?: RedactionInput;
  redactionMode?: RedactionMode;
  localOnly?: boolean;
  metadata?: Record<string, unknown>;
  runMetadata?: Record<string, unknown>;
  tags?: string[];
}
