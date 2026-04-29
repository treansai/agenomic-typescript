import { describe, expect, it } from "vitest";

import { TraceEnvelopeSchema } from "../src/schemas";

describe("schemas", () => {
  it("parses a valid trace envelope", () => {
    const parsed = TraceEnvelopeSchema.parse({
      specVersion: "agentlock.trace.v1",
      generatedAt: new Date().toISOString(),
      run: {
        traceId: "trace_1",
        runId: "run_1",
        agentId: "claims-agent",
        startedAt: new Date().toISOString(),
        status: "success",
      },
      events: [],
    });

    expect(parsed.run.agentId).toBe("claims-agent");
  });

  it("rejects an invalid run status", () => {
    expect(() =>
      TraceEnvelopeSchema.parse({
        specVersion: "agentlock.trace.v1",
        generatedAt: new Date().toISOString(),
        run: {
          traceId: "trace_1",
          runId: "run_1",
          agentId: "claims-agent",
          startedAt: new Date().toISOString(),
          status: "done",
        },
        events: [],
      }),
    ).toThrow();
  });
});
