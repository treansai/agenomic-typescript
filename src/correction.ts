import type { AgenomicClient } from "./client";
import { list, query, record, segment } from "./protect";
import { requestJson, ToolExecutionError } from "./tools";

export type IncidentSource = "protect_decision" | "rmp_finding" | "failed_run";
export type IncidentStatus = "open" | "scenario_ready" | "candidate_proposed" | "resolved" | "dismissed";
export type CandidateKind = "prompt_change" | "policy_change" | "tool_contract_change" | "config_change";
export type CandidateStatus = "proposed" | "verified" | "reviewed" | "approved" | "staged" | "promoted" | "rolled_back" | "rejected";
export type WeakeningVerdict = "none" | "weakening" | "unknown";
export type ReplayVerdict = "passed" | "failed" | "inconclusive";
export type CorrectionSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface CorrectionIncident {
  id: string;
  org_id: string;
  source: IncidentSource;
  source_ref: string;
  agent_id: string;
  tool: string | null;
  outcome: string;
  effective_mode: string | null;
  severity: CorrectionSeverity;
  title: string;
  reason_codes: string[];
  evidence_refs: string[];
  dedup_key: string;
  occurrence_count: number;
  status: IncidentStatus;
  proposal_id: string | null;
  fixture_set_ref: string | null;
  opened_by: string;
  suggestion: Record<string, unknown> | null;
  first_seen_at: string;
  last_seen_at: string;
  updated_at: string;
}

export interface PolicyChangePayload {
  policy_id: string;
  candidate_version: string;
  scope_kind: "org" | "environment" | "agent" | "tool_contract" | "run";
  scope_ref?: string;
  mode: "enforce" | "shadow";
  replaces_binding_id?: string;
}

export interface PromptChangePayload {
  prompt_id: string;
  base_version?: number;
  candidate_version: number;
}

export interface ToolContractChangePayload {
  contract_name: string;
  base_version?: number;
  candidate_version: number;
}

export interface ConfigChangePayload {
  key: string;
  proposed: unknown;
  base?: unknown;
}

export interface CorrectionCandidate {
  id: string;
  org_id: string;
  incident_id: string;
  kind: CandidateKind;
  title: string;
  rationale: string;
  payload: Record<string, unknown>;
  content_digest: string;
  scenario_digest: string;
  proposal_id: string;
  claims_weakening: boolean;
  weakening: WeakeningVerdict;
  weakening_reasons: string[];
  weakening_acknowledged: boolean;
  status: CandidateStatus;
  replay_report_id: string | null;
  staged_at: string | null;
  promotion_ref: string | null;
  applied: Record<string, unknown> | null;
  rollback_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface CorrectionTransition {
  id: string;
  entity: string;
  entity_id: string;
  from_status: string;
  to_status: string;
  actor_role: string;
  content_digest: string | null;
  scenario_digest: string | null;
  acknowledged_weakening: boolean;
  note: string | null;
  evidence: Record<string, unknown>;
  created_at: string;
}

/** Append-only replay report bound to a candidate digest; `report` holds the per scenario detail. */
export interface CorrectionReplayReport {
  id: string;
  candidate_id: string;
  content_digest: string;
  scenario_digest: string;
  bindings_digest: string;
  report_digest: string;
  verdict: ReplayVerdict;
  report: Record<string, unknown>;
  created_at: string;
}

export interface VerifyOutcome {
  candidate: CorrectionCandidate;
  report: CorrectionReplayReport;
}

export interface CorrectionSettings {
  trigger_enabled: boolean;
  deny_threshold: number;
  window_secs: number;
  max_incidents_per_hour: number;
  min_shadow_secs: number;
}

export interface SweepOutcome {
  enabled: boolean;
  groups_over_threshold: number;
  opened: string[];
  rate_limited: number;
}

export interface CreateCandidateInput {
  incidentId: string;
  kind: CandidateKind;
  title: string;
  payload: PolicyChangePayload | PromptChangePayload | ToolContractChangePayload | ConfigChangePayload;
  rationale?: string;
  claimsWeakening?: boolean;
}

interface DigestStep {
  contentDigest: string;
  note?: string;
}

interface ReportStep extends DigestStep {
  reportId: string;
}

function digestBody(input: DigestStep): Record<string, unknown> {
  return { content_digest: input.contentDigest, ...(input.note !== undefined ? { note: input.note } : {}) };
}

function reportBody(input: ReportStep): Record<string, unknown> {
  return { ...digestBody(input), report_id: input.reportId };
}

function reasonBody(reason?: string): Record<string, unknown> {
  return reason !== undefined ? { reason } : {};
}

/**
 * Correction loop (`/v1/correction`, cloud only, Postgres deployments). Turns
 * an observed Protect denial, RMP finding or failed run into a regression
 * scenario, then into a digest bound candidate fix that people review and an
 * owner promotes. Nothing here promotes by itself: verify, review, approve,
 * promote and enforce are separate calls with separate role checks on the
 * server, and only `policy_change` candidates can be replayed and promoted.
 */
export class CorrectionResource {
  readonly incidents: CorrectionIncidentsResource;
  readonly candidates: CorrectionCandidatesResource;

