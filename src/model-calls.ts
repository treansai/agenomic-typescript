import type { InvocationPhase, ProtectDecision, SignedPermit, ToolsResource } from "./tools";

export type ModelToolChoice = "auto" | "none" | "required" | "tool" | "unspecified";

export interface ModelCost {
  amountMinor: number;
  currency: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * What the runtime declares before a model call. Every value is the runtime's
 * word: the gateway never sees the prompt and never observes the call. There is
 * deliberately no field for prompt or message text.
 */
export interface ModelCallRequest {
  logicalCallId: string;
  provider: string;
  model: string;
  maxOutputTokens: number;
  estimatedInputTokens: number;
  repetition?: number;
  attempt?: number;
  endpointHost?: string;
  estimatedCost?: ModelCost;
  dataClassification?: string[];
  toolChoice?: ModelToolChoice;
  toolChoiceName?: string;
  tools?: string[];
  stream?: boolean;
  parentCallId?: string;
  deadlineMs?: number;
}

export interface ModelCallReportInput {
  logicalCallId: string;
  provider: string;
  model: string;
  permit: SignedPermit;
  repetition?: number;
  attempt?: number;
  usage?: ModelUsage;
  isError?: boolean;
  durationMs?: number;
}

interface ModelCallDecisionBase {
  tool: string;
  recordId: string;
  phase?: InvocationPhase;
  protect?: ProtectDecision;
}

export interface ModelCallAllowed extends ModelCallDecisionBase {
  decision: "allow";
  permit: SignedPermit;
}

export interface ModelCallPendingApproval extends ModelCallDecisionBase {
  decision: "pending";
  approvalId: string;
}

export interface ModelCallRefused extends ModelCallDecisionBase {
  decision: "denied";
}

/** Typed answer of `model-calls/authorize`: 200 allow, 202 pending, 403 denied. */
export type ModelCallDecision = ModelCallAllowed | ModelCallPendingApproval | ModelCallRefused;

/** Admission refused a model call; the provider was not called. */
export class ModelCallDenied extends Error {
  constructor(
    readonly tool: string,
    readonly decision: ModelCallRefused,
  ) {
    super(`model call ${tool} denied${decision.protect?.reason_codes?.length ? `: ${decision.protect.reason_codes.join(",")}` : ""}`);
    this.name = "ModelCallDenied";
  }

  get reasonCodes(): string[] {
    return this.decision.protect?.reason_codes ?? [];
  }
}

/**
 * The model call waits for an approval; the provider was not called. After the
 * reviewer decides, run the same guarded call again with the same identity and
 * the same request.
 */
export class ModelCallPending extends Error {
  constructor(
    readonly tool: string,
    readonly decision: ModelCallPendingApproval,
  ) {
    super(`model call ${tool} waits for approval ${decision.approvalId}`);
    this.name = "ModelCallPending";
  }

  get approvalId(): string {
    return this.decision.approvalId;
  }
}

const MAX_DURATION_MS = 3_600_000;

export interface GuardModelCallOptions<T> {
  /** Extracts the real usage from the provider result so the report carries it. */
  usage?: (result: T) => ModelUsage | undefined;
}

/**
 * Cooperative wrapper: authorize, run `call` only on allow, then report with the
 * permit. A throwing `call` is reported as an error and rethrown unchanged. The
 * gateway cannot stop a runtime that calls a provider without going through
 * this wrapper, or that declares other values than it uses.
 */
export async function guardModelCall<T>(
  tools: ToolsResource,
  runId: string,
  request: ModelCallRequest,
  call: () => Promise<T>,
  options: GuardModelCallOptions<T> = {},
): Promise<T> {
  const decision = await tools.authorizeModelCall(runId, request);
  if (decision.decision === "denied") throw new ModelCallDenied(decision.tool, decision);
  if (decision.decision === "pending") throw new ModelCallPending(decision.tool, decision);
  const identity = {
    logicalCallId: request.logicalCallId,
    provider: request.provider,
    model: request.model,
    permit: decision.permit,
    ...(request.repetition !== undefined ? { repetition: request.repetition } : {}),
    ...(request.attempt !== undefined ? { attempt: request.attempt } : {}),
  };
  const started = Date.now();
  const elapsed = () => Math.min(Date.now() - started, MAX_DURATION_MS);
  let result: T;
  try {
    result = await call();
  } catch (error) {
    await tools.reportModelCall(runId, { ...identity, isError: true, durationMs: elapsed() }).catch(() => undefined);
    throw error;
  }
  const usage = options.usage?.(result);
  await tools.reportModelCall(runId, { ...identity, durationMs: elapsed(), ...(usage ? { usage } : {}) });
  return result;
}
