import type { AgenomicClient } from "./client";
import { ProtectResource as RmpProtectResource } from "./rmp";
import { requestJson, ToolExecutionError, type ProtectEffectiveMode, type ProtectOutcome, type TransformationProposal } from "./tools";

export type PolicyBindingScopeKind = "org" | "environment" | "agent" | "tool_contract" | "run";
export type BindingStatus = "active" | "revoked";
export type RestrictionScopeKind = "org" | "environment" | "agent" | "run" | "tool";
export type RestrictionKind = "suspend" | "block_tool" | "require_approval" | "budget_cap";
export type KillSwitchScopeKind = "org" | "agent" | "run" | "tool";
export type ProtectApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "consumed";

export interface ProtectOverlay {
  version: string;
  digest: string;
  text: string;
  policies: string[];
  truncated: boolean;
}

export interface ProtectCatalogTool {
  tool: string;
  allowed: boolean;
  requires_approval: boolean;
  effect: string;
  reason_codes: string[];
}

export interface ProtectCatalog {
  tools: ProtectCatalogTool[];
}

export interface PolicySummary {
  policy_id: string;
  version: string;
  status: string;
  schema_version: string;
  document_hash: string;
  created_at: string;
  released_at?: string;
  deprecated_at?: string;
  signature_present: boolean;
  active_bindings: number;
}

/** Row of `policy_versions` (`agenomic_core::PolicyRecord`). */
export interface PolicyRecord {
  org_id: string;
  policy_id: string;
  version: string;
  status: string;
  document_hash: string;
  document_blob_ref: string;
  created_by?: string | null;
  created_at: string;
  released_at?: string | null;
  schema_version: string;
  signature?: unknown;
  deprecated_at?: string | null;
  deprecated_by?: string | null;
}

export interface PolicyDetail {
  record: PolicyRecord;
  policy: Record<string, unknown>;
  signature_valid?: boolean;
  signature_reason?: string;
}

export interface PolicyBinding {
  id: string;
  policy_id: string;
  version: string;
  document_hash: string;
  scope_kind: string;
  scope_ref: string;
  mode: ProtectEffectiveMode;
  status: string;
  activated_by?: string;
  activated_at: string;
  revoked_by?: string;
  revoked_at?: string;
  revoke_reason?: string;
}

export interface MatchedPolicy {
  policy_id: string;
  version: string;
  document_hash: string;
  rule_id?: string;
  outcome: ProtectOutcome;
  non_derogable: boolean;
  mode: ProtectEffectiveMode;
}

export interface Obligation {
  kind: string;
  parameters: unknown;
}

export interface GuardrailResult {
  guardrail: string;
  version: string;
  status: "pass" | "fail" | "error" | "skipped";
  detail?: string;
  probabilistic: boolean;
}

export interface ApprovalRequirement {
  reviewer_distinct_from_principal: boolean;
  ttl_secs?: number;
  rule_ids: string[];
}

/** Full evaluator output (mirror of `Decision`). */
export interface ProtectDecisionDocument {
  decision_id: string;
  action_id: string;
  action_digest: string;
  outcome: ProtectOutcome;
  effective_mode: ProtectEffectiveMode;
  non_derogable: boolean;
  reason_codes: string[];
  safe_explanation: string;
  matched_policy_versions: MatchedPolicy[];
  policy_snapshot_digest: string;
  guardrail_results: GuardrailResult[];
  required_obligations: Obligation[];
  approval_requirements: ApprovalRequirement[];
  transformation_proposal?: TransformationProposal;
  execution_permit_ref?: string;
  evaluated_at: string;
  expires_at?: string;
}

export interface ProtectDecisionRecord {
  id: string;
  run_id: string;
  invocation_id?: string;
  action_id: string;
  parent_action_id?: string;
  action_digest: string;
  tool: string;
  action_type: string;
  outcome: ProtectOutcome;
  effective_mode: ProtectEffectiveMode;
  reason_codes: string[];
  policy_snapshot_digest: string;
  approval_id?: string;
  permit_ref?: string;
  evaluated_at: string;
  expires_at?: string;
  latency_ms: number;
  doc: ProtectDecisionDocument;
}

export interface ProtectApproval {
  id: string;
  run_id: string;
  invocation_id: string;
  decision_id: string;
  action_digest: string;
  status: string;
  requested_at: string;
  expires_at: string;
  decided_by?: string;
  decided_at?: string;
  comment?: string;
  preview: unknown;
  triggered_rules: MatchedPolicy[];
  obligations: Obligation[];
  tool: string;
  safe_explanation: string;
}