  constructor(private readonly client: AgenomicClient) {
    this.incidents = new CorrectionIncidentsResource(client);
    this.candidates = new CorrectionCandidatesResource(client);
  }

  async getSettings(): Promise<CorrectionSettings> {
    return settings(await requestJson(this.client, "GET", "/v1/correction/settings"));
  }

  /** Owner only. The server validates every field, so the whole object is sent. */
  async updateSettings(input: CorrectionSettings): Promise<CorrectionSettings> {
    return settings(await requestJson(this.client, "PUT", "/v1/correction/settings", { ...input }));
  }

  /** Owner only: counts enforced denials and findings in the window and opens incidents over the threshold. */
  async sweep(): Promise<SweepOutcome> {
    const res = await requestJson(this.client, "POST", "/v1/correction/triggers/sweep", {});
    if (typeof res.enabled !== "boolean" || !Array.isArray(res.opened)) {
      throw new ToolExecutionError("invalid_response", "sweep response carries no enabled and opened", 0);
    }
    return res as unknown as SweepOutcome;
  }
}

function settings(res: Record<string, unknown>): CorrectionSettings {
  if (typeof res.trigger_enabled !== "boolean" || typeof res.deny_threshold !== "number") {
    throw new ToolExecutionError("invalid_response", "settings response carries no trigger_enabled and deny_threshold", 0);
  }
  return res as unknown as CorrectionSettings;
}

export class CorrectionIncidentsResource {
  constructor(private readonly client: AgenomicClient) {}

  async list(options: { status?: IncidentStatus; agentId?: string; limit?: number } = {}): Promise<CorrectionIncident[]> {
    const res = await requestJson(
      this.client,
      "GET",
      `/v1/correction/incidents${query({ status: options.status, agent_id: options.agentId, limit: options.limit })}`,
    );
    return list<CorrectionIncident>(res, "incidents");
  }

  /** The caller names a stored source; severity and text are read from the record, never supplied. */
  async open(input: { source: IncidentSource; sourceRef: string }): Promise<{ incident: CorrectionIncident; created: boolean }> {
    const res = await requestJson(this.client, "POST", "/v1/correction/incidents", { source: input.source, source_ref: input.sourceRef });
    const incident = res.incident as { id?: unknown } | undefined;
    if (incident === null || typeof incident !== "object" || typeof incident.id !== "string" || typeof res.created !== "boolean") {
      throw new ToolExecutionError("invalid_response", "open incident response carries no incident and created", 0);
    }
    return res as unknown as { incident: CorrectionIncident; created: boolean };
  }

  async get(incidentId: string): Promise<CorrectionIncident> {
    return record<CorrectionIncident>(await requestJson(this.client, "GET", `/v1/correction/incidents/${segment(incidentId)}`), "id", "incident");
  }

  /** Creates the scenario proposal; the scenario joins the corpus only through the existing proposal approval. */
  async convertToScenario(incidentId: string): Promise<CorrectionIncident> {
    const res = await requestJson(this.client, "POST", `/v1/correction/incidents/${segment(incidentId)}/scenario`, {});
    return record<CorrectionIncident>(res, "id", "incident");
  }

  async dismiss(incidentId: string, reason?: string): Promise<CorrectionIncident> {
    const res = await requestJson(this.client, "POST", `/v1/correction/incidents/${segment(incidentId)}/dismiss`, reasonBody(reason));
    return record<CorrectionIncident>(res, "id", "incident");
  }
}

export class CorrectionCandidatesResource {
  constructor(private readonly client: AgenomicClient) {}

