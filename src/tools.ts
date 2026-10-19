// Tool execution for replays: the Tool Gateway client and a lightweight
// router. The runtime keeps its own orchestration; each tool call is posted
// as a normalized invocation and the cloud routes it to a real backend (with
// server-side credentials) or to the Tool Mock Engine according to the run's
// explicit per-tool bindings. Nothing here ever falls back to a real call.

import { randomUUID } from "node:crypto";

import type { AgenomicClient } from "./client";
import {
  guardModelCall,
  ModelCallDenied,
  ModelCallPending,
  type GuardModelCallOptions,
  type ModelCallDecision,
  type ModelCallReportInput,
  type ModelCallRequest,
} from "./model-calls";
import type { VaultExecuteInput, VaultExecuteResult, VaultExecutionStatus } from "./vault/types";

export const TOOL_EXECUTION_SCHEMA_VERSION = "agenomic.tool_execution/v1";

export type ToolBindingMode = "mock" | "live";
export type ToolExecutionMode = "mock" | "live" | "hybrid";
export type ToolResultSource =
  | "live"
  | "recorded"
  | "static"
  | "scenario"
  | "schema_generated"
  | "plugin"
  | "runtime_local"
  | "unrouted";
export type ToolInvocationStatus = "success" | "error" | "aborted" | "timeout" | "pending" | "denied";
export type ToolExternalState = "none" | "confirmed" | "indeterminate";
export type ProtectOutcome = "allow" | "deny" | "require_approval" | "pause" | "transform_proposal";
export type ProtectEffectiveMode = "enforce" | "shadow";
export type InvocationPhase =
  | "received"
  | "admission_pending"
  | "approval_pending"
  | "denied"
  | "authorized"
  | "dispatching"
  | "succeeded"
  | "failed"
  | "outcome_unknown";
export type EntitlementState = "entitled" | "not_entitled" | "unknown";
export type RequirementSource = "mandatory_org" | "binding" | "run_binding";
export type ProtectionDenial =
  | "protect_required:mandatory_org"
  | "protect_required:binding"
  | "protect_required:run_binding"
  | "kill_switch"
  | "restriction_active"
  | "capability_denied"
  | "protect_state_unavailable";
export type EffectiveState = "not_applicable" | "enforced" | "shadow" | "exempt" | "none" | "blocked" | "unknown";

export interface ExemptionRef {
  id: string;
  scope_kind: string;
  scope_ref: string;
  expires_at: string;
}

/** What protects a run right now; only `state === "enforced"` means protected. */
export interface EffectiveProtection {
  entitlement: EntitlementState;
  org_mandatory: boolean;
  requirement?: RequirementSource;
  run_mode: string;
  protect_block: boolean;
  protect_mode?: ProtectEffectiveMode;
  exemption?: ExemptionRef;
  denial?: ProtectionDenial;
  state: EffectiveState;
}

/** Durable state of one invocation (mirror of `InvocationStatusResponse`). */
export interface InvocationStatus {
  record_id: string;
  run_id: string;
  phase: InvocationPhase;
  status: ToolInvocationStatus;
  external_state: ToolExternalState;
  tool: string;
  logical_call_id: string;
  repetition: number;
  attempt: number;
  error_code?: string;
  requires_reconciliation: boolean;
  protect?: ProtectDecision;
  approval_id?: string;
  reconciliation?: Record<string, unknown>;
  started_at: string;
  phase_at?: string;
}

export type InvocationResolution = "succeeded" | "failed" | "not_executed";

export type ConflictReason = "in_flight" | "ambiguous_outcome" | "already_recorded" | "attempt_in_flight";

/** Admission stamp on an invocation (mirror of `InvocationDecision`). */
export interface ProtectDecision {
  decision_id: string;
  outcome: ProtectOutcome;
  effective_mode: ProtectEffectiveMode;
  reason_codes: string[];
  approval_id?: string;
  permit_ref?: string;
  policy_snapshot_digest: string;
  evaluated_at: string;
}

export interface TransformationProposal {
  kind: string;
  fields?: string[];
  proposed_arguments_hash?: string;
  note?: string;
}

/** Signed runtime-local permit; opaque to the SDK and forwarded verbatim. */
export interface SignedPermit {
  document: Record<string, unknown>;
  signature: Record<string, unknown>;
}

export interface ToolProvenance {
  source: ToolResultSource;
  fidelity: string;
  binding_mode: ToolBindingMode;
  adapter?: string;
  strategy?: string;
  fixture_id?: string;
  rule_id?: string;
  destination_host?: string;
  fault_campaign_ref?: string;
  note?: string;
}

export interface ToolCallEnvelope {
  record_id: string;
  status: ToolInvocationStatus;
  provenance: ToolProvenance;
  external_state: ToolExternalState;
  effects: Array<{ class: string; description: string; simulated: boolean }>;
  duration_ms: number;
  virtual_time?: string;
  expected_error: boolean;
  /** False when a local function ran but its report never reached the gateway. */
  reported?: boolean;
  protect?: ProtectDecision;
  approval_id?: string;
  decision?: string;
  transformation?: TransformationProposal;
  safe_explanation?: string;
  phase?: InvocationPhase;
}

/** Native tool result plus the Agenomic technical envelope; `result` is null when denied or pending. */
export interface ToolCallResult<T = unknown> {
  result: T | null;
  agenomic: ToolCallEnvelope;
}

export interface ToolExecutionConfigInput {
  config?: Record<string, unknown>;
  configText?: string;
  repetitions?: number;
}

export interface CreateToolRunOptions extends ToolExecutionConfigInput {
  name?: string;
  replayJobId?: string;
  rmpSessionId?: string;
}

