/**
 * RMP benchmarks (cloud only).
 *
 * `client.benchmarks` plans, preflights, launches and follows benchmark runs
 * under an RMP session (`/v1/rmp/benchmarks`), and `BridgeServer` serves the
 * customer's own agent to the turns Agenomic relays from its isolated
 * benchmark runners. `rmp.start()` is untouched: it never launches anything.
 *
 * There is deliberately no local mode here. Without a `baseUrl`/`endpoint`
 * every method throws instead of returning fabricated results.
 */

import type { AgenomicClient } from "./client";

export const BENCHMARKS_SPEC_VERSION = "agenomic.rmp.benchmarks/v0.1";

// ---------------------------------------------------------------------------
// Wire types (snake_case, structural; mirrors crates/agenomic-benchmarks)
// ---------------------------------------------------------------------------

export type BridgeCapability =
  | "multi_turn"
  | "benchmark_tools"
  | "code_execution"
  | "mcp_tools"
  | "environment_reset";

export interface BenchmarkSelection {
  benchmark_id: string;
  benchmark_version: string;
  scope?: {
    domains?: string[];
    splits?: string[];
    categories?: string[];
    task_ids?: string[];
    injection_families?: string[];
    defense?: string;
    servers?: string[];
    max_tasks?: number;
  };
  profile?: "smoke" | "standard" | "statistical";
  repetitions?: number;
  limits?: {
    max_turns_per_trial: number;
    max_tool_calls_per_trial: number;
    max_agent_tokens_per_trial?: number;
    timeout_seconds_per_trial: number;
  };
  requirement?: "required" | "advisory";
  auxiliary?: { user_simulator?: string; judge?: string; injection_model?: string };
  secret_refs?: string[];
  gates?: {
    gate_id: string;
    metric_id: string;
    operator: "gte" | "gt" | "lte" | "lt";
    threshold: number;
    min_evaluable?: number;
    coverage_required?: boolean;
    unknown_policy?: "inconclusive" | "fail";
  }[];
  compare_controls?: boolean;
}

export interface BenchmarkCatalogEntry {
  card: Record<string, unknown> & { id: string; name: string };
  availability: { state: string; reason: string; corrective_action: string | null };
  agent_compatibility: { state: string; reason: string; corrective_action: string | null };
}

export interface BenchmarkPlan {
  plan_id: string;
  rmp_session_id: string;
  agent_id: string;
  release_id?: string | null;
  status: string;
  revision: number;
  selections: BenchmarkSelection[];
  preflight?: Record<string, unknown> | null;
  manifest_hash?: string | null;
  run_ids?: string[];
  [key: string]: unknown;
}

export interface BenchmarkRun {
  run_id: string;
  plan_id: string;
  benchmark_id: string;
  status: string;
  verdict: string;
  phase: string;
  counts: Record<string, number>;
  [key: string]: unknown;
}

export interface BenchmarkPlanView {
  plan: BenchmarkPlan;
  runs: BenchmarkRun[];
  overall_verdict: string;
  overall_reason: string;
  customer_evaluation: boolean;
}

export interface BenchmarkRunDetail {
  run: BenchmarkRun;
  trials: Record<string, unknown>[];
  events: Record<string, unknown>[];
  next_event_cursor: number;
}

export interface LaunchOutcome {
  plan: BenchmarkPlan;
  runs: BenchmarkRun[];
  already_launched: boolean;
}

export interface PolicyProposal {
  proposal_id: string;
  status: string;
  manifest_hash: string;
  [key: string]: unknown;
}

export interface TurnToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface TurnMessage {
  role: string;
  content?: string | null;
  tool_calls?: TurnToolCall[];
  tool_call_id?: string | null;
  name?: string | null;
}

