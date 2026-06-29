/**
 * Online tracking instrumentation.
 *
 * `client.tracking.start(...)` opens a {@link TrackingSession} for a production
 * agent release. Events emitted on the session are sent to Agenomic Cloud (when
 * the client has an `endpoint`) or buffered locally otherwise. The wire format
 * is the spec's snake_case `tracking-event` shape — a production-time
 * projection of the canonical trace / ATEP event model — so the cloud and CLI
 * engines (drift / loop / intent / harness detection) consume it unchanged.
 *
 * Detection itself runs server-side or in the CLI; the SDK's job is faithful,
 * redaction-safe instrumentation.
 */

import type { AgenomicClient } from "./client";
import { createId, nowIso } from "./utils";

export type TrackingEventType =
  | "agent.started"
  | "agent.step.started"
  | "agent.step.completed"
  | "model.call.started"
  | "model.call.completed"
  | "tool.call.started"
  | "tool.call.completed"
  | "memory.read"
  | "memory.write"
  | "policy.evaluated"
  | "intent.detected"
  | "loop.detected"
  | "drift.detected"
  | "harness.violation"
  | "alert.created"
  | "agent.completed"
  | "agent.failed";

export interface TrackingStartOptions {
  /** Canonical agent id, e.g. `agent://org/name`. */
  agent: string;
  releaseId?: string;
  bundleId?: string;
  genomeHash?: string;
  environment?: string;
  /** Detector thresholds (loops/intent/drift); forwarded verbatim to the API. */
  trackingConfig?: Record<string, unknown>;
}

export interface TrackingEventInput {
  type: TrackingEventType;
  parentEventId?: string;
  workflowStepId?: string;
  toolName?: string;
  toolProtocol?: string;
  toolPermissions?: string[];
  modelProvider?: string;
  model?: string;
  temperature?: number;
  inputHash?: string;
  outputHash?: string;
  intent?: string;
  redactedPreview?: unknown;
  policyResult?: {
    policyId?: string;
    outcome: "allow" | "deny" | "review";
    denies?: string[];
  };
  metadata?: Record<string, unknown>;
}

/** The snake_case wire shape (`schemas/v0.3/tracking-event.schema.json`). */
export interface WireTrackingEvent {
  spec_version: "agenomic/v0.3";
  event_id: string;
  session_id: string;
  timestamp: string;
  sequence_number: number;
  type: TrackingEventType;
  agent_id: string;
  parent_event_id?: string;
  workflow_step_id?: string;
  tool?: { name: string; protocol?: string; permissions?: string[] };
  model?: { provider: string; model: string; temperature?: number };
  input_hash?: string;
  output_hash?: string;
  intent?: string;
  redacted_preview?: unknown;
  policy_result?: { policy_id?: string; outcome: string; denies?: string[] };
  metadata?: Record<string, unknown>;
}

function baseUrl(client: AgenomicClient): string | undefined {
  return client.endpoint ? client.endpoint.replace(/\/+$/, "") : undefined;
}

async function postJson(
  client: AgenomicClient,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const base = baseUrl(client);
  if (!base) {
    throw new Error("tracking cloud call requires an endpoint on the client");
  }
  const response = await fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(client.apiKey ? { authorization: `Bearer ${client.apiKey}` } : {}),
      ...client.headers,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `Agenomic tracking ${path} failed with ${response.status} ${response.statusText}`,
    );
  }
  const text = await response.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/**
 * A live online-tracking session. In cloud mode each emit is POSTed; in local
 * mode events are buffered and can be exported as JSONL.
 */
export class TrackingSession {
  readonly sessionId: string;
  readonly agentId: string;
  readonly environment: string;
  private readonly client: AgenomicClient;
  private readonly cloud: boolean;
  private seq = 0;
  private stopped = false;
  private readonly buffered: WireTrackingEvent[] = [];

  constructor(
    client: AgenomicClient,
    init: { sessionId: string; agentId: string; environment: string },
  ) {
    this.client = client;
    this.sessionId = init.sessionId;
    this.agentId = init.agentId;
    this.environment = init.environment;
    this.cloud = Boolean(baseUrl(client));
  }

  /** Events buffered in local mode (empty in cloud mode). */
  get events(): readonly WireTrackingEvent[] {
    return this.buffered;
  }

  private toWire(input: TrackingEventInput): WireTrackingEvent {
    const ev: WireTrackingEvent = {
      spec_version: "agenomic/v0.3",
      event_id: createId("evt"),
      session_id: this.sessionId,
      timestamp: nowIso(),
      sequence_number: this.seq++,
      type: input.type,
      agent_id: this.agentId,
    };
    if (input.parentEventId) ev.parent_event_id = input.parentEventId;
    if (input.workflowStepId) ev.workflow_step_id = input.workflowStepId;
    if (input.toolName) {
      ev.tool = {
        name: input.toolName,
        ...(input.toolProtocol ? { protocol: input.toolProtocol } : {}),
        ...(input.toolPermissions ? { permissions: input.toolPermissions } : {}),
      };
    }
    if (input.modelProvider || input.model) {
      ev.model = {
        provider: input.modelProvider ?? "",
        model: input.model ?? "",
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      };
    }
    if (input.inputHash) ev.input_hash = input.inputHash;
    if (input.outputHash) ev.output_hash = input.outputHash;
    if (input.intent) ev.intent = input.intent;
    if (input.redactedPreview !== undefined) ev.redacted_preview = input.redactedPreview;
    if (input.policyResult) {
      ev.policy_result = {
        ...(input.policyResult.policyId ? { policy_id: input.policyResult.policyId } : {}),
        outcome: input.policyResult.outcome,
        ...(input.policyResult.denies ? { denies: input.policyResult.denies } : {}),
      };
    }
    if (input.metadata) ev.metadata = input.metadata;
    return ev;
  }

