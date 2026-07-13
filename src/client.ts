import { exportTracesToJsonl } from "./exporters/jsonl";
import { sendTraceToHttp } from "./exporters/http";
import type {
  AgenomicClientOptions,
  CreateTraceInput,
  TraceEnvelope,
} from "./models";
import { TraceEnvelopeSchema } from "./schemas";
import { ModelsResource } from "./models-resource";
import {
  MonitorResource,
  ProtectResource,
  ReviewResource,
  RmpResource,
} from "./rmp";
import { TrackingResource } from "./tracking";
import { TraceBuilder } from "./tracing";

export class AgenomicClient {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly baseUrl?: string;
  readonly headers?: Record<string, string>;
  /** Online tracking of production agents (drift / loops / intent / harness). */
  readonly tracking: TrackingResource;
  /** Model configuration (provider-agnostic; validates known providers). */
  readonly models: ModelsResource;
  /** Review · Monitor · Protect loop sessions (`agenomic.rmp/v0.1`). */
  readonly rmp: RmpResource;
  /** Pre-release scenario testing and enrichment approvals. */
  readonly review: ReviewResource;
  /** Runtime detection sessions and findings. */
  readonly monitor: MonitorResource;
  /** Alerts, action plans, recommendations, and routing. */
  readonly protect: ProtectResource;

  constructor(options: AgenomicClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint;
    this.baseUrl = options.baseUrl;
    this.headers = options.headers;
    this.tracking = new TrackingResource(this);
    this.models = new ModelsResource(this);
    this.rmp = new RmpResource(this);
    this.review = new ReviewResource(this);
    this.monitor = new MonitorResource(this);
    this.protect = new ProtectResource(this);
  }

  async emitTrace(trace: TraceEnvelope): Promise<void> {
    const payload = TraceEnvelopeSchema.parse(trace);
    if (!this.endpoint) {
      return;
    }

    await sendTraceToHttp(this.endpoint, payload, {
      apiKey: this.apiKey,
      headers: this.headers,
    });
  }

  async exportJsonl(path: string, traces: TraceEnvelope[]): Promise<void> {
    const payload = traces.map((trace) => TraceEnvelopeSchema.parse(trace));
    await exportTracesToJsonl(path, payload);
  }

  createTrace(input: CreateTraceInput): TraceBuilder {
    return new TraceBuilder({
      ...input,
      client: this,
    });
  }
}