export interface InvokeOptions {
  logicalCallId?: string;
  repetition?: number;
  attempt?: number;
  parentCallId?: string;
  deadlineMs?: number;
}

export type LocalAuthorizationDecision = "local" | "gateway" | "pending" | "denied";

export interface LocalAuthorization {
  decision: LocalAuthorizationDecision;
  recordId?: string;
  approvalId?: string;
  permit?: SignedPermit;
  protect?: ProtectDecision;
  phase?: InvocationPhase;
}

/** The call identity handed to `beforeAction` before any request leaves the process. */
export interface ToolActionIntent {
  runId: string;
  tool: string;
  arguments: Record<string, unknown>;
  logicalCallId: string;
  repetition: number;
  attempt: number;
  parentCallId?: string;
  executionPoint: "runtime_local" | "gateway";
}

/** A tool-execution API call was refused; `code` is the server error code. */
export class ToolExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(`${code}: ${message}`);
    this.name = "ToolExecutionError";
  }
}

/** The tool answered with an error outcome (business, protocol, timeout). */
export class ToolCallError extends Error {
  readonly code: string;

  constructor(
    readonly tool: string,
    readonly envelope: ToolCallResult,
  ) {
    const detail = (envelope.result as { error?: { code?: string } } | null)?.error;
    const code = detail?.code ?? envelope.agenomic.status;
    super(`tool ${tool} returned ${envelope.agenomic.status} (${code})`);
    this.name = "ToolCallError";
    this.code = String(code);
  }
}

/**
 * HTTP 409 on a call that cannot be started or answered again. Two forms:
 * the identity itself is already recorded (`reason` is `in_flight`,
 * `ambiguous_outcome` or `already_recorded`, stored state on `invocation`,
 * `code` is `conflict`), or another attempt of the same logical call is
 * unresolved (`reason` is `attempt_in_flight` or `ambiguous_outcome`, no
 * `invocation`, `code` equals `reason`). Nothing was executed again.
 */
export class ToolCallConflict extends ToolExecutionError {
  constructor(
    readonly reason: ConflictReason,
    message: string,
    readonly invocation?: InvocationStatus,
    readonly requestId?: string,
    code = "conflict",
  ) {
    super(code, message, 409);
    this.name = "ToolCallConflict";
  }

  get inFlight(): boolean {
    return this.reason === "in_flight" || this.reason === "attempt_in_flight";
  }

  get ambiguous(): boolean {
    return this.reason === "ambiguous_outcome";
  }

  /** True when the conflict comes from another attempt of the same logical call, not from this identity. */
  get otherAttempt(): boolean {
    return this.invocation === undefined;
  }
}

const CONFLICT_REASONS: ReadonlySet<string> = new Set(["in_flight", "ambiguous_outcome", "already_recorded"]);
const ATTEMPT_CONFLICT_CODES: ReadonlySet<string> = new Set(["attempt_in_flight", "ambiguous_outcome"]);

/** Admission refused the call (403 `policy_denied`, transform proposal, rejected or expired approval); nothing ran. */
export class ToolCallDenied extends ToolExecutionError {
  constructor(
    readonly tool: string,
    readonly envelope: ToolCallResult,
    code = "policy_denied",
    status = 403,
  ) {
    const agenomic = envelope.agenomic;
    const reasons = agenomic.protect?.reason_codes?.join(",") ?? "";
    super(code, agenomic.safe_explanation ?? `tool ${tool} denied${reasons ? ` (${reasons})` : ""}`, status);
    this.name = "ToolCallDenied";
  }

  get decision(): ProtectDecision | undefined {
    return this.envelope.agenomic.protect;
  }

  get transformation(): TransformationProposal | undefined {
    return this.envelope.agenomic.transformation;
  }
}

/** Admission requires a human approval (HTTP 202); resume with `router.resume`. */
export class ToolApprovalPending extends ToolExecutionError {
  constructor(
    readonly tool: string,
    readonly approvalId: string,
    readonly recordId: string,
    readonly envelope: ToolCallResult,
  ) {
    super("approval_pending", `tool ${tool} awaits approval ${approvalId}`, 202);
    this.name = "ToolApprovalPending";
  }

  get decision(): ProtectDecision | undefined {
    return this.envelope.agenomic.protect;
  }
}

export function apiBase(client: AgenomicClient): string | undefined {
  const raw = client.baseUrl ?? client.endpoint;
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "").replace(/\/v1\/traces$/, "");
}

export type JsonMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface JsonExchange {
  status: number;
  body: Record<string, unknown> | undefined;
  headers?: Headers;
}

