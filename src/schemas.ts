import { z } from "zod";

const metadataSchema = z.record(z.unknown());

export const RunStatusSchema = z.enum([
  "running",
  "success",
  "error",
  "cancelled",
]);
export const RedactionModeSchema = z.enum(["remove", "mask", "hash"]);
export const ToolCallStatusSchema = z.enum(["ok", "error"]);
export const MemoryOperationSchema = z.enum([
  "read",
  "write",
  "search",
  "delete",
]);
export const PolicyOutcomeSchema = z.enum(["allow", "deny", "review"]);
export const HumanFeedbackDispositionSchema = z.enum([
  "approve",
  "reject",
  "escalate",
]);

export const ErrorInfoSchema = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  code: z.string().optional(),
});

export const RedactionRuleSchema = z.object({
  path: z.string().min(1),
  mode: RedactionModeSchema,
});

export const TokenUsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
});

export const EventBaseSchema = z.object({
  id: z.string().min(1),
  traceId: z.string().min(1),
  runId: z.string().min(1),
  type: z.string().min(1),
  timestamp: z.string().datetime(),
  metadata: metadataSchema.optional(),
});

export const ModelCallSchema = EventBaseSchema.extend({
  type: z.literal("model_call"),
  provider: z.string().min(1),
  model: z.string().min(1),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  inputHash: z.string().min(1).optional(),
  outputHash: z.string().min(1).optional(),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  latencyMs: z.number().nonnegative().optional(),
  usage: TokenUsageSchema.optional(),
  error: ErrorInfoSchema.optional(),
});

export const ToolCallSchema = EventBaseSchema.extend({
  type: z.literal("tool_call"),
  toolName: z.string().min(1),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  inputHash: z.string().min(1).optional(),
  outputHash: z.string().min(1).optional(),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  latencyMs: z.number().nonnegative().optional(),
  status: ToolCallStatusSchema.optional(),
  error: ErrorInfoSchema.optional(),
});

export const MemoryAccessSchema = EventBaseSchema.extend({
  type: z.literal("memory_access"),
  store: z.string().min(1),
  operation: MemoryOperationSchema,
  key: z.string().optional(),
  query: z.unknown().optional(),
  resultCount: z.number().int().nonnegative().optional(),
});

export const PolicyCheckSchema = EventBaseSchema.extend({
  type: z.literal("policy_check"),
  policyName: z.string().min(1),
  outcome: PolicyOutcomeSchema,
  detail: z.string().optional(),
});

export const HumanFeedbackSchema = EventBaseSchema.extend({
  type: z.literal("human_feedback"),
  reviewerId: z.string().optional(),
  rating: z.number().min(0).max(5).optional(),
  comment: z.string().optional(),
  disposition: HumanFeedbackDispositionSchema.optional(),
});

export const RunCompletedSchema = EventBaseSchema.extend({
  type: z.literal("run_completed"),
  status: z.enum(["success", "error", "cancelled"]),
  output: z.unknown().optional(),
  outputHash: z.string().min(1).optional(),
  durationMs: z.number().nonnegative().optional(),
  error: ErrorInfoSchema.optional(),
});

export const TraceEventSchema = z.discriminatedUnion("type", [
  ModelCallSchema,
  ToolCallSchema,
  MemoryAccessSchema,
  PolicyCheckSchema,
  HumanFeedbackSchema,
  RunCompletedSchema,
]);

export const AgentRunSchema = z.object({
  traceId: z.string().min(1),
  runId: z.string().min(1),
  agentId: z.string().min(1),
  release: z.string().optional(),
  sessionId: z.string().optional(),
  parentRunId: z.string().optional(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  durationMs: z.number().nonnegative().optional(),
  status: RunStatusSchema,
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  inputHash: z.string().min(1).optional(),
  outputHash: z.string().min(1).optional(),
  error: ErrorInfoSchema.optional(),
  tags: z.array(z.string()).optional(),
  metadata: metadataSchema.optional(),
});

export const TraceRedactionSchema = z.object({
  rules: z.array(RedactionRuleSchema),
  appliedAt: z.string().datetime(),
});

export const TraceEnvelopeSchema = z.object({
  specVersion: z.string().min(1),
  generatedAt: z.string().datetime(),
  run: AgentRunSchema,
  events: z.array(TraceEventSchema),
  metadata: metadataSchema.optional(),
  redaction: TraceRedactionSchema.optional(),
});
