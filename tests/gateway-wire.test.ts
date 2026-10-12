import { afterEach, describe, expect, it, vi } from "vitest";

import { AgenomicClient } from "../src/client";
import { sendTraceToHttp } from "../src/exporters/http";
import type { TrackingEventType } from "../src/tracking";

const AGENT_UUID = "1e004ebf-0a2f-4b93-ad7e-d87c91fdb385";
const AGENTS_LISTING = {
  agents: [
    { id: "2f1b3c52-0000-4000-8000-000000000001", name: "other", slug: "other-aa11" },
    { id: AGENT_UUID, name: "portab-claims", slug: "portab-claims-03cca6" },
  ],
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any;
}

function stubFetch(handlers: Record<string, () => Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const key = `${init.method ?? "GET"} ${new URL(url).pathname}`;
      const handler = handlers[key];
      if (!handler) throw new Error(`unexpected request ${key}`);
      return handler();
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function buildTrace(client: AgenomicClient) {
  const trace = client.createTrace({
    agentId: "agent://portab/portab-claims",
    release: "v1.1.0",
    input: { q: "hi" },
  });
  trace.addToolCall({
    type: "tool_call",
    toolName: "claims.policy.evaluate",
    input: { q: "hi" },
    output: { ok: true },
  });
  trace.complete({ output: { a: "HI" } });
  return trace;
}

describe("trace emit against the gateway wire format", () => {
  it("posts a CreateTraceRequest with the resolved agent UUID", async () => {
    const calls = stubFetch({
      "GET /v1/agents": () => Response.json(AGENTS_LISTING),
      "POST /v1/traces": () => Response.json({ trace: { id: "t1" } }, { status: 201 }),
    });
    const client = new AgenomicClient({
      apiKey: "k",
      endpoint: "http://127.0.0.1:8090/v1/traces",
    });
    const trace = buildTrace(client);
    const envelope = await trace.emit();

    const post = calls.find((call) => call.method === "POST");
    expect(post?.url).toBe("http://127.0.0.1:8090/v1/traces");
    expect(Object.keys(post?.body).sort()).toEqual([
      "agent_id",
      "events",
      "external_id",
      "payload",
    ]);
    expect(post?.body.agent_id).toBe(AGENT_UUID);
    expect(post?.body.external_id).toBe(envelope.run.traceId);
    expect(post?.body.payload.run.agentId).toBe("agent://portab/portab-claims");
    expect(post?.body.events.map((e: any) => e.event_type)).toEqual([
      "tool_call",
      "run_completed",
    ]);
    expect(post?.headers.authorization).toBe("Bearer k");
  });

  it("reuses the resolved UUID across emits", async () => {
    const calls = stubFetch({
      "GET /v1/agents": () => Response.json(AGENTS_LISTING),
      "POST /v1/traces": () => Response.json({}, { status: 201 }),
    });
    const client = new AgenomicClient({ endpoint: "http://127.0.0.1:8090/v1/traces" });
    await buildTrace(client).emit();
    await buildTrace(client).emit();
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(1);
  });

  it("skips the lookup when the agent id is already a UUID", async () => {
    const calls = stubFetch({
      "POST /v1/traces": () => Response.json({}, { status: 201 }),
    });
    const client = new AgenomicClient({ endpoint: "http://127.0.0.1:8090/v1/traces" });
    const trace = client.createTrace({ agentId: AGENT_UUID, input: {} });
    trace.complete({});
    await trace.emit();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.agent_id).toBe(AGENT_UUID);
  });

  it("fails clearly when the agent is unknown", async () => {
    stubFetch({ "GET /v1/agents": () => Response.json({ agents: [] }) });
    const client = new AgenomicClient({ endpoint: "http://127.0.0.1:8090/v1/traces" });
    await expect(buildTrace(client).emit()).rejects.toThrow(/Cannot resolve agent/);
  });

  it("sendTraceToHttp honours an explicit agentUuid", async () => {
    const calls = stubFetch({
      "POST /v1/traces": () => Response.json({}, { status: 201 }),
    });
    const client = new AgenomicClient();
    const envelope = buildTrace(client).build();
    await sendTraceToHttp("http://127.0.0.1:8090/v1/traces", envelope, {
      agentUuid: AGENT_UUID,
    });
    expect(calls[0]?.body.agent_id).toBe(AGENT_UUID);
  });
});

describe("tracking event types", () => {
  it("accepts the gateway vocabulary", () => {
    const types: TrackingEventType[] = [
      "agent.step.failed",
      "turn.started",
      "model.call.failed",
      "tool.call.failed",
      "retrieval.completed",
      "knowledge.retrieve",
    ];
    expect(types).toHaveLength(6);
  });
});