  /** Emit one runtime event. */
  async event(input: TrackingEventInput): Promise<WireTrackingEvent> {
    if (this.stopped) {
      throw new Error("tracking session already stopped");
    }
    const wire = this.toWire(input);
    if (this.cloud) {
      await postJson(this.client, `/v1/tracking/sessions/${this.sessionId}/events`, wire);
    } else {
      this.buffered.push(wire);
    }
    return wire;
  }

  /**
   * Run `fn` inside a workflow step, emitting `agent.step.started` before and
   * `agent.step.completed` after (or `agent.failed` on throw). When called
   * without `fn`, returns a handle whose `end()` closes the step.
   */
  async step<T>(name: string, fn?: () => Promise<T> | T): Promise<T | { end: () => Promise<void> }> {
    await this.event({ type: "agent.step.started", workflowStepId: name });
    if (!fn) {
      return {
        end: async () => {
          await this.event({ type: "agent.step.completed", workflowStepId: name });
        },
      };
    }
    try {
      const result = await fn();
      await this.event({ type: "agent.step.completed", workflowStepId: name });
      return result;
    } catch (error) {
      await this.event({
        type: "agent.failed",
        workflowStepId: name,
        metadata: { status: "error" },
      });
      throw error;
    }
  }

  modelCall(opts: {
    provider: string;
    model: string;
    temperature?: number;
    inputHash?: string;
    outputHash?: string;
  }): Promise<WireTrackingEvent> {
    return this.event({
      type: "model.call.completed",
      modelProvider: opts.provider,
      model: opts.model,
      temperature: opts.temperature,
      inputHash: opts.inputHash,
      outputHash: opts.outputHash,
    });
  }

  toolCall(opts: {
    toolName: string;
    protocol?: string;
    permissions?: string[];
    inputHash?: string;
    outputHash?: string;
  }): Promise<WireTrackingEvent> {
    return this.event({
      type: "tool.call.completed",
      toolName: opts.toolName,
      toolProtocol: opts.protocol,
      toolPermissions: opts.permissions,
      inputHash: opts.inputHash,
      outputHash: opts.outputHash,
    });
  }

  intent(value: string): Promise<WireTrackingEvent> {
    return this.event({ type: "intent.detected", intent: value });
  }

  memoryWrite(opts: { schemaVersion?: string; outputHash?: string } = {}): Promise<WireTrackingEvent> {
    return this.event({
      type: "memory.write",
      outputHash: opts.outputHash,
      metadata: opts.schemaVersion ? { schema_version: opts.schemaVersion } : undefined,
    });
  }

  /** Finalize the session. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.cloud) {
      await postJson(this.client, `/v1/tracking/sessions/${this.sessionId}/stop`, {});
    }
  }

  /** Fetch the tracking report (cloud mode only). */
  async report(): Promise<Record<string, unknown>> {
    if (!this.cloud) {
      throw new Error(
        "report() requires cloud mode; in local mode export events with toJsonl() and run `agenomic track report`",
      );
    }
    const base = baseUrl(this.client)!;
    const response = await fetch(`${base}/v1/tracking/sessions/${this.sessionId}/report`, {
      headers: {
        ...(this.client.apiKey ? { authorization: `Bearer ${this.client.apiKey}` } : {}),
        ...this.client.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`Agenomic tracking report failed with ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  /** Serialize buffered local events as JSONL (one event per line). */
  toJsonl(): string {
    return this.buffered.map((e) => JSON.stringify(e)).join("\n") + (this.buffered.length ? "\n" : "");
  }
}

/** The `client.tracking` namespace. */
export class TrackingResource {
  constructor(private readonly client: AgenomicClient) {}

  /** Start a new online-tracking session. */
  async start(options: TrackingStartOptions): Promise<TrackingSession> {
    const environment = options.environment ?? "production";
    if (baseUrl(this.client)) {
      const body = {
        spec_version: "agenomic/v0.3",
        agent_id: options.agent,
        ...(options.releaseId ? { release_id: options.releaseId } : {}),
        ...(options.bundleId ? { bundle_id: options.bundleId } : {}),
        ...(options.genomeHash ? { genome_hash: options.genomeHash } : {}),
        environment,
        ...(options.trackingConfig ? { tracking_config: options.trackingConfig } : {}),
      };
      const res = await postJson(this.client, "/v1/tracking/sessions", body);
      const session = (res.session ?? res) as Record<string, unknown>;
      const sessionId = (session.session_id as string) ?? createId("trk");
      return new TrackingSession(this.client, {
        sessionId,
        agentId: options.agent,
        environment,
      });
    }
    return new TrackingSession(this.client, {
      sessionId: createId("trk"),
      agentId: options.agent,
      environment,
    });
  }
}