/** One HTTP exchange against the API root; only transport faults throw. */
export async function fetchJson(
  client: AgenomicClient,
  method: JsonMethod,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<JsonExchange> {
  return exchange(
    client,
    method,
    path,
    body !== undefined ? { body: JSON.stringify(body), contentType: "application/json" } : undefined,
    extraHeaders,
  );
}

/** One HTTP exchange that sends a raw body (document uploads); only transport faults throw. */
export async function fetchRaw(
  client: AgenomicClient,
  method: JsonMethod,
  path: string,
  body: Uint8Array<ArrayBuffer>,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): Promise<JsonExchange> {
  return exchange(client, method, path, { body, contentType }, extraHeaders);
}

async function exchange(
  client: AgenomicClient,
  method: JsonMethod,
  path: string,
  payload: { body: string | Uint8Array<ArrayBuffer>; contentType: string } | undefined,
  extraHeaders: Record<string, string>,
): Promise<JsonExchange> {
  const base = apiBase(client);
  if (!base) {
    throw new ToolExecutionError(
      "cloud_required",
      "this call requires a baseUrl on the client; there is no local fallback",
      0,
    );
  }
  let response: Response;
  try {
    response = await fetch(base + path, {
      method,
      headers: {
        ...(payload !== undefined ? { "content-type": payload.contentType } : {}),
        ...(client.apiKey ? { authorization: `Bearer ${client.apiKey}` } : {}),
        ...client.headers,
        ...extraHeaders,
      },
      ...(payload !== undefined ? { body: payload.body } : {}),
    });
  } catch (error) {
    throw new ToolExecutionError("transport_error", `${method} ${path} failed: ${String(error)}`, 0);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new ToolExecutionError("transport_error", `${method} ${path} body read failed: ${String(error)}`, response.status);
  }
  let parsed: Record<string, unknown> | undefined;
  try {
    const value: unknown = text ? JSON.parse(text) : undefined;
    parsed = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

/** Turns a non-2xx `{ error: { code, message } }` or a non-JSON body into a typed error. */
export function acceptJson(method: JsonMethod, path: string, exchange: JsonExchange): Record<string, unknown> {
  if (exchange.status < 200 || exchange.status >= 300) {
    const error = (exchange.body?.error ?? {}) as { code?: string; message?: string; reason?: string; request_id?: string };
    const invocation = exchange.body?.agenomic as InvocationStatus | undefined;
    if (exchange.status === 409) {
      const message = error.message ?? `${method} ${path} returned 409`;
      if (error.reason && CONFLICT_REASONS.has(error.reason) && invocation && typeof invocation === "object") {
        throw new ToolCallConflict(error.reason as ConflictReason, message, invocation, error.request_id);
      }
      if (error.reason === undefined && invocation === undefined && error.code && ATTEMPT_CONFLICT_CODES.has(error.code)) {
        const prefix = `${error.code}: `;
        throw new ToolCallConflict(error.code as ConflictReason, message.startsWith(prefix) ? message.slice(prefix.length) : message, undefined, error.request_id, error.code);
      }
    }
    throw new ToolExecutionError(
      error.code ?? "http_error",
      error.message ?? `${method} ${path} returned ${exchange.status}`,
      exchange.status,
    );
  }
  if (exchange.body === undefined) {
    throw new ToolExecutionError("invalid_response", `${method} ${path} returned a non-JSON body`, exchange.status);
  }
  return exchange.body;
}

export async function requestJson(
  client: AgenomicClient,
  method: JsonMethod,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  return acceptJson(method, path, await fetchJson(client, method, path, body, extraHeaders));
}

function readEnvelope(body: Record<string, unknown> | undefined): ToolCallEnvelope | undefined {
  const envelope = body?.agenomic as ToolCallEnvelope | undefined;
  return envelope && typeof envelope.record_id === "string" ? envelope : undefined;
}

function readDecision(body: Record<string, unknown>): Omit<LocalAuthorization, "decision"> {
  const permit = body.permit;
  const protect = body.protect;
  return {
    ...(typeof body.phase === "string" ? { phase: body.phase as InvocationPhase } : {}),
    ...(body.record_id !== undefined ? { recordId: String(body.record_id) } : {}),
    ...(body.approval_id !== undefined ? { approvalId: String(body.approval_id) } : {}),
    ...(permit !== null && typeof permit === "object" ? { permit: permit as SignedPermit } : {}),
    ...(protect !== null && typeof protect === "object" ? { protect: protect as ProtectDecision } : {}),
  };
}

function invocationStatus(res: Record<string, unknown>): InvocationStatus {
  if (typeof res.record_id !== "string" || typeof res.phase !== "string") {
    throw new ToolExecutionError("invalid_response", "invocation response carries no record_id and phase", 0);
  }
  return res as unknown as InvocationStatus;
}

function readModelDecision(body: Record<string, unknown>): ModelCallDecision {
  const invalid = (what: string) => new ToolExecutionError("invalid_response", `model-calls/authorize ${what}`, 0);
  if (typeof body.record_id !== "string" || typeof body.tool !== "string") throw invalid("carries no record_id and tool");
  const common = {
    tool: body.tool,
    recordId: body.record_id,
    ...(typeof body.phase === "string" ? { phase: body.phase as InvocationPhase } : {}),
    ...(body.protect !== null && typeof body.protect === "object" ? { protect: body.protect as ProtectDecision } : {}),
  };
  if (body.decision === "allow") {
    if (body.permit === null || typeof body.permit !== "object") throw invalid("allowed the call without a permit; refusing to call the provider");
    return { decision: "allow", ...common, permit: body.permit as SignedPermit };
  }
  if (body.decision === "pending") {
    if (typeof body.approval_id !== "string") throw invalid("answered pending without an approval_id");
    return { decision: "pending", ...common, approvalId: body.approval_id };
  }
  if (body.decision === "denied") return { decision: "denied", ...common };
  throw invalid(`answered an unknown decision ${String(body.decision)}`);
}

function runRecord(res: Record<string, unknown>): Record<string, unknown> {
  const run = (res.run ?? {}) as Record<string, unknown>;
  return res.protection !== null && typeof res.protection === "object" ? { ...run, protection: res.protection } : run;
}

function configBody(input: ToolExecutionConfigInput): Record<string, unknown> {
  if ((input.config === undefined) === (input.configText === undefined)) {
    throw new Error("provide exactly one of config or configText");
  }
  return {
    repetitions: input.repetitions ?? 1,
    ...(input.config !== undefined ? { config: input.config } : { config_text: input.configText }),
  };
}

async function stableKey(parts: string[]): Promise<string> {
  const data = new TextEncoder().encode(parts.join(":"));
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return `agm-tool-${parts.join("-")}`;
  const digest = await subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `agm-tool-${hex.slice(0, 32)}`;
}

/** The `client.tools` namespace. Cloud mode only; no local fallback. */
export class ToolsResource {
  readonly schemaVersion = TOOL_EXECUTION_SCHEMA_VERSION;

  constructor(readonly client: AgenomicClient) {}

  private request(
    method: JsonMethod,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    return requestJson(this.client, method, path, body, extraHeaders);
  }

  async createProfile(options: { name: string; environment?: string; allowedEnv?: string[] }) {
    return this.request("POST", "/v1/tool-execution/profiles", {
      name: options.name,
      environment: options.environment ?? "dev",
      allowed_env: options.allowedEnv ?? [],
    });
  }

  async listProfiles(): Promise<Record<string, unknown>[]> {
    const res = await this.request("GET", "/v1/tool-execution/profiles");
    return Array.isArray(res.profiles) ? (res.profiles as Record<string, unknown>[]) : [];
  }

  /** Write-only: the value is encrypted server-side and never returned. */
  async setVariable(profileId: string, name: string, value: string) {
    return this.request("PUT", `/v1/tool-execution/profiles/${profileId}/variables/${name}`, { value });
  }

  /** Availability per allowed variable; never carries values. */
  async variableStatus(profileId: string): Promise<Record<string, unknown>[]> {
    const res = await this.request("GET", `/v1/tool-execution/profiles/${profileId}`);
    return Array.isArray(res.variables) ? (res.variables as Record<string, unknown>[]) : [];
  }

  async createFixtureSet(options: { name: string; version: number; fixtures: Record<string, unknown>[] }) {
    return this.request("POST", "/v1/tool-execution/fixture-sets", options);
  }

  async approveFixtureSet(fixtureSetId: string) {
    return this.request("POST", `/v1/tool-execution/fixture-sets/${fixtureSetId}/approve`, {});
  }

  async createScenario(options: {
    name: string;
    version: number;
    entities: Record<string, unknown>;
    tools: Record<string, unknown>;
    initialState?: Record<string, unknown>;
  }) {
    return this.request("POST", "/v1/tool-execution/scenarios", {
      name: options.name,
      version: options.version,
      entities: options.entities,
      tools: options.tools,
      initial_state: options.initialState ?? {},
    });
  }

  async adapters() {
    return this.request("GET", "/v1/tool-execution/adapters");
  }

  async validate(input: ToolExecutionConfigInput) {
    return this.request("POST", "/v1/tool-execution/validate", configBody(input));
  }

  /** Immutable plan with its `plan_hash`; an approval binds to that hash. */
  async preflight(input: ToolExecutionConfigInput) {
    return this.request("POST", "/v1/tool-execution/preflight", configBody(input));
  }

  async testMock(options: {
    tool: string;
    binding: Record<string, unknown>;
    arguments?: Record<string, unknown>;
    occurrence?: number;
    seed?: number;
    priorState?: Record<string, unknown>;
  }) {
    return this.request("POST", "/v1/tool-execution/mock/test", {
      tool: options.tool,
      binding: options.binding,
      arguments: options.arguments ?? {},
      occurrence: options.occurrence ?? 1,
      seed: options.seed ?? 0,
      ...(options.priorState ? { prior_state: options.priorState } : {}),
    });
  }

  async createRun(options: CreateToolRunOptions): Promise<Record<string, unknown>> {
    const res = await this.request("POST", "/v1/tool-execution/runs", {
      ...configBody(options),
      name: options.name ?? "tool run",
      ...(options.replayJobId ? { replay_job_id: options.replayJobId } : {}),
      ...(options.rmpSessionId ? { rmp_session_id: options.rmpSessionId } : {}),
    });
    return runRecord(res);
  }

  async getRun(runId: string): Promise<Record<string, unknown>> {
    const res = await this.request("GET", `/v1/tool-execution/runs/${runId}`);
    return runRecord(res);
  }

  async approveRun(runId: string, planHash: string): Promise<Record<string, unknown>> {
    const res = await this.request("POST", `/v1/tool-execution/runs/${runId}/approve`, { plan_hash: planHash });
    return runRecord(res);
  }

  async startRun(runId: string): Promise<Record<string, unknown>> {
    const res = await this.request("POST", `/v1/tool-execution/runs/${runId}/start`, {});
    return runRecord(res);
  }

  async cancelRun(runId: string): Promise<Record<string, unknown>> {
    const res = await this.request("POST", `/v1/tool-execution/runs/${runId}/cancel`, {});
    return runRecord(res);
  }

  async completeRun(runId: string, options: { failed?: boolean; errorMessage?: string } = {}) {
    const res = await this.request("POST", `/v1/tool-execution/runs/${runId}/complete`, {
      failed: options.failed ?? false,
      ...(options.errorMessage ? { error_message: options.errorMessage } : {}),
    });
    return runRecord(res);
  }

  async report(runId: string) {
    return this.request("GET", `/v1/tool-execution/runs/${runId}/report`);
  }

  async exportRun(runId: string) {
    return this.request("GET", `/v1/tool-execution/runs/${runId}/export`);
  }

  /** Route one tool call through the Tool Gateway. */
  async invoke<T = unknown>(
    runId: string,
    tool: string,
    args: Record<string, unknown> = {},
    options: InvokeOptions = {},
  ): Promise<ToolCallResult<T>> {
    const repetition = options.repetition ?? 1;
    const logicalCallId = options.logicalCallId ?? `call_${randomUUID().replace(/-/g, "")}`;
    const path = `/v1/tool-execution/runs/${runId}/invoke`;
    const headers: Record<string, string> = {
      "idempotency-key": await stableKey([runId, String(repetition), logicalCallId]),
    };
    const exchange = await fetchJson(
      this.client,
      "POST",
      path,
      {
        repetition,
        logical_call_id: logicalCallId,
        attempt: options.attempt ?? 1,
        tool,
        arguments: args,
        ...(options.parentCallId ? { parent_call_id: options.parentCallId } : {}),
        ...(options.deadlineMs !== undefined ? { deadline_ms: options.deadlineMs } : {}),
      },
      headers,
    );
    if (exchange.status === 403) {
      const denied = readEnvelope(exchange.body);
      if (denied) throw new ToolCallDenied(tool, { result: null, agenomic: { ...denied, status: "denied" } });
    }
    const res = acceptJson("POST", path, exchange);
    const envelope = readEnvelope(res);
    if (!envelope) {
      throw new ToolExecutionError("invalid_response", "invoke response did not include an agenomic envelope", 0);
    }
    if (exchange.status === 202 || envelope.status === "pending") {
      return { result: null, agenomic: { ...envelope, status: "pending" } };
    }
    return { result: res.result as T, agenomic: envelope };
  }

  /**
   * Ask the gateway whether a local function may run for this call. `local`
   * reserves budget, records a pending invocation and carries the permit;
   * `gateway` means the run binds the tool to a mock or a non-local adapter and
   * `invoke` must be used; `pending` awaits an approval; anything else is
   * `denied`. Refusals never execute anything.
   */
  async authorizeLocal(
    runId: string,
    tool: string,
    args: Record<string, unknown>,
    options: InvokeOptions & { logicalCallId: string },
  ): Promise<LocalAuthorization> {
    const path = `/v1/tool-execution/runs/${runId}/local/authorize`;
    const exchange = await fetchJson(this.client, "POST", path, {
      repetition: options.repetition ?? 1,
      logical_call_id: options.logicalCallId,
      attempt: options.attempt ?? 1,
      tool,
      arguments: args,
      ...(options.parentCallId ? { parent_call_id: options.parentCallId } : {}),
    });
    if (exchange.status === 403 && exchange.body && ("decision" in exchange.body || exchange.body.protect !== undefined)) {
      return { decision: "denied", ...readDecision(exchange.body) };
    }
    const res = acceptJson("POST", path, exchange);
    const decision = res.decision === "local" || res.decision === "gateway" || res.decision === "pending" ? res.decision : "denied";
    return { decision, ...readDecision(res) };
  }

  /** Settle a call previously accepted by `authorizeLocal`, presenting its permit. */
  async reportLocal(
    runId: string,
    tool: string,
    args: Record<string, unknown>,
    result: unknown,
    options: InvokeOptions & { logicalCallId: string; isError?: boolean; durationMs?: number; permit?: SignedPermit },
  ): Promise<string> {
    const res = await this.request("POST", `/v1/tool-execution/runs/${runId}/report-local`, {
      repetition: options.repetition ?? 1,
      logical_call_id: options.logicalCallId,
      attempt: options.attempt ?? 1,
      tool,
      arguments: args,
      result,
      is_error: options.isError ?? false,
      duration_ms: options.durationMs ?? 0,
      ...(options.parentCallId ? { parent_call_id: options.parentCallId } : {}),
      ...(options.permit ? { permit: options.permit } : {}),
    });
    return String(res.record_id ?? "");
  }

  /**
   * Ask the gateway whether a model call may be made. Cooperative: the gateway
   * decides on what the runtime declares and neither makes nor observes the
   * call. Protect runs only. A re-POST of a recorded identity raises
   * `ToolCallConflict`, except a denied one, which returns the same denial.
   */
  async authorizeModelCall(runId: string, request: ModelCallRequest): Promise<ModelCallDecision> {
    const path = `/v1/tool-execution/runs/${runId}/model-calls/authorize`;
    const exchange = await fetchJson(this.client, "POST", path, {
      repetition: request.repetition ?? 1,
      logical_call_id: request.logicalCallId,
      attempt: request.attempt ?? 1,
      provider: request.provider,
      model: request.model,
      max_output_tokens: request.maxOutputTokens,
      estimated_input_tokens: request.estimatedInputTokens,
      ...(request.endpointHost !== undefined ? { endpoint_host: request.endpointHost } : {}),
      ...(request.estimatedCost ? { estimated_cost: { amount_minor: request.estimatedCost.amountMinor, currency: request.estimatedCost.currency } } : {}),
      ...(request.dataClassification ? { data_classification: request.dataClassification } : {}),
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
      ...(request.toolChoiceName !== undefined ? { tool_choice_name: request.toolChoiceName } : {}),
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.stream !== undefined ? { stream: request.stream } : {}),
      ...(request.parentCallId ? { parent_call_id: request.parentCallId } : {}),
      ...(request.deadlineMs !== undefined ? { deadline_ms: request.deadlineMs } : {}),
    });
    const refused = exchange.status === 403 && exchange.body !== undefined && exchange.body.decision === "denied";
    const body = refused ? (exchange.body as Record<string, unknown>) : acceptJson("POST", path, exchange);
    return readModelDecision(body);
  }

  /** Settle a model call accepted by `authorizeModelCall`, presenting its single use permit. */
  async reportModelCall(runId: string, input: ModelCallReportInput): Promise<string> {
    const res = await this.request("POST", `/v1/tool-execution/runs/${runId}/model-calls/report`, {
      repetition: input.repetition ?? 1,
      logical_call_id: input.logicalCallId,
      attempt: input.attempt ?? 1,
      provider: input.provider,
      model: input.model,
      is_error: input.isError ?? false,
      duration_ms: input.durationMs ?? 0,
      permit: input.permit,
      ...(input.usage ? { usage: { input_tokens: input.usage.inputTokens, output_tokens: input.usage.outputTokens } } : {}),
    });
    return String(res.record_id ?? "");
  }

  /** Authorize, run `call` on allow, report with the permit; see `guardModelCall`. */
  guardModelCall<T>(runId: string, request: ModelCallRequest, call: () => Promise<T>, options?: GuardModelCallOptions<T>): Promise<T> {
    return guardModelCall(this, runId, request, call, options);
  }

  /** Durable state of one invocation; any phase is returned as data. */
  async getInvocation(runId: string, recordId: string): Promise<InvocationStatus> {
    const res = await this.request("GET", `/v1/tool-execution/runs/${runId}/invocations/${recordId}`);
    return invocationStatus(res);
  }

  /**
   * Close a call in `outcome_unknown` from operator evidence. The server
   * restricts this to an admin role and records the evidence; it decides
   * whether a possibly executed action counts as done.
   */
  async resolveInvocation(runId: string, recordId: string, input: { resolution: InvocationResolution; evidence: string }): Promise<InvocationStatus> {
    const res = await this.request("POST", `/v1/tool-execution/runs/${runId}/invocations/${recordId}/resolve`, {
      resolution: input.resolution,
      evidence: input.evidence,
    });
    return invocationStatus(res);
  }

  router(runId: string, options: ToolRouterOptions = {}): ToolRouter {
    return new ToolRouter(this, runId, options);
  }

  /**
   * Agents Vault (optional commercial module): execute one authorized business
   * action with a credential the caller never sees. Returns the filtered
   * business result and a receipt id; `actionId` is generated when omitted and
   * returned. Every other outcome is a typed `VaultError`, and an unknown
   * outcome is never retried. See `docs/vault.md`.
   */
  execute<T = unknown>(input: VaultExecuteInput): Promise<VaultExecuteResult<T>> {
    return this.client.vault.runtime.execute<T>(input);
  }

  /** Reads one execution of this runtime identity by `actionId`; any state is returned as data. */
  executionStatus<T = unknown>(actionId: string): Promise<VaultExecutionStatus<T>> {
    return this.client.vault.runtime.getExecution<T>(actionId);
  }
}

export interface ToolRouterOptions {
  repetition?: number;
  /** Functions executed in this process and reported to the gateway. */
  localFunctions?: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>;
  raiseOnError?: boolean;
  /** Awaited with the call identity before any request; may throw to abort locally, never approves. */
  beforeAction?: (intent: ToolActionIntent) => void | Promise<void>;
}

export interface ResumeOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface RouterModelCallRequest extends Omit<ModelCallRequest, "logicalCallId"> {
  logicalCallId?: string;
}

export interface RouterModelCallOptions<T> extends GuardModelCallOptions<T> {
  /** Opt-in: on a pending model call, wait for the approval and run the guarded call once more. Bounded by `timeoutMs`. */
  autoResume?: boolean | ResumeOptions;
}

interface RouterCallOptions {
  parentCallId?: string;
  attempt?: number;
  logicalCallId?: string;
}

interface PendingIdentity {
  tool: string;
  args: Record<string, unknown>;
  options: RouterCallOptions & { logicalCallId: string };
}

function snapshotArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(args);
  } catch {
    return JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
  }
}