  private path(candidateId: string, action = ""): string {
    return `/v1/correction/candidates/${segment(candidateId)}${action}`;
  }

  private step(candidateId: string, action: string, body: Record<string, unknown>): Promise<CorrectionCandidate> {
    return requestJson(this.client, "POST", this.path(candidateId, action), body).then((res) =>
      record<CorrectionCandidate>(res, "id", "candidate"),
    );
  }

  async list(options: { status?: CandidateStatus; incidentId?: string; limit?: number } = {}): Promise<CorrectionCandidate[]> {
    const res = await requestJson(
      this.client,
      "GET",
      `/v1/correction/candidates${query({ status: options.status, incident_id: options.incidentId, limit: options.limit })}`,
    );
    return list<CorrectionCandidate>(res, "candidates");
  }

  /** The server normalizes the payload and computes `content_digest` and the weakening verdict. */
  async create(input: CreateCandidateInput): Promise<CorrectionCandidate> {
    const res = await requestJson(this.client, "POST", "/v1/correction/candidates", {
      incident_id: input.incidentId,
      kind: input.kind,
      title: input.title,
      payload: input.payload,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      ...(input.claimsWeakening !== undefined ? { claims_weakening: input.claimsWeakening } : {}),
    });
    return record<CorrectionCandidate>(res, "id", "candidate");
  }

  async get(candidateId: string): Promise<CorrectionCandidate> {
    return record<CorrectionCandidate>(await requestJson(this.client, "GET", this.path(candidateId)), "id", "candidate");
  }

  async transitions(candidateId: string): Promise<CorrectionTransition[]> {
    return list<CorrectionTransition>(await requestJson(this.client, "GET", this.path(candidateId, "/transitions")), "transitions");
  }

  /** The replay report bound to the candidate. */
  async replay(candidateId: string): Promise<CorrectionReplayReport> {
    return record<CorrectionReplayReport>(await requestJson(this.client, "GET", this.path(candidateId, "/replay")), "id", "replay report");
  }

  /** Runs the comparative replay on the server; the verdict is the server's, the caller sends only the digest it looked at. */
  async verify(candidateId: string, input: DigestStep): Promise<VerifyOutcome> {
    const res = await requestJson(this.client, "POST", this.path(candidateId, "/verify"), digestBody(input));
    const candidate = res.candidate as { id?: unknown } | undefined;
    const report = res.report as { id?: unknown } | undefined;
    if (typeof candidate?.id !== "string" || typeof report?.id !== "string") {
      throw new ToolExecutionError("invalid_response", "verify response carries no candidate and report", 0);
    }
    return res as unknown as VerifyOutcome;
  }

  /** The reviewer differs from the author and names the passed report it read. */
  review(candidateId: string, input: ReportStep): Promise<CorrectionCandidate> {
    return this.step(candidateId, "/review", reportBody(input));
  }

  /** Owner only, distinct from the author. A weakening or unknown verdict needs `acknowledgeWeakening` and a note. */
  approve(candidateId: string, input: ReportStep & { acknowledgeWeakening?: boolean }): Promise<CorrectionCandidate> {
    return this.step(candidateId, "/approve", {
      ...reportBody(input),
      ...(input.acknowledgeWeakening !== undefined ? { acknowledge_weakening: input.acknowledgeWeakening } : {}),
    });
  }

  reject(candidateId: string, reason?: string): Promise<CorrectionCandidate> {
    return this.step(candidateId, "/reject", reasonBody(reason));
  }

  /** Owner only, from `approved`. An `enforce` payload is staged in shadow first; a `shadow` payload is applied at once. */
  promote(candidateId: string, input: DigestStep): Promise<CorrectionCandidate> {
    return this.step(candidateId, "/promote", digestBody(input));
  }

  /** Owner only, from `staged`, after the shadow soak and while no kill switch is live. */
  enforce(candidateId: string, input: DigestStep): Promise<CorrectionCandidate> {
    return this.step(candidateId, "/enforce", digestBody(input));
  }

  /** Owner only, from `staged` or `promoted`; idempotent. */
  rollback(candidateId: string, reason: string): Promise<CorrectionCandidate> {
    return this.step(candidateId, "/rollback", reasonBody(reason));
  }
}