export interface TurnToolSpec {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface TurnRequest {
  turnId: string;
  messages: TurnMessage[];
  tools: TurnToolSpec[];
  instructions?: string | null;
  benchmarkId: string;
  runId: string;
  trialId: string;
  taskId: string;
  trialIndex: number;
  turnIndex: number;
  maxTurns: number;
  trackingSessionId?: string | null;
  target: string;
}

export interface TurnReply {
  content?: string | null;
  toolCalls?: TurnToolCall[];
  usage?: { input_tokens: number; output_tokens: number };
  stop?: boolean;
}

/** Implemented by the customer's runtime; the benchmark's tools replace
 *  production tools and are executed by the benchmark environment. */
export interface AgentTargetBridge {
  capabilities: BridgeCapability[];
  handleTurn(turn: TurnRequest): Promise<TurnReply> | TurnReply;
  startTrial?(turn: TurnRequest): void | Promise<void>;
  endTrial?(trialId: string): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// HTTP helpers (same conventions as rmp.ts)
// ---------------------------------------------------------------------------

function apiBase(client: AgenomicClient): string | undefined {
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
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const base = apiBase(client);
  if (!base) {
    throw new Error("benchmarks need a cloud client (baseUrl); nothing runs locally");
  }
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...authHeaders(client),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 204) return {};
  if (!response.ok) {
    throw new Error(
      `Agenomic benchmarks ${path} failed with ${response.status} ${response.statusText}`,
    );
  }
  const text = await response.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function unwrap<T>(res: Record<string, unknown>, key: string): T {
  return (res[key] ?? res) as T;
}

function list<T>(res: Record<string, unknown>, key: string): T[] {
  const value = res[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Resource
// ---------------------------------------------------------------------------

export class BenchmarksResource {
  constructor(private readonly client: AgenomicClient) {}

  async catalog(options: { agent?: string; releaseId?: string } = {}): Promise<BenchmarkCatalogEntry[]> {
    const params = new URLSearchParams();
    if (options.agent) params.set("agent_id", options.agent);
    if (options.releaseId) params.set("release_id", options.releaseId);
    const query = params.toString();
    const res = await requestJson(this.client, "GET", `/v1/rmp/benchmarks/catalog${query ? `?${query}` : ""}`);
    return list<BenchmarkCatalogEntry>(res, "benchmarks");
  }

  async createPlan(
    sessionId: string,
    selections: BenchmarkSelection[],
    options: {
      target?: "customer_agent" | "model_with_reference_agent" | "adapter_test_fixture";
      budget?: Record<string, unknown>;
      baselinePlanId?: string;
    } = {},
  ): Promise<BenchmarkPlan> {
    const body: Record<string, unknown> = {
      target: options.target ?? "customer_agent",
      selections,
      budget: options.budget ?? {},
    };
    if (options.baselinePlanId) body.baseline_plan_id = options.baselinePlanId;
    const res = await requestJson(this.client, "POST", `/v1/rmp/sessions/${enc(sessionId)}/benchmarks/plans`, body);
    return unwrap<BenchmarkPlan>(res, "plan");
  }

  async listPlans(sessionId: string): Promise<BenchmarkPlan[]> {
    const res = await requestJson(this.client, "GET", `/v1/rmp/sessions/${enc(sessionId)}/benchmarks/plans`);
    return list<BenchmarkPlan>(res, "plans");
  }

  async getPlan(planId: string): Promise<BenchmarkPlanView> {
    const res = await requestJson(this.client, "GET", `/v1/rmp/benchmarks/plans/${enc(planId)}`);
    return unwrap<BenchmarkPlanView>(res, "view");
  }

  async updatePlan(
    planId: string,
    selections: BenchmarkSelection[],
    options: { budget?: Record<string, unknown>; target?: string } = {},
  ): Promise<BenchmarkPlan> {
    const body: Record<string, unknown> = { selections };
    if (options.budget !== undefined) body.budget = options.budget;
    if (options.target !== undefined) body.target = options.target;
    const res = await requestJson(this.client, "PUT", `/v1/rmp/benchmarks/plans/${enc(planId)}`, body);
    return unwrap<BenchmarkPlan>(res, "plan");
  }

  async preflight(planId: string): Promise<BenchmarkPlan> {
    const res = await requestJson(this.client, "POST", `/v1/rmp/benchmarks/plans/${enc(planId)}/preflight`, {});
    return unwrap<BenchmarkPlan>(res, "plan");
  }

  /** Idempotent asynchronous launch. */
  async launch(planId: string): Promise<LaunchOutcome> {
    const res = await requestJson(this.client, "POST", `/v1/rmp/benchmarks/plans/${enc(planId)}/launch`, {});
    return res as unknown as LaunchOutcome;
  }

  async cancelPlan(planId: string): Promise<BenchmarkPlanView> {
    const res = await requestJson(this.client, "POST", `/v1/rmp/benchmarks/plans/${enc(planId)}/cancel`, {});
    return unwrap<BenchmarkPlanView>(res, "view");
  }

  async compare(planId: string, baselinePlanId: string): Promise<Record<string, unknown>> {
    const res = await requestJson(
      this.client,
      "GET",
      `/v1/rmp/benchmarks/plans/${enc(planId)}/compare?baseline=${enc(baselinePlanId)}`,
    );
    return unwrap<Record<string, unknown>>(res, "comparison");
  }

  async listRuns(sessionId: string, limit = 50): Promise<BenchmarkRun[]> {
    const res = await requestJson(this.client, "GET", `/v1/rmp/benchmarks/runs?session_id=${enc(sessionId)}&limit=${limit}`);
    return list<BenchmarkRun>(res, "runs");
  }

  async getRun(runId: string, options: { after?: number; limit?: number } = {}): Promise<BenchmarkRunDetail> {
    const res = await requestJson(
      this.client,
      "GET",
      `/v1/rmp/benchmarks/runs/${enc(runId)}?after=${options.after ?? 0}&limit=${options.limit ?? 200}`,
    );
    return res as unknown as BenchmarkRunDetail;
  }

  async cancelRun(runId: string): Promise<BenchmarkRun> {
    const res = await requestJson(this.client, "POST", `/v1/rmp/benchmarks/runs/${enc(runId)}/cancel`, {});
    return unwrap<BenchmarkRun>(res, "run");
  }

  async listPolicies(options: { agent?: string; planId?: string } = {}): Promise<PolicyProposal[]> {
    const params = new URLSearchParams();
    if (options.agent) params.set("agent_id", options.agent);
    if (options.planId) params.set("plan_id", options.planId);
    const query = params.toString();
    const res = await requestJson(this.client, "GET", `/v1/rmp/benchmarks/policies${query ? `?${query}` : ""}`);
    return list<PolicyProposal>(res, "policies");
  }

  async proposePolicy(proposal: Record<string, unknown>): Promise<PolicyProposal> {
    const res = await requestJson(this.client, "POST", "/v1/rmp/benchmarks/policies", proposal);
    return unwrap<PolicyProposal>(res, "policy");
  }

  /** Approval and activation must cite the exact manifest hash. */
  async decidePolicy(
    proposalId: string,
    to: string,
    options: { manifestHash?: string; note?: string } = {},
  ): Promise<PolicyProposal> {
    const body: Record<string, unknown> = { to };
    if (options.manifestHash !== undefined) body.manifest_hash = options.manifestHash;
    if (options.note !== undefined) body.note = options.note;
    const res = await requestJson(this.client, "POST", `/v1/rmp/benchmarks/policies/${enc(proposalId)}/decide`, body);
    return unwrap<PolicyProposal>(res, "policy");
  }
}

// ---------------------------------------------------------------------------
// Bridge server
// ---------------------------------------------------------------------------

export interface BridgeServeOptions {
  agent: string;
  releaseId?: string;
  bridgeId?: string;
  waitSeconds?: number;
  maxTurns?: number;
  idleTimeoutMs?: number;
  sdk?: string;
}

interface WireTurn {
  turn_id: string;
  request: {
    messages: TurnMessage[];
    tools: TurnToolSpec[];
    context: {
      benchmark_id: string;
      run_id: string;
      trial_id: string;
      task_id: string;
      trial_index: number;
      turn_index: number;
      max_turns: number;
      instructions?: string | null;
      tracking_session_id?: string | null;
      target: string;
    };
  };
}

function toTurnRequest(turn: WireTurn): TurnRequest {
  const ctx = turn.request.context;
  return {
    turnId: turn.turn_id,
    messages: turn.request.messages ?? [],
    tools: turn.request.tools ?? [],
    instructions: ctx.instructions ?? null,
    benchmarkId: ctx.benchmark_id,
    runId: ctx.run_id,
    trialId: ctx.trial_id,
    taskId: ctx.task_id,
    trialIndex: ctx.trial_index ?? 0,
    turnIndex: ctx.turn_index ?? 0,
    maxTurns: ctx.max_turns ?? 0,
    trackingSessionId: ctx.tracking_session_id ?? null,
    target: ctx.target ?? "customer_agent",
  };
}

const BRIDGE_HEARTBEAT_MS = 60_000;

/** Registers the bridge, long-polls turns and answers them with the
 *  customer's agent. Replies are idempotent on the cloud side. */
export class BridgeServer {
  readonly bridgeId: string;
  private stopped = false;
  private lastHeartbeat = 0;
  private currentTrial: string | null = null;
  turnsAnswered = 0;

  constructor(
    private readonly client: AgenomicClient,
    private readonly bridge: AgentTargetBridge,
    private readonly options: BridgeServeOptions,
  ) {
    if (!apiBase(client)) {
      throw new Error("the benchmark bridge needs a cloud client (baseUrl)");
    }
    this.bridgeId = options.bridgeId ?? `bridge_${Math.random().toString(36).slice(2, 12)}`;
  }

  async register(): Promise<Record<string, unknown>> {
    this.lastHeartbeat = Date.now();
    return requestJson(this.client, "POST", "/v1/rmp/benchmarks/bridge/register", {
      agent_id: this.options.agent,
      release_id: this.options.releaseId ?? null,
      bridge_id: this.bridgeId,
      capabilities: this.bridge.capabilities,
      sdk: this.options.sdk ?? "agenomic-typescript",
    });
  }

  async pollOnce(): Promise<boolean> {
    if (Date.now() - this.lastHeartbeat > BRIDGE_HEARTBEAT_MS) await this.register();
    const params = new URLSearchParams({
      agent_id: this.options.agent,
      bridge_id: this.bridgeId,
      wait: String(Math.max(0, Math.min(this.options.waitSeconds ?? 20, 25))),
    });
    if (this.options.releaseId) params.set("release_id", this.options.releaseId);
    const res = await requestJson(this.client, "GET", `/v1/rmp/benchmarks/bridge/turns/next?${params.toString()}`);
    const turn = res.turn as WireTurn | undefined;
    if (!turn) return false;
    const request = toTurnRequest(turn);
    if (request.trialId !== this.currentTrial) {
      if (this.currentTrial !== null) await this.bridge.endTrial?.(this.currentTrial);
      this.currentTrial = request.trialId;
      await this.bridge.startTrial?.(request);
    }
    let reply: TurnReply;
    try {
      reply = await this.bridge.handleTurn(request);
    } catch (error) {
      reply = { content: `[bridge error] ${error instanceof Error ? error.message : String(error)}`, stop: true };
    }
    await requestJson(this.client, "POST", `/v1/rmp/benchmarks/bridge/turns/${enc(request.turnId)}/reply`, {
      reply: {
        message: { role: "assistant", content: reply.content ?? null, tool_calls: reply.toolCalls ?? [] },
        usage: reply.usage ?? null,
        stop: reply.stop ?? false,
      },
    });
    this.turnsAnswered += 1;
    return true;
  }

  async serve(): Promise<number> {
    await this.register();
    let idleSince = Date.now();
    try {
      while (!this.stopped) {
        const handled = await this.pollOnce();
        const now = Date.now();
        if (handled) {
          idleSince = now;
          if (this.options.maxTurns !== undefined && this.turnsAnswered >= this.options.maxTurns) break;
        } else if (this.options.idleTimeoutMs !== undefined && now - idleSince >= this.options.idleTimeoutMs) {
          break;
        }
      }
    } finally {
      const trial = this.currentTrial;
      this.currentTrial = null;
      if (trial !== null) await this.bridge.endTrial?.(trial);
    }
    return this.turnsAnswered;
  }

  stop(): void {
    this.stopped = true;
  }
}
