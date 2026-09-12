// Tool execution for replays: the Tool Gateway client and a lightweight
// router. The runtime keeps its own orchestration; each tool call is posted
// as a normalized invocation and the cloud routes it to a real backend (with
// server-side credentials) or to the Tool Mock Engine according to the run's
// explicit per-tool bindings. Nothing here ever falls back to a real call.

import type { AgenomicClient } from "./client";

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
export type ToolInvocationStatus = "success" | "error" | "aborted" | "timeout";
export type ToolExternalState = "none" | "confirmed" | "indeterminate";

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
}

/** Native tool result plus the Agenomic technical envelope. */
export interface ToolCallResult<T = unknown> {
  result: T;
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

function apiBase(client: AgenomicClient): string | undefined {
  const raw = client.baseUrl ?? client.endpoint;
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "").replace(/\/v1\/traces$/, "");
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

  constructor(private readonly client: AgenomicClient) {}

  private async request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const base = apiBase(this.client);
    if (!base) {
      throw new ToolExecutionError(
        "cloud_required",
        "tool execution requires a baseUrl on the client; there is no local fallback",
        0,
      );
    }
    let response: Response;
    try {
      response = await fetch(base + path, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(this.client.apiKey ? { authorization: `Bearer ${this.client.apiKey}` } : {}),
          ...this.client.headers,
          ...extraHeaders,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new ToolExecutionError("transport_error", `${method} ${path} failed: ${String(error)}`, 0);
    }
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const error = (parsed.error ?? {}) as { code?: string; message?: string };
      throw new ToolExecutionError(
        error.code ?? "http_error",
        error.message ?? `${method} ${path} returned ${response.status}`,
        response.status,
      );
    }
    return parsed;
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
    return (res.run ?? {}) as Record<string, unknown>;
  }

  async getRun(runId: string): Promise<Record<string, unknown>> {
    const res = await this.request("GET", `/v1/tool-execution/runs/${runId}`);
    return (res.run ?? {}) as Record<string, unknown>;
  }

  async approveRun(runId: string, planHash: string): Promise<Record<string, unknown>> {
    const res = await this.request("POST", `/v1/tool-execution/runs/${runId}/approve`, { plan_hash: planHash });
    return (res.run ?? {}) as Record<string, unknown>;
  }

  async startRun(runId: string): Promise<Record<string, unknown>> {
    const res = await this.request("POST", `/v1/tool-execution/runs/${runId}/start`, {});
    return (res.run ?? {}) as Record<string, unknown>;
  }

  async cancelRun(runId: string): Promise<Record<string, unknown>> {
    const res = await this.request("POST", `/v1/tool-execution/runs/${runId}/cancel`, {});
    return (res.run ?? {}) as Record<string, unknown>;
  }

  async completeRun(runId: string, options: { failed?: boolean; errorMessage?: string } = {}) {
    const res = await this.request("POST", `/v1/tool-execution/runs/${runId}/complete`, {
      failed: options.failed ?? false,
      ...(options.errorMessage ? { error_message: options.errorMessage } : {}),
    });
    return (res.run ?? {}) as Record<string, unknown>;
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
    const logicalCallId = options.logicalCallId ?? `call_${crypto.randomUUID().replace(/-/g, "")}`;
    const key = await stableKey([runId, String(repetition), logicalCallId]);
    const res = await this.request(
      "POST",
      `/v1/tool-execution/runs/${runId}/invoke`,
      {
        repetition,
        logical_call_id: logicalCallId,
        attempt: options.attempt ?? 1,
        tool,
        arguments: args,
        ...(options.parentCallId ? { parent_call_id: options.parentCallId } : {}),
        ...(options.deadlineMs !== undefined ? { deadline_ms: options.deadlineMs } : {}),
      },
      { "idempotency-key": key },
    );
    const envelope = res.agenomic as ToolCallEnvelope | undefined;
    if (!envelope || typeof envelope.record_id !== "string") {
      throw new ToolExecutionError("invalid_response", "invoke response did not include an agenomic envelope", 0);
    }
    return { result: res.result as T, agenomic: envelope };
  }

  /** Record a call the runtime executed itself (local adapter). */
  async reportLocal(
    runId: string,
    tool: string,
    args: Record<string, unknown>,
    result: unknown,
    options: InvokeOptions & { isError?: boolean; durationMs?: number } = {},
  ): Promise<string> {
    const res = await this.request("POST", `/v1/tool-execution/runs/${runId}/report-local`, {
      repetition: options.repetition ?? 1,
      logical_call_id: options.logicalCallId ?? `call_${crypto.randomUUID().replace(/-/g, "")}`,
      attempt: options.attempt ?? 1,
      tool,
      arguments: args,
      result,
      is_error: options.isError ?? false,
      duration_ms: options.durationMs ?? 0,
      ...(options.parentCallId ? { parent_call_id: options.parentCallId } : {}),
    });
    return String(res.record_id ?? "");
  }

  router(runId: string, options: ToolRouterOptions = {}): ToolRouter {
    return new ToolRouter(this, runId, options);
  }
}

