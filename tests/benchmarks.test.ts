import { afterEach, describe, expect, it, vi } from "vitest";

import { AgenomicClient, BridgeServer, type AgentTargetBridge, type TurnRequest } from "../src";

interface Call {
  url: string;
  method?: string;
  body?: unknown;
  auth?: string;
}

function stubFetch(respond: (url: string, call: Call) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
        auth: (init?.headers as Record<string, string>)?.authorization,
      };
      calls.push(call);
      const payload = respond(url, call);
      if (payload === null) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(payload), { status: 200 });
    }),
  );
  return calls;
}

const turn = {
  turn_id: "bturn_1",
  request: {
    messages: [{ role: "user", content: "do the task" }],
    tools: [{ name: "send_email", parameters: { type: "object" } }],
    context: {
      benchmark_id: "agentdojo",
      run_id: "brun_1",
      trial_id: "btrial_1",
      task_id: "user_task_0",
      trial_index: 0,
      turn_index: 0,
      max_turns: 5,
      instructions: "be helpful",
      target: "customer_agent",
    },
  },
};

describe("benchmarks (cloud only)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses to run locally and never touches rmp.start", async () => {
    const client = new AgenomicClient();
    await expect(client.benchmarks.catalog()).rejects.toThrow(/cloud client/);
    const session = await client.rmp.start({ agent: "agent://acme/support" });
    expect(session.session_id.startsWith("rmp_")).toBe(true);
  });

  it("plans, preflights and launches through the documented routes", async () => {
    const calls = stubFetch((url) => {
      if (url.endsWith("/benchmarks/plans")) return { plan: { plan_id: "bplan_1", status: "draft" } };
      if (url.endsWith("/preflight")) return { plan: { plan_id: "bplan_1", status: "preflight_passed" } };
      if (url.endsWith("/launch")) return { plan: { plan_id: "bplan_1" }, runs: [{ run_id: "brun_1" }], already_launched: false };
      if (url.includes("/decide")) return { policy: { proposal_id: "bpol_1", status: "approved", manifest_hash: "blake3:x" } };
      return {};
    });
    const client = new AgenomicClient({ apiKey: "key_123", baseUrl: "https://api.test" });
    const plan = await client.benchmarks.createPlan("rmp_1", [
      { benchmark_id: "agentdojo", benchmark_version: "v0.1.35", scope: { domains: ["workspace"] }, profile: "smoke" },
    ]);
    expect(plan.plan_id).toBe("bplan_1");
    expect(calls[0]?.url).toBe("https://api.test/v1/rmp/sessions/rmp_1/benchmarks/plans");
    expect(calls[0]?.auth).toBe("Bearer key_123");
    expect(calls[0]?.body).toEqual({
      target: "customer_agent",
      selections: [{ benchmark_id: "agentdojo", benchmark_version: "v0.1.35", scope: { domains: ["workspace"] }, profile: "smoke" }],
      budget: {},
    });
    expect((await client.benchmarks.preflight("bplan_1")).status).toBe("preflight_passed");
    const launched = await client.benchmarks.launch("bplan_1");
    expect(launched.already_launched).toBe(false);
    expect(launched.runs[0]?.run_id).toBe("brun_1");
    const decided = await client.benchmarks.decidePolicy("bpol_1", "approved", { manifestHash: "blake3:x" });
    expect(decided.status).toBe("approved");
    expect(calls.at(-1)?.body).toEqual({ to: "approved", manifest_hash: "blake3:x" });
  });

  it("serves the customer's agent to relayed turns", async () => {
    const calls = stubFetch((url) => {
      if (url.endsWith("/bridge/register")) return { bridge_id: "b1" };
      if (url.includes("/bridge/turns/next")) return { turn };
      if (url.includes("/reply")) return { turn: { turn_id: "bturn_1", status: "answered" } };
      return {};
    });
    const seen: TurnRequest[] = [];
    const bridge: AgentTargetBridge = {
      capabilities: ["multi_turn", "benchmark_tools"],
      handleTurn(request) {
        seen.push(request);
        return { toolCalls: [{ id: "c1", name: request.tools[0]?.name ?? "", arguments: { to: "x" } }], usage: { input_tokens: 3, output_tokens: 1 } };
      },
    };
    const client = new AgenomicClient({ apiKey: "key_123", baseUrl: "https://api.test" });
    const server = new BridgeServer(client, bridge, { agent: "agent://acme/support", releaseId: "rel_1", bridgeId: "b1", maxTurns: 1 });
    expect(await server.serve()).toBe(1);
    expect(seen[0]?.taskId).toBe("user_task_0");
    expect(seen[0]?.instructions).toBe("be helpful");
    expect(calls[0]?.body).toMatchObject({ agent_id: "agent://acme/support", release_id: "rel_1", bridge_id: "b1", capabilities: ["multi_turn", "benchmark_tools"] });
    expect(calls[1]?.url).toContain("agent_id=agent%3A%2F%2Facme%2Fsupport");
    expect(calls[1]?.url).toContain("release_id=rel_1");
    expect(calls[2]?.url).toBe("https://api.test/v1/rmp/benchmarks/bridge/turns/bturn_1/reply");
    expect(calls[2]?.body).toEqual({
      reply: {
        message: { role: "assistant", content: null, tool_calls: [{ id: "c1", name: "send_email", arguments: { to: "x" } }] },
        usage: { input_tokens: 3, output_tokens: 1 },
        stop: false,
      },
    });
  });

  it("treats 204 from the long poll as nothing to do", async () => {
    stubFetch((url) => (url.includes("/bridge/turns/next") ? null : {}));
    const client = new AgenomicClient({ apiKey: "k", baseUrl: "https://api.test" });
    const server = new BridgeServer(client, { capabilities: ["multi_turn"], handleTurn: () => ({ content: "x" }) }, { agent: "a", bridgeId: "b" });
    await server.register();
    expect(await server.pollOnce()).toBe(false);
  });
});
