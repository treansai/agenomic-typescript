import { exportTracesToJsonl } from "./exporters/jsonl";
import { sendTraceToHttp } from "./exporters/http";
import type {
  AgenomicClientOptions,
  CreateTraceInput,
  TraceEnvelope,
} from "./models";
import { TraceEnvelopeSchema } from "./schemas";
import { TrackingResource } from "./tracking";
import { TraceBuilder } from "./tracing";

export class AgenomicClient {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly baseUrl?: string;
  readonly headers?: Record<string, string>;
  /** Online tracking of production agents (drift / loops / intent / harness). */
  readonly tracking: TrackingResource;

  constructor(options: AgenomicClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint;
    this.baseUrl = options.baseUrl;
    this.headers = options.headers;
    this.tracking = new TrackingResource(this);
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