export interface ToolRouterOptions {
  repetition?: number;
  /** Functions executed in this process and reported to the gateway. */
  localFunctions?: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>;
  raiseOnError?: boolean;
}

/** Lightweight runtime-side wrapper around one run. */
export class ToolRouter {
  readonly calls: ToolCallResult[] = [];
  private sequence = 0;

  constructor(
    private readonly tools: ToolsResource,
    readonly runId: string,
    private readonly options: ToolRouterOptions = {},
  ) {}

  private nextCallId(tool: string): string {
    this.sequence += 1;
    return `${tool}#${this.sequence}`;
  }

  async call<T = unknown>(
    tool: string,
    args: Record<string, unknown> = {},
    options: { parentCallId?: string; attempt?: number; logicalCallId?: string } = {},
  ): Promise<T> {
    const raise = this.options.raiseOnError ?? true;
    const logicalCallId = options.logicalCallId ?? this.nextCallId(tool);
    const local = this.options.localFunctions?.[tool];
    if (local) {
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
      const recordId = await this.tools.reportLocal(this.runId, tool, args, value, {
        isError,
        durationMs,
        logicalCallId,
        repetition: this.options.repetition,
        attempt: options.attempt,
        parentCallId: options.parentCallId,
      });
      const envelope: ToolCallResult = {
        result: isError ? { error: value } : value,
        agenomic: {
          record_id: recordId,
          status: isError ? "error" : "success",
          provenance: { source: "runtime_local", fidelity: "live", binding_mode: "live" },
          external_state: "confirmed",
          effects: [],
          duration_ms: durationMs,
          expected_error: false,
        },
      };
      this.calls.push(envelope);
      if (isError && raise) throw new ToolCallError(tool, envelope);
      return envelope.result as T;
    }
    const envelope = await this.tools.invoke<T>(this.runId, tool, args, {
      logicalCallId,
      repetition: this.options.repetition,
      attempt: options.attempt,
      parentCallId: options.parentCallId,
    });
    this.calls.push(envelope);
    if (raise && envelope.agenomic.status !== "success") throw new ToolCallError(tool, envelope);
    return envelope.result;
  }

  /** A function `(args) => result` routed through this run. */
  wrap<T = unknown>(tool: string): (args?: Record<string, unknown>) => Promise<T> {
    return (args = {}) => this.call<T>(tool, args);
  }

  get hasRealCalls(): boolean {
    return this.calls.some((c) => c.agenomic.provenance.source === "live" || c.agenomic.provenance.source === "runtime_local");
  }

  summary(): { calls: number; bySource: Record<string, number>; hasRealCalls: boolean } {
    const bySource: Record<string, number> = {};
    for (const c of this.calls) {
      const source = c.agenomic.provenance.source;
      bySource[source] = (bySource[source] ?? 0) + 1;
    }
    return { calls: this.calls.length, bySource, hasRealCalls: this.hasRealCalls };
  }
}
