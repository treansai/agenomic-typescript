/**
 * Review · Monitor · Protect (RMP).
 *
 * RMP is Agenomic's continuous safety loop for production agents:
 * Review (pre-release scenario testing) → Monitor (runtime detection) →
 * Protect (alerting / mitigation) → back to Review (scenario enrichment).
 * The loop engine runs in Agenomic Cloud (`/v1/rmp|review|monitor|protect`);
 * the SDK's job is faithful instrumentation and a typed client surface.
 *
 * Wire format is the spec's snake_case JSON with
 * `spec_version: "agenomic.rmp/v0.1"`. Like `client.tracking`, every resource
 * is local-first: without a `baseUrl`/`endpoint` on the client, sessions and
 * scenarios are buffered in-process (reads return buffered/empty data and
 * never throw), and with one they call Agenomic Cloud.
 */

import type { AgenomicClient } from "./client";
import { createId, nowIso } from "./utils";

export const RMP_SPEC_VERSION = "agenomic.rmp/v0.1";
export const RMP_REPORT_VERSION = "agenomic.rmp.report/v0.1";

// ---------------------------------------------------------------------------
// Wire types (snake_case, structural)
// ---------------------------------------------------------------------------

export type RmpSeverity = "info" | "low" | "medium" | "high" | "critical";

/** An RMP loop session (the snake_case wire shape). */
export interface RmpSession {
  spec_version: typeof RMP_SPEC_VERSION;
  session_id: string;
  agent_id: string;
  environment: string;
  status: "active" | "stopped";
  created_at: string;
  release_id?: string;
  genome_hash?: string;
  ledger_enabled?: boolean;
}

/** Summary block of an RMP report. */
export interface RmpReportSummary {
  event_count: number;
  finding_count: number;
  alert_count: number;
  open_alert_count?: number;
  scenario_proposal_count?: number;
}

/** An RMP loop report (the snake_case wire shape). */
export interface RmpReport {
  report_version: typeof RMP_REPORT_VERSION;
  session_id: string;
  generated_at: string;
  agent_id?: string;
  summary: RmpReportSummary;
  findings?: Finding[];
  alerts?: Alert[];
  recommendations?: Recommendation[];
}

/** A Monitor-phase detection finding. */
export interface Finding {
  finding_id: string;
  category: string;
  severity: RmpSeverity;
  session_id?: string;
  agent_id?: string;
  status?: string;
  detected_at?: string;
  summary?: string;
  evidence?: Record<string, unknown>;
}

/** A Protect-phase alert. */
export interface Alert {
  alert_id: string;
  severity: RmpSeverity;
  status: "open" | "acknowledged" | "resolved" | "suppressed";
  dedup_key: string;
  occurrence_count: number;
  routes: string[];
  throttled: boolean;
  escalated: boolean;
  session_id?: string;
  finding_id?: string;
  created_at?: string;
  summary?: string;
}

/** A Protect-phase remediation recommendation. */
export interface Recommendation {
  recommendation_id: string;
  kind?: string;
  priority?: RmpSeverity;
  session_id?: string;
  title?: string;
  description?: string;
  related_alert_ids?: string[];
}

/** One step of a Protect action plan. */
export interface ActionPlanStep {
  step_number: number;
  action: string;
  automated?: boolean;
  description?: string;
}

/** A Protect action plan generated for an alert. */
export interface ActionPlan {
  plan_id: string;
  alert_id: string;
  steps: ActionPlanStep[];
  session_id?: string;
  created_at?: string;
}

export type ScenarioSource =
  | "manual"
  | "generated"
  | "incident_derived"
  | "monitor_derived"
  | "protect_derived"
  | "user_provided";

/** A Review test scenario. */
export interface TestScenario {
  scenario_id: string;
  source: ScenarioSource;
  severity: RmpSeverity;
  name?: string;
  description?: string;
  inputs?: Record<string, unknown>;
  expected?: Record<string, unknown>;
  tags?: string[];
}

export type ScenarioEnrichmentStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "rejected"
  | "applied";

/** A scenario-enrichment proposal (Monitor/Protect → Review feedback). */
export interface ScenarioEnrichmentProposal {
  proposal_id: string;
  status: ScenarioEnrichmentStatus;
  human_approval_required: boolean;
  session_id?: string;
  scenario?: TestScenario;
  source_finding_id?: string;
  created_at?: string;
  reviewed_by?: string;
}

