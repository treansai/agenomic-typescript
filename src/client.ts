import { exportTracesToJsonl } from "./exporters/jsonl";
import { sendTraceToHttp } from "./exporters/http";
import type {
  AgentLockClientOptions,
  CreateTraceInput,
  TraceEnvelope,
} from "./models";
import { TraceEnvelopeSchema } from "./schemas";
import { TraceBuilder } from "./tracing";

export class AgentLockClient {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly headers?: Record<string, string>;

  constructor(options: AgentLockClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint;
    this.headers = options.headers;
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