function admissionEnvelope(status: "pending" | "denied", recordId: string, authorization: LocalAuthorization): ToolCallResult {
  return {
    result: null,
    agenomic: {
      record_id: recordId,
      status,
      provenance: { source: "unrouted", fidelity: "contract_only", binding_mode: "live" },
      external_state: "none",
      effects: [],
      duration_ms: 0,
      expected_error: false,
      ...(authorization.protect ? { protect: authorization.protect } : {}),
      ...(authorization.approvalId ? { approval_id: authorization.approvalId } : {}),
      decision: authorization.protect?.outcome ?? (status === "pending" ? "require_approval" : "deny"),
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lightweight runtime-side wrapper around one run. */
export class ToolRouter {
  readonly calls: ToolCallResult[] = [];
  private sequence = 0;
  private readonly pending = new Map<string, PendingIdentity>();
  private readonly resuming = new Set<string>();
  private readonly pendingModels = new Map<string, ModelCallRequest>();

  constructor(
    private readonly tools: ToolsResource,
    readonly runId: string,
    private readonly options: ToolRouterOptions = {},
  ) {}

  private nextCallId(tool: string): string {
    this.sequence += 1;
    return `${tool}#${this.sequence}`;
  }

  private pendingError(tool: string, envelope: ToolCallResult, identity: PendingIdentity): ToolApprovalPending {
    const approvalId = envelope.agenomic.approval_id ?? envelope.agenomic.protect?.approval_id ?? "";
    this.calls.push(envelope);
    if (approvalId) this.pending.set(approvalId, { ...identity, args: snapshotArgs(identity.args) });
    return new ToolApprovalPending(tool, approvalId, envelope.agenomic.record_id, envelope);
  }

  call<T = unknown>(tool: string, args: Record<string, unknown> = {}, options: RouterCallOptions = {}): Promise<T> {
    return this.dispatch<T>(tool, args, options);
  }

  private async dispatch<T>(tool: string, args: Record<string, unknown>, options: RouterCallOptions): Promise<T> {
    const raise = this.options.raiseOnError ?? true;
    const logicalCallId = options.logicalCallId ?? this.nextCallId(tool);
    const identity: PendingIdentity = { tool, args, options: { ...options, logicalCallId } };
    const local = this.options.localFunctions?.[tool];
    await this.options.beforeAction?.({
      runId: this.runId,
      tool,
      arguments: args,
      logicalCallId,
      repetition: this.options.repetition ?? 1,
      attempt: options.attempt ?? 1,
      ...(options.parentCallId ? { parentCallId: options.parentCallId } : {}),
      executionPoint: local ? "runtime_local" : "gateway",
    });
    if (local) {
      const authorization = await this.tools.authorizeLocal(this.runId, tool, args, {
        logicalCallId,
        repetition: this.options.repetition,
        attempt: options.attempt,
        parentCallId: options.parentCallId,
      });
      if (authorization.decision === "local") {
        if (!authorization.recordId) {
          throw new ToolExecutionError("invalid_response", `local/authorize accepted ${tool} without a record_id; refusing to execute`, 0);
        }
        return this.runLocal<T>(local, tool, args, { ...options, logicalCallId, recordId: authorization.recordId, permit: authorization.permit });
      }
      if (authorization.decision === "pending") {
        throw this.pendingError(tool, admissionEnvelope("pending", authorization.recordId ?? "", authorization), identity);
      }
      if (authorization.decision !== "gateway") {
        const envelope = admissionEnvelope("denied", authorization.recordId ?? "", authorization);
        this.calls.push(envelope);
        throw new ToolCallDenied(tool, envelope);
      }
    }
    let envelope: ToolCallResult<T>;
    try {
      envelope = await this.tools.invoke<T>(this.runId, tool, args, {
        logicalCallId,
        repetition: this.options.repetition,
        attempt: options.attempt,
        parentCallId: options.parentCallId,
      });
    } catch (error) {
      if (error instanceof ToolCallDenied) this.calls.push(error.envelope);
      throw error;
    }
    if (envelope.agenomic.status === "pending") throw this.pendingError(tool, envelope, identity);
    if (envelope.agenomic.status === "denied") {
      this.calls.push(envelope);
      throw new ToolCallDenied(tool, envelope);
    }
    this.calls.push(envelope);
    if (raise && envelope.agenomic.status !== "success") throw new ToolCallError(tool, envelope);
    return envelope.result as T;
  }

  /**
   * Wait for the approval behind a pending call, then re-issue the identical
   * call identity once, with the original `Idempotency-Key`. `approved` and
   * `consumed` both re-issue: a consumed approval already executed, so the
   * replay recovers its result, and a 409 on that replay throws
   * `ToolExecutionError` with code `conflict`. Rejected, expired or any other
   * terminal status throws `ToolCallDenied` with that status as `code`;
   * waiting past `timeoutMs` throws `ToolExecutionError("approval_timeout")`.
   */
  async resume<T = unknown>(approval: ToolApprovalPending | string, opts: ResumeOptions = {}): Promise<T> {
    const approvalId = typeof approval === "string" ? approval : approval.approvalId;
    const identity = this.pending.get(approvalId);
    if (!identity) {
      throw new ToolExecutionError("unknown_approval", `no pending call is registered for approval ${approvalId}`, 0);
    }
    if (this.resuming.has(approvalId)) {
      throw new ToolExecutionError("resume_in_flight", `approval ${approvalId} is already being resumed by this router`, 0);
    }
    this.resuming.add(approvalId);
    try {
      return await this.awaitAndReissue<T>(approvalId, approval, identity, opts);
    } finally {
      this.resuming.delete(approvalId);
    }
  }

  private async pollApproval(approvalId: string, opts: ResumeOptions): Promise<string> {
    const pollIntervalMs = opts.pollIntervalMs ?? 2000;
    const timeoutMs = opts.timeoutMs ?? 900_000;
    const started = Date.now();
    for (;;) {
      const { status } = await this.tools.client.protect.approvals.get(approvalId);
      if (status !== "pending") return status;
      if (Date.now() - started >= timeoutMs) {
        throw new ToolExecutionError("approval_timeout", `approval ${approvalId} still pending after ${timeoutMs}ms`, 0);
      }
      await sleep(pollIntervalMs);
    }
  }

  private async awaitAndReissue<T>(
    approvalId: string,
    approval: ToolApprovalPending | string,
    identity: PendingIdentity,
    opts: ResumeOptions,
  ): Promise<T> {
    const status = await this.pollApproval(approvalId, opts);
    const consumed = status === "consumed";
    if (status !== "approved" && !consumed) {
      this.pending.delete(approvalId);
      const envelope = typeof approval === "string" ? admissionEnvelope("denied", "", { decision: "denied" }) : approval.envelope;
      throw new ToolCallDenied(identity.tool, { ...envelope, agenomic: { ...envelope.agenomic, status: "denied" } }, status);
    }
    this.pending.delete(approvalId);
    try {
      return await this.dispatch<T>(identity.tool, identity.args, identity.options);
    } catch (error) {
      if (consumed && error instanceof ToolExecutionError && error.status === 409) {
        throw new ToolExecutionError(
          "conflict",
          `approval ${approvalId} is consumed and ${identity.tool} already executed; the gateway refused to replay its result`,
          409,
        );
      }
      throw error;
    }
  }

  /**
   * Route a model call through admission like a tool call: a stable
   * `logicalCallId` is minted when absent, the router repetition is applied,
   * and denied or pending outcomes are recorded in `calls`. A pending call
   * throws `ModelCallPending` unless `autoResume` is set, in which case the
   * approval is awaited (bounded by `timeoutMs`) and the call is re-run once.
   */
  async guardModelCall<T>(request: RouterModelCallRequest, call: () => Promise<T>, options: RouterModelCallOptions<T> = {}): Promise<T> {
    const full: ModelCallRequest = {
      ...request,
      logicalCallId: request.logicalCallId ?? this.nextCallId(`model:${request.provider}/${request.model}`),
      ...(request.repetition === undefined && this.options.repetition !== undefined ? { repetition: this.options.repetition } : {}),
    };
    const { autoResume, ...guardOptions } = options;
    try {
      return await this.runModelCall(full, call, guardOptions);
    } catch (error) {
      if (error instanceof ModelCallPending && autoResume) {
        return this.resumeModelCall(error, call, guardOptions, autoResume === true ? {} : autoResume);
      }
      throw error;
    }
  }

  private async runModelCall<T>(request: ModelCallRequest, call: () => Promise<T>, options: GuardModelCallOptions<T>): Promise<T> {
    try {
      return await this.tools.guardModelCall(this.runId, request, call, options);
    } catch (error) {
      if (error instanceof ModelCallDenied) {
        this.calls.push(admissionEnvelope("denied", error.decision.recordId, error.decision));
      } else if (error instanceof ModelCallPending) {
        this.calls.push(admissionEnvelope("pending", error.decision.recordId, { decision: "pending", approvalId: error.approvalId, protect: error.decision.protect }));
        if (error.approvalId) this.pendingModels.set(error.approvalId, request);
      }
      throw error;
    }
  }

  /**
   * Wait for the approval behind a pending model call, then run the same
   * guarded call again once with the same identity. A terminal status other
   * than approved or consumed throws `ModelCallDenied` with that status as
   * `code`; waiting past `timeoutMs` throws `ToolExecutionError("approval_timeout")`.
   * A second pending answer is thrown, never looped on.
   */
  async resumeModelCall<T>(
    approval: ModelCallPending | string,
    call: () => Promise<T>,
    options: GuardModelCallOptions<T> = {},
    opts: ResumeOptions = {},
  ): Promise<T> {
    const approvalId = typeof approval === "string" ? approval : approval.approvalId;
    const request = this.pendingModels.get(approvalId);
    if (!request) {
      throw new ToolExecutionError("unknown_approval", `no pending model call is registered for approval ${approvalId}`, 0);
    }
    if (this.resuming.has(approvalId)) {
      throw new ToolExecutionError("resume_in_flight", `approval ${approvalId} is already being resumed by this router`, 0);
    }
    this.resuming.add(approvalId);
    try {
      const status = await this.pollApproval(approvalId, opts);
      this.pendingModels.delete(approvalId);
      if (status !== "approved" && status !== "consumed") {
        const tool = typeof approval === "string" ? `model:${request.provider}/${request.model}` : approval.tool;
        const protect = typeof approval === "string" ? undefined : approval.decision.protect;
        const recordId = typeof approval === "string" ? "" : approval.decision.recordId;
        throw new ModelCallDenied(tool, { decision: "denied", tool, recordId, ...(protect ? { protect } : {}) }, status);
      }
      return await this.runModelCall(request, call, options);
    } finally {
      this.resuming.delete(approvalId);
    }
  }

  private async runLocal<T>(
    local: (args: Record<string, unknown>) => unknown | Promise<unknown>,
    tool: string,
    args: Record<string, unknown>,
    options: { parentCallId?: string; attempt?: number; logicalCallId: string; recordId: string; permit?: SignedPermit },
  ): Promise<T> {
    const raise = this.options.raiseOnError ?? true;
    const started = Date.now();
    let value: unknown;
    let isError = false;
    try {
      value = await local(args);
    } catch (error) {
      value = { code: (error as Error)?.name ?? "Error", message: String((error as Error)?.message ?? error) };
      isError = true;
    }
    const durationMs = Date.now() - started;
    const envelope: ToolCallResult = {
      result: isError ? { error: value } : value,
      agenomic: {
        record_id: options.recordId,
        status: isError ? "error" : "success",
        provenance: { source: "runtime_local", fidelity: "live", binding_mode: "live" },
        external_state: "confirmed",
        effects: [],
        duration_ms: durationMs,
        expected_error: false,
        reported: true,
      },
    };
    try {
      await this.tools.reportLocal(this.runId, tool, args, value, {
        isError,
        durationMs,
        logicalCallId: options.logicalCallId,
        repetition: this.options.repetition,
        attempt: options.attempt,
        parentCallId: options.parentCallId,
        permit: options.permit,
      });
    } catch (error) {
      envelope.agenomic.reported = false;
      envelope.agenomic.external_state = "indeterminate";
      this.calls.push(envelope);
      throw error;
    }
    this.calls.push(envelope);
    if (isError && raise) throw new ToolCallError(tool, envelope);
    return envelope.result as T;
  }

  /** A function `(args) => result` routed through this run. */
  wrap<T = unknown>(tool: string): (args?: Record<string, unknown>) => Promise<T> {
    return (args = {}) => this.call<T>(tool, args);
  }

  get hasRealCalls(): boolean {
    return this.calls.some((c) => c.agenomic.provenance.source === "live" || c.agenomic.provenance.source === "runtime_local");
  }

  summary(): { calls: number; bySource: Record<string, number>; hasRealCalls: boolean; unreported: number } {
    const bySource: Record<string, number> = {};
    for (const c of this.calls) {
      const source = c.agenomic.provenance.source;
      bySource[source] = (bySource[source] ?? 0) + 1;
    }
    const unreported = this.calls.filter((c) => c.agenomic.reported === false).length;
    return { calls: this.calls.length, bySource, hasRealCalls: this.hasRealCalls, unreported };
  }
}