export interface ProtectRestriction {
  id: string;
  scope_kind: string;
  scope_ref: string;
  kind: string;
  parameters: unknown;
  reason: string;
  status: string;
  created_by?: string;
  created_at: string;
  expires_at?: string;
  lifted_by?: string;
  lifted_at?: string;
}

export interface KillSwitchResponse {
  restriction: ProtectRestriction;
  cancelled_runs: string[];
  cancellation_note: string;
}

export interface DiffLine {
  kind: string;
  text: string;
}

export interface PolicyDiffResponse {
  from: string;
  to: string;
  lines: DiffLine[];
}

export interface CoverageRow {
  family: string;
  interception_point: string;
  mode: string;
  bypass: string;
  tests: string;
  limits: string;
}

export interface CoverageResponse {
  families: CoverageRow[];
}

export interface ProtectMetricsSummary {
  decisions_by_outcome: Record<string, number>;
  pending_approvals: number;
  latency_ms: { p50: number; p95: number; p99: number };
  bundle_freshness_secs?: number;
  coverage_known_families: number;
}

export interface SimulateRequest {
  intents: Array<Record<string, unknown>>;
  policies?: Array<Record<string, unknown>>;
  policyRefs?: string[];
  decisionsFromRun?: string;
}

export interface SimulateResponse {
  decisions: ProtectDecisionDocument[];
  policy_snapshot_digest: string;
  warnings: string[];
}

export interface ProtectDecisionPage {
  decisions: ProtectDecisionRecord[];
  next_cursor?: string;
}

export interface CreateBindingInput {
  policyId: string;
  version: string;
  scopeKind: PolicyBindingScopeKind;
  scopeRef?: string;
  mode: ProtectEffectiveMode;
}

export interface CreateRestrictionInput {
  scopeKind: RestrictionScopeKind;
  scopeRef?: string;
  kind: RestrictionKind;
  parameters?: Record<string, unknown>;
  reason: string;
  expiresAt?: string;
}

export interface KillSwitchInput {
  scopeKind: KillSwitchScopeKind;
  scopeRef?: string;
  reason: string;
}

function query(params: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(params).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
  if (pairs.length === 0) return "";
  return "?" + pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}

/** List responses are enveloped under a documented key; anything else is a wire mismatch. */
function list<T>(res: Record<string, unknown>, key: string): T[] {
  const value = res[key];
  if (!Array.isArray(value)) {
    throw new ToolExecutionError("invalid_response", `list response carries no "${key}" array`, 0);
  }
  return value as T[];
}