/** The outcome of a Review run. */
export interface ReviewOutcome {
  result: "pass" | "fail" | "inconclusive";
  run_id?: string;
  agent_id?: string;
  scenario_results?: Array<Record<string, unknown>>;
}

/** A Monitor runtime event (the snake_case wire shape). */
export interface WireMonitorEvent {
  spec_version: typeof RMP_SPEC_VERSION;
  event_id: string;
  session_id: string;
  timestamp: string;
  sequence_number: number;
  type: string;
  agent_id: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// SDK (camelCase) option types
// ---------------------------------------------------------------------------

export interface RmpStartOptions {
  /** Canonical agent id, e.g. `agent://org/name`. */
  agent: string;
  releaseId?: string;
  environment?: string;
  /** Enable the tamper-evident ledger for this session. */
  ledger?: boolean;
  genomeHash?: string;
}

export interface MonitorStartOptions {
  agent: string;
  releaseId?: string;
  environment?: string;
  ledger?: boolean;
}

/** A Monitor event as emitted by the caller; `type` is required. */
export interface MonitorEventInput {
  type: string;
  [key: string]: unknown;
}

export interface ReviewRunOptions {
  agent: string;
  scenarios?: TestScenario[];
  riskMatrix?: Record<string, unknown>;
}

export interface TestScenarioInput {
  scenarioId?: string;
  source?: ScenarioSource;
  severity?: RmpSeverity;
  name?: string;
  description?: string;
  inputs?: Record<string, unknown>;
  expected?: Record<string, unknown>;
  tags?: string[];
}

export interface ApproveScenarioEnrichmentOptions {
  proposalId: string;
  sessionId?: string;
  reviewer?: string;
}

// ---------------------------------------------------------------------------
// HTTP helpers (same conventions as tracking.ts)
// ---------------------------------------------------------------------------

function apiBase(client: AgenomicClient): string | undefined {
  // Prefer an explicit API base; otherwise derive it from the (possibly
  // trace-path-suffixed) ingestion endpoint so RMP URLs hang off the API root.
  const raw = client.baseUrl ?? client.endpoint;
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "").replace(/\/v1\/traces$/, "");
}

function authHeaders(client: AgenomicClient): Record<string, string> {
  return {
    ...(client.apiKey ? { authorization: `Bearer ${client.apiKey}` } : {}),
    ...client.headers,
  };
}

