import { describe, expect, it } from "vitest";

import { AgenomicClient } from "../src/client";
import { getCurrentTrace, traceAgentRun, type TraceBuilder } from "../src/tracing";

describe("traceAgentRun", () => {
  it("captures success traces with hashes and events", async () => {
    const client = new AgenomicClient();
    let capturedTrace: TraceBuilder | undefined;

    const wrapped = traceAgentRun(
      {
        client,
        agentId: "claims-agent",
        redact: ["customer.email"],
      },
      async (
        payload: {
          customer: {
            email: string;
          };
        },
        trace,
      ) => {
        capturedTrace = trace;
        expect(getCurrentTrace()).toBe(trace);

        trace.addToolCall({
          type: "tool_call",
          toolName: "claims.lookup",
          input: payload,
          output: { found: true },
        });

        return {
          ok: true,
          customer: payload.customer,
        };
      },
    );

    const result = await wrapped({
      customer: {
        email: "user@example.com",
      },
    });

    expect(result.ok).toBe(true);

    const envelope = capturedTrace?.build();
    expect(envelope?.run.status).toBe("success");
    expect(envelope?.run.inputHash).toBeDefined();
    expect(envelope?.run.outputHash).toBeDefined();
    expect(envelope?.run.input).toEqual({
      customer: {
        email: "[REDACTED]",
      },
    });
    expect(envelope?.events).toHaveLength(2);
  });

  it("captures errors and rethrows", async () => {
    const client = new AgenomicClient();
    let capturedTrace: TraceBuilder | undefined;

    const wrapped = traceAgentRun(
      {
        client,
        agentId: "failing-agent",
      },
      async (_payload: Record<string, never>, trace) => {
        capturedTrace = trace;
        throw new Error("boom");
      },
    );

    await expect(wrapped({})).rejects.toThrow("boom");

    const envelope = capturedTrace?.build();
    expect(envelope?.run.status).toBe("error");
    expect(envelope?.run.error?.message).toBe("boom");
    expect(envelope?.events.at(-1)?.type).toBe("run_completed");
  });
});