/** Single-record responses are bare records; `id` proves the body is the record. */
function record<T>(res: Record<string, unknown>, field: string, what: string): T {
  if (typeof res[field] !== "string") {
    throw new ToolExecutionError("invalid_response", `${what} response is not a bare record`, 0);
  }
  return res as T;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

/** Register, release and deprecate answer `PolicyResponse { policy }`, not a bare record. */
function policyRecord(res: Record<string, unknown>): PolicyRecord {
  const policy = res.policy;
  if (policy === null || typeof policy !== "object") {
    throw new ToolExecutionError("invalid_response", "policy response carries no policy record", 0);
  }
  return policy as PolicyRecord;
}

function simulation(res: Record<string, unknown>): SimulateResponse {
  if (typeof res.policy_snapshot_digest !== "string") {
    throw new ToolExecutionError("invalid_response", "simulate response carries no policy_snapshot_digest", 0);
  }
  return {
    decisions: list<ProtectDecisionDocument>(res, "decisions"),
    policy_snapshot_digest: res.policy_snapshot_digest,
    warnings: list<string>(res, "warnings"),
  };
}

/** The `client.protect` namespace: RMP alerts plus proactive policy enforcement. */
export class ProtectResource extends RmpProtectResource {
  readonly approvals: ProtectApprovalsResource;
  readonly decisions: ProtectDecisionsResource;
  readonly policies: ProtectPoliciesResource;
  readonly bindings: ProtectBindingsResource;
  readonly restrictions: ProtectRestrictionsResource;

  constructor(client: AgenomicClient) {
    super(client);
    this.approvals = new ProtectApprovalsResource(client);
    this.decisions = new ProtectDecisionsResource(client);
    this.policies = new ProtectPoliciesResource(client);
    this.bindings = new ProtectBindingsResource(client);
    this.restrictions = new ProtectRestrictionsResource(client);
  }

  /** Deterministic, versioned instruction overlay for a protect run. */
  async overlay(runId: string): Promise<ProtectOverlay> {
    const res = await requestJson(this.client, "GET", `/v1/protect/runs/${segment(runId)}/overlay`);
    return record<ProtectOverlay>(res, "text", "overlay");
  }

  /** Tools currently allowed or requiring approval under the effective policies. */
  async catalog(runId: string): Promise<ProtectCatalog> {
    const res = await requestJson(this.client, "GET", `/v1/protect/runs/${segment(runId)}/catalog`);
    return { tools: list<ProtectCatalogTool>(res, "tools") };
  }

  async killSwitch(input: KillSwitchInput): Promise<KillSwitchResponse> {
    const res = await requestJson(this.client, "POST", "/v1/protect/kill-switch", {
      scope_kind: input.scopeKind,
      scope_ref: input.scopeRef ?? "",
      reason: input.reason,
    });
    const restriction = res.restriction;
    if (restriction === null || typeof restriction !== "object") {
      throw new ToolExecutionError("invalid_response", "kill switch response carries no restriction", 0);
    }
    return {
      restriction: restriction as ProtectRestriction,
      cancelled_runs: list<string>(res, "cancelled_runs"),
      cancellation_note: typeof res.cancellation_note === "string" ? res.cancellation_note : "",
    };
  }

  /** Evaluate intents without permits, decision rows or side effects. */
  async simulate(input: SimulateRequest): Promise<SimulateResponse> {
    const res = await requestJson(this.client, "POST", "/v1/protect/simulate", {
      intents: input.intents,
      ...(input.policies ? { policies: input.policies } : {}),
      ...(input.policyRefs ? { policy_refs: input.policyRefs } : {}),
      ...(input.decisionsFromRun ? { decisions_from_run: input.decisionsFromRun } : {}),
    });
    return simulation(res);
  }

  async coverage(): Promise<CoverageResponse> {
    const res = await requestJson(this.client, "GET", "/v1/protect/coverage");
    return { families: list<CoverageRow>(res, "families") };
  }

  async metricsSummary(): Promise<ProtectMetricsSummary> {
    const res = await requestJson(this.client, "GET", "/v1/protect/metrics/summary");
    if (res.decisions_by_outcome === null || typeof res.decisions_by_outcome !== "object") {
      throw new ToolExecutionError("invalid_response", "metrics summary carries no decisions_by_outcome", 0);
    }
    return res as unknown as ProtectMetricsSummary;
  }
}

export class ProtectApprovalsResource {
  constructor(private readonly client: AgenomicClient) {}

  async list(options: { status?: ProtectApprovalStatus; runId?: string } = {}): Promise<ProtectApproval[]> {
    const res = await requestJson(this.client, "GET", `/v1/protect/approvals${query({ status: options.status, run_id: options.runId })}`);
    return list<ProtectApproval>(res, "approvals");
  }

  async get(approvalId: string): Promise<ProtectApproval> {
    const res = await requestJson(this.client, "GET", `/v1/protect/approvals/${segment(approvalId)}`);
    return record<ProtectApproval>(res, "id", "approval");
  }

  async decide(approvalId: string, input: { decision: "approve" | "reject"; comment?: string }): Promise<ProtectApproval> {
    const res = await requestJson(this.client, "POST", `/v1/protect/approvals/${segment(approvalId)}/decide`, {
      decision: input.decision,
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
    });
    return record<ProtectApproval>(res, "id", "approval");
  }
}

export class ProtectDecisionsResource {
  constructor(private readonly client: AgenomicClient) {}

  /** The one paginated read: `next_cursor` continues the page through `cursor`. */
  async list(
    options: { runId?: string; outcome?: ProtectOutcome; since?: string; limit?: number; cursor?: string } = {},
  ): Promise<ProtectDecisionPage> {
    const res = await requestJson(
      this.client,
      "GET",
      `/v1/protect/decisions${query({
        run_id: options.runId,
        outcome: options.outcome,
        since: options.since,
        limit: options.limit,
        cursor: options.cursor,
      })}`,
    );
    const cursor = res.next_cursor;
    return {
      decisions: list<ProtectDecisionRecord>(res, "decisions"),
      ...(typeof cursor === "string" && cursor ? { next_cursor: cursor } : {}),
    };
  }

  async get(decisionId: string): Promise<ProtectDecisionRecord> {
    const res = await requestJson(this.client, "GET", `/v1/protect/decisions/${segment(decisionId)}`);
    return record<ProtectDecisionRecord>(res, "id", "decision");
  }
}

export class ProtectPoliciesResource {
  constructor(private readonly client: AgenomicClient) {}

  private static ref(policyId: string, version: string): string {
    return segment(`${policyId}@${version}`);
  }

  async list(): Promise<PolicySummary[]> {
    const res = await requestJson(this.client, "GET", "/v1/policies");
    return list<PolicySummary>(res, "policies");
  }

  /** Register a draft: a bare policy document, or its YAML or JSON text. */
  async register(document: Record<string, unknown> | string): Promise<PolicyRecord> {
    const res = await requestJson(this.client, "POST", "/v1/policies", typeof document === "string" ? { document_text: document } : document);
    return policyRecord(res);
  }

  async get(policyId: string, version: string): Promise<PolicyDetail> {
    const res = await requestJson(this.client, "GET", `/v1/policies/${ProtectPoliciesResource.ref(policyId, version)}`);
    if (res.record === null || typeof res.record !== "object" || !("policy" in res)) {
      throw new ToolExecutionError("invalid_response", "policy detail carries no record and policy", 0);
    }
    return res as unknown as PolicyDetail;
  }

  async release(policyId: string, version: string): Promise<PolicyRecord> {
    const res = await requestJson(this.client, "POST", `/v1/policies/${ProtectPoliciesResource.ref(policyId, version)}/release`, {});
    return policyRecord(res);
  }

  async deprecate(policyId: string, version: string): Promise<PolicyRecord> {
    const res = await requestJson(this.client, "POST", `/v1/policies/${ProtectPoliciesResource.ref(policyId, version)}/deprecate`, {});
    return policyRecord(res);
  }

  async simulate(policyId: string, version: string, intents: Array<Record<string, unknown>>): Promise<SimulateResponse> {
    const res = await requestJson(this.client, "POST", `/v1/policies/${ProtectPoliciesResource.ref(policyId, version)}/simulate`, { intents });
    return simulation(res);
  }

  async diff(policyId: string, version: string, against: string): Promise<PolicyDiffResponse> {
    const res = await requestJson(this.client, "GET", `/v1/policies/${ProtectPoliciesResource.ref(policyId, version)}/diff${query({ against })}`);
    return {
      from: typeof res.from === "string" ? res.from : "",
      to: typeof res.to === "string" ? res.to : "",
      lines: list<DiffLine>(res, "lines"),
    };
  }
}

export class ProtectBindingsResource {
  constructor(private readonly client: AgenomicClient) {}

  async list(options: { scopeKind?: PolicyBindingScopeKind; scopeRef?: string; status?: BindingStatus } = {}): Promise<PolicyBinding[]> {
    const res = await requestJson(
      this.client,
      "GET",
      `/v1/protect/bindings${query({ scope_kind: options.scopeKind, scope_ref: options.scopeRef, status: options.status })}`,
    );
    return list<PolicyBinding>(res, "bindings");
  }

  async create(input: CreateBindingInput): Promise<PolicyBinding> {
    const res = await requestJson(this.client, "POST", "/v1/protect/bindings", {
      policy_id: input.policyId,
      version: input.version,
      scope_kind: input.scopeKind,
      scope_ref: input.scopeRef ?? "",
      mode: input.mode,
    });
    return record<PolicyBinding>(res, "id", "binding");
  }

  async revoke(bindingId: string, reason: string): Promise<PolicyBinding> {
    const res = await requestJson(this.client, "POST", `/v1/protect/bindings/${segment(bindingId)}/revoke`, { reason });
    return record<PolicyBinding>(res, "id", "binding");
  }
}

export class ProtectRestrictionsResource {
  constructor(private readonly client: AgenomicClient) {}

  async list(options: { status?: "active" | "lifted" | "expired" } = {}): Promise<ProtectRestriction[]> {
    const res = await requestJson(this.client, "GET", `/v1/protect/restrictions${query({ status: options.status })}`);
    return list<ProtectRestriction>(res, "restrictions");
  }

  async create(input: CreateRestrictionInput): Promise<ProtectRestriction> {
    const res = await requestJson(this.client, "POST", "/v1/protect/restrictions", {
      scope_kind: input.scopeKind,
      scope_ref: input.scopeRef ?? "",
      kind: input.kind,
      parameters: input.parameters ?? {},
      reason: input.reason,
      ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
    });
    return record<ProtectRestriction>(res, "id", "restriction");
  }

  async lift(restrictionId: string): Promise<ProtectRestriction> {
    const res = await requestJson(this.client, "POST", `/v1/protect/restrictions/${segment(restrictionId)}/lift`, {});
    return record<ProtectRestriction>(res, "id", "restriction");
  }
}