async function requestJson(
  client: AgenomicClient,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const base = apiBase(client);
  if (!base) {
    throw new Error("RMP cloud call requires an endpoint on the client");
  }
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...authHeaders(client),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    throw new Error(
      `Agenomic RMP ${path} failed with ${response.status} ${response.statusText}`,
    );
  }
  const text = await response.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function extractList<T>(res: Record<string, unknown>, key: string): T[] {
  const value = res[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

function requireSessionId(res: Record<string, unknown>, what: string): string {
  const session = (res.session ?? res) as Record<string, unknown>;
  const sessionId = session.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error(`Agenomic ${what} start response did not include a session_id`);
  }
  return sessionId;
}

// ---------------------------------------------------------------------------
// RmpResource — the whole loop
// ---------------------------------------------------------------------------

/** The `client.rmp` namespace: full Review → Monitor → Protect loop sessions. */
export class RmpResource {
  private readonly local = new Map<string, RmpSession>();

  constructor(private readonly client: AgenomicClient) {}

  /** Start an RMP loop session for a production agent release. */
  async start(options: RmpStartOptions): Promise<RmpSession> {
    const environment = options.environment ?? "production";
    if (apiBase(this.client)) {
      const body = {
        spec_version: RMP_SPEC_VERSION,
        agent_id: options.agent,
        environment,
        ...(options.releaseId ? { release_id: options.releaseId } : {}),
        ...(options.genomeHash ? { genome_hash: options.genomeHash } : {}),
        ...(options.ledger !== undefined ? { ledger: options.ledger } : {}),
      };
      const res = await requestJson(this.client, "POST", "/v1/rmp/sessions", body);
      const sessionId = requireSessionId(res, "RMP");
      const session = (res.session ?? res) as Partial<RmpSession>;
      return {
        spec_version: RMP_SPEC_VERSION,
        session_id: sessionId,
        agent_id: options.agent,
        environment,
        status: "active",
        created_at: nowIso(),
        ...session,
      } as RmpSession;
    }
    const session: RmpSession = {
      spec_version: RMP_SPEC_VERSION,
      session_id: createId("rmp"),
      agent_id: options.agent,
      environment,
      status: "active",
      created_at: nowIso(),
      ...(options.releaseId ? { release_id: options.releaseId } : {}),
      ...(options.genomeHash ? { genome_hash: options.genomeHash } : {}),
      ...(options.ledger !== undefined ? { ledger_enabled: options.ledger } : {}),
    };
    this.local.set(session.session_id, session);
    return session;
  }

  /** Fetch one RMP session. Local mode returns the buffered session, if any. */
  async get(sessionId: string): Promise<RmpSession | undefined> {
    if (apiBase(this.client)) {
      const res = await requestJson(
        this.client,
        "GET",
        `/v1/rmp/sessions/${encodeURIComponent(sessionId)}`,
      );
      return (res.session ?? res) as unknown as RmpSession;
    }
    return this.local.get(sessionId);
  }

  /** List RMP sessions. Local mode lists in-process sessions. */
  async list(): Promise<RmpSession[]> {
    if (apiBase(this.client)) {
      const res = await requestJson(this.client, "GET", "/v1/rmp/sessions");
      return extractList<RmpSession>(res, "sessions");
    }
    return [...this.local.values()];
  }

  /** Generate the loop report for a session. */
  async report(sessionId: string): Promise<RmpReport> {
    if (apiBase(this.client)) {
      const res = await requestJson(
        this.client,
        "POST",
        `/v1/rmp/sessions/${encodeURIComponent(sessionId)}/report`,
        {},
      );
      return (res.report ?? res) as unknown as RmpReport;
    }
    const session = this.local.get(sessionId);
    return {
      report_version: RMP_REPORT_VERSION,
      session_id: sessionId,
      generated_at: nowIso(),
      ...(session ? { agent_id: session.agent_id } : {}),
      summary: { event_count: 0, finding_count: 0, alert_count: 0 },
    };
  }
}

// ---------------------------------------------------------------------------
// ReviewResource — pre-release scenario testing + enrichment approvals
// ---------------------------------------------------------------------------

/** The `client.review` namespace. */
export class ReviewResource {
  private readonly localScenarios: TestScenario[] = [];
  private readonly localProposals = new Map<string, ScenarioEnrichmentProposal>();

  constructor(private readonly client: AgenomicClient) {}

  /** Run a Review pass over an agent. Local mode returns a stub outcome. */
  async run(options: ReviewRunOptions): Promise<ReviewOutcome> {
    if (apiBase(this.client)) {
      const body = {
        spec_version: RMP_SPEC_VERSION,
        agent_id: options.agent,
        ...(options.scenarios ? { scenarios: options.scenarios } : {}),
        ...(options.riskMatrix ? { risk_matrix: options.riskMatrix } : {}),
      };
      const res = await requestJson(this.client, "POST", "/v1/review/runs", body);
      return (res.run ?? res) as unknown as ReviewOutcome;
    }
    return {
      result: "pass",
      run_id: createId("rev"),
      agent_id: options.agent,
      scenario_results: [],
    };
  }

  /** List review scenarios. Local mode lists in-process scenarios. */
  async listScenarios(): Promise<TestScenario[]> {
    if (apiBase(this.client)) {
      const res = await requestJson(this.client, "GET", "/v1/review/scenarios");
      return extractList<TestScenario>(res, "scenarios");
    }
    return [...this.localScenarios];
  }

  /** Add a review scenario to the suite. */
  async addScenario(scenario: TestScenarioInput): Promise<TestScenario> {
    const wire: TestScenario = {
      scenario_id: scenario.scenarioId ?? createId("scn"),
      source: scenario.source ?? "manual",
      severity: scenario.severity ?? "medium",
      ...(scenario.name ? { name: scenario.name } : {}),
      ...(scenario.description ? { description: scenario.description } : {}),
      ...(scenario.inputs ? { inputs: scenario.inputs } : {}),
      ...(scenario.expected ? { expected: scenario.expected } : {}),
      ...(scenario.tags ? { tags: scenario.tags } : {}),
    };
    if (apiBase(this.client)) {
      const res = await requestJson(this.client, "POST", "/v1/review/scenarios", wire);
      return (res.scenario ?? res) as unknown as TestScenario;
    }
    this.localScenarios.push(wire);
    return wire;
  }

  /**
   * Approve a scenario-enrichment proposal (the human-in-the-loop step that
   * closes the Monitor/Protect → Review feedback loop). Local mode flips the
   * buffered proposal's status to `"approved"` (upserting a minimal record if
   * the proposal is not buffered yet).
   */
  async approveScenarioEnrichment(
    options: ApproveScenarioEnrichmentOptions,
  ): Promise<ScenarioEnrichmentProposal> {
    if (apiBase(this.client)) {
      const res = await requestJson(
        this.client,
        "POST",
        `/v1/review/proposals/${encodeURIComponent(options.proposalId)}/approve`,
        {
          ...(options.sessionId ? { session_id: options.sessionId } : {}),
          ...(options.reviewer ? { reviewer: options.reviewer } : {}),
        },
      );
      return (res.proposal ?? res) as unknown as ScenarioEnrichmentProposal;
    }
    const existing = this.localProposals.get(options.proposalId);
    const approved: ScenarioEnrichmentProposal = {
      proposal_id: options.proposalId,
      human_approval_required: true,
      ...existing,
      status: "approved",
      ...(options.sessionId ? { session_id: options.sessionId } : {}),
      ...(options.reviewer ? { reviewed_by: options.reviewer } : {}),
    };
    this.localProposals.set(options.proposalId, approved);
    return approved;
  }

  /** Scenario-enrichment proposals buffered in local mode. */
  get proposals(): readonly ScenarioEnrichmentProposal[] {
    return [...this.localProposals.values()];
  }
}

// ---------------------------------------------------------------------------
// MonitorResource — runtime detection sessions
// ---------------------------------------------------------------------------

/**
 * A live Monitor session. In cloud mode each event is POSTed; in local mode
 * events are buffered on the session.
 */
export class MonitorSession {
  readonly sessionId: string;
  readonly agentId: string;
  readonly environment: string;
  private readonly client: AgenomicClient;
  private readonly cloud: boolean;
  private seq = 0;
  private stopped = false;
  private readonly buffered: WireMonitorEvent[] = [];

  constructor(
    client: AgenomicClient,
    init: { sessionId: string; agentId: string; environment: string },
  ) {
    this.client = client;
    this.sessionId = init.sessionId;
    this.agentId = init.agentId;
    this.environment = init.environment;
    this.cloud = Boolean(apiBase(client));
  }

  /** Events buffered in local mode (empty in cloud mode). */
  get events(): readonly WireMonitorEvent[] {
    return this.buffered;
  }

  /** Emit one runtime event. Stamps ids/sequencing; requires a `type`. */
  async event(input: MonitorEventInput): Promise<WireMonitorEvent> {
    if (this.stopped) {
      throw new Error("monitor session already stopped");
    }
    if (typeof input.type !== "string" || input.type.length === 0) {
      throw new Error("monitor event requires a non-empty string `type`");
    }
    const wire: WireMonitorEvent = {
      ...input,
      spec_version: RMP_SPEC_VERSION,
      event_id: createId("evt"),
      session_id: this.sessionId,
      timestamp: nowIso(),
      sequence_number: this.seq++,
      type: input.type,
      agent_id: this.agentId,
    };
    if (this.cloud) {
      await requestJson(
        this.client,
        "POST",
        `/v1/monitor/sessions/${encodeURIComponent(this.sessionId)}/events`,
        wire,
      );
    } else {
      this.buffered.push(wire);
    }
    return wire;
  }

  /** Finalize the session. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    // Mark stopped only after a successful stop so a failed cloud POST stays
    // retryable and the remote session isn't orphaned.
    if (this.cloud) {
      await requestJson(
        this.client,
        "POST",
        `/v1/monitor/sessions/${encodeURIComponent(this.sessionId)}/stop`,
        {},
      );
    }
    this.stopped = true;
  }
}

/** The `client.monitor` namespace. */
export class MonitorResource {
  private readonly localSessions = new Map<string, MonitorSession>();

  constructor(private readonly client: AgenomicClient) {}

  /** Start a Monitor session. */
  async start(options: MonitorStartOptions): Promise<MonitorSession> {
    const environment = options.environment ?? "production";
    if (apiBase(this.client)) {
      const body = {
        spec_version: RMP_SPEC_VERSION,
        agent_id: options.agent,
        environment,
        ...(options.releaseId ? { release_id: options.releaseId } : {}),
        ...(options.ledger !== undefined ? { ledger: options.ledger } : {}),
      };
      const res = await requestJson(this.client, "POST", "/v1/monitor/sessions", body);
      const sessionId = requireSessionId(res, "monitor");
      return new MonitorSession(this.client, {
        sessionId,
        agentId: options.agent,
        environment,
      });
    }
    const session = new MonitorSession(this.client, {
      sessionId: createId("mon"),
      agentId: options.agent,
      environment,
    });
    this.localSessions.set(session.sessionId, session);
    return session;
  }

  /**
   * Emit an event onto a session by id (resource-level convenience).
   *
   * The event is stamped with the RMP wire metadata before posting, like
   * `MonitorSession.event()`. Since no session state exists here, callers
   * may supply `agent_id` / `sequence_number` in the input to override the
   * defaults (`""` / `0`); the server orders events by its own session
   * record and deduplicates on `event_id`.
   */
  async event(options: {
    sessionId: string;
    event: MonitorEventInput;
  }): Promise<WireMonitorEvent> {
    if (apiBase(this.client)) {
      const input = options.event;
      if (typeof input.type !== "string" || input.type.length === 0) {
        throw new Error("monitor event requires a non-empty string `type`");
      }
      const wire: WireMonitorEvent = {
        ...input,
        spec_version: RMP_SPEC_VERSION,
        event_id: typeof input.event_id === "string" ? input.event_id : createId("evt"),
        session_id: options.sessionId,
        timestamp: typeof input.timestamp === "string" ? input.timestamp : nowIso(),
        sequence_number:
          typeof input.sequence_number === "number" ? input.sequence_number : 0,
        type: input.type,
        agent_id: typeof input.agent_id === "string" ? input.agent_id : "",
      };
      const res = await requestJson(
        this.client,
        "POST",
        `/v1/monitor/sessions/${encodeURIComponent(options.sessionId)}/events`,
        wire,
      );
      return (res.event ?? res) as unknown as WireMonitorEvent;
    }
    const session = this.localSessions.get(options.sessionId);
    if (!session) {
      throw new Error(`unknown local monitor session: ${options.sessionId}`);
    }
    return session.event(options.event);
  }

  /** Fetch detection findings for a session. Local mode returns `[]`. */
  async findings(options: { sessionId: string }): Promise<Finding[]> {
    if (apiBase(this.client)) {
      const res = await requestJson(
        this.client,
        "GET",
        `/v1/monitor/sessions/${encodeURIComponent(options.sessionId)}/findings`,
      );
      return extractList<Finding>(res, "findings");
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// ProtectResource — alerting / mitigation
// ---------------------------------------------------------------------------

/** The `client.protect` namespace. Local-mode reads never throw. */
export class ProtectResource {
  constructor(private readonly client: AgenomicClient) {}

  /** List alerts for a session. Local mode returns `[]`. */
  async alerts(options: { sessionId: string }): Promise<Alert[]> {
    if (apiBase(this.client)) {
      const res = await requestJson(
        this.client,
        "GET",
        `/v1/protect/alerts?session_id=${encodeURIComponent(options.sessionId)}`,
      );
      return extractList<Alert>(res, "alerts");
    }
    return [];
  }

  /** Generate an action plan for an alert. Local mode returns an empty plan. */
  async actionPlan(options: { alertId: string; sessionId?: string }): Promise<ActionPlan> {
    if (apiBase(this.client)) {
      const res = await requestJson(
        this.client,
        "POST",
        `/v1/protect/alerts/${encodeURIComponent(options.alertId)}/action-plan`,
        options.sessionId ? { session_id: options.sessionId } : {},
      );
      return (res.plan ?? res) as unknown as ActionPlan;
    }
    return {
      plan_id: createId("plan"),
      alert_id: options.alertId,
      steps: [],
      ...(options.sessionId ? { session_id: options.sessionId } : {}),
      created_at: nowIso(),
    };
  }

  /** List remediation recommendations for a session. Local mode returns `[]`. */
  async recommendations(options: { sessionId: string }): Promise<Recommendation[]> {
    if (apiBase(this.client)) {
      const res = await requestJson(
        this.client,
        "GET",
        `/v1/protect/recommendations?session_id=${encodeURIComponent(options.sessionId)}`,
      );
      return extractList<Recommendation>(res, "recommendations");
    }
    return [];
  }

  /** Route (notify) an alert to its configured channels. */
  async notify(options: {
    alertId: string;
    sessionId?: string;
  }): Promise<Record<string, unknown>> {
    if (apiBase(this.client)) {
      return requestJson(
        this.client,
        "POST",
        `/v1/protect/alerts/${encodeURIComponent(options.alertId)}/route`,
        options.sessionId ? { session_id: options.sessionId } : {},
      );
    }
    return { alert_id: options.alertId, routed: false, routes: [] };
  }
}
