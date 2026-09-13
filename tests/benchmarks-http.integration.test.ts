import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { AgenomicClient, BridgeServer, type AgentTargetBridge, type BenchmarkSelection, type TurnRequest } from "../src";

interface Exchange {
  method: "GET" | "POST" | "PUT";
  path: string;
  response?: unknown;
  status?: number;
  body?: unknown;
}

async function withHttpGateway(exchanges: Exchange[], run: (baseUrl: string) => Promise<void>): Promise<void> {
  const pending = [...exchanges];
  const errors: unknown[] = [];
  const gateway = createServer(async (request, response) => {
    try {
      const expected = pending.shift();
      expect(expected, `unexpected ${request.method} ${request.url}`).toBeDefined();
      expect(request.method).toBe(expected?.method);
      expect(request.url).toBe(expected?.path);
      expect(request.headers.authorization).toBe("Bearer integration-key");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      expect(raw ? JSON.parse(raw) : undefined).toEqual(expected?.body);
      if (raw) expect(request.headers["content-type"]).toBe("application/json");
      response.writeHead(expected?.status ?? 200, { "content-type": "application/json" });
      response.end(expected?.status === 204 ? undefined : JSON.stringify(expected?.response ?? {}));
    } catch (error) {
      errors.push(error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unexpected request" }));
    }
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  try {
    await run(`http://127.0.0.1:${(gateway.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
    expect(errors).toEqual([]);
    expect(pending).toEqual([]);
  }
}

function wireTurn(turnId: string, trialId: string, turnIndex: number) {
  return {
    turn_id: turnId,
    deadline_at: "2030-01-01T00:00:00Z",
    request: {
      messages: [{ role: "user", content: "Vérifie le café ☕" }],
      tools: [{ name: "lookup", parameters: { type: "object" } }],
      context: {
        benchmark_id: "agentdojo", run_id: "run_1", trial_id: trialId,
        task_id: "task_1", trial_index: 0, turn_index: turnIndex, max_turns: 3,
        instructions: "Utilise les outils du benchmark", tracking_session_id: "tracking_1", target: "customer_agent",
      },
    },
  };
}

function registration(status = 200): Exchange {
  return {
    method: "POST", path: "/v1/rmp/benchmarks/bridge/register", status,
    response: { bridge_id: "bridge_1" },
    body: {
      agent_id: "agent://acme/support", release_id: "release_1", bridge_id: "bridge_1",
      capabilities: ["multi_turn", "benchmark_tools"], sdk: "agenomic-typescript",
    },
  };
}

const NEXT = "/v1/rmp/benchmarks/bridge/turns/next?agent_id=agent%3A%2F%2Facme%2Fsupport&bridge_id=bridge_1&wait=0&release_id=release_1";
const TOOL_CALL = { id: "call_1", name: "lookup", arguments: { q: "café" } };
const USAGE = { input_tokens: 3, output_tokens: 2 };
const WIRE_REPLY = { reply: { message: { role: "assistant", content: null, tool_calls: [TOOL_CALL] }, usage: USAGE, stop: false } };

function recordingBridge(events: string[]): AgentTargetBridge {
  return {
    capabilities: ["multi_turn", "benchmark_tools"],
    async startTrial(turn: TurnRequest) { events.push(`start:${turn.trialId}`); },
    async handleTurn(turn: TurnRequest) {
      events.push(`handle:${turn.turnId}`);
      expect(turn.messages[0]?.content).toBe("Vérifie le café ☕");
      expect(turn.trackingSessionId).toBe("tracking_1");
      if (turn.trialId === "trial_2") throw new Error("agent failed");
      return { toolCalls: [TOOL_CALL], usage: USAGE };
    },
    async endTrial(trialId: string) { events.push(`end:${trialId}`); },
  };
}

function bridgeServer(baseUrl: string, bridge: AgentTargetBridge, options = {}) {
  return new BridgeServer(new AgenomicClient({ baseUrl, apiKey: "integration-key" }), bridge, {
    agent: "agent://acme/support", releaseId: "release_1", bridgeId: "bridge_1", waitSeconds: 0, ...options,
  });
}

describe("benchmarks integration over real HTTP with a scripted gateway", () => {
  it("serves multiple turns, resets trial state and reports asynchronous agent failures", async () => {
    const events: string[] = [];
    const exchanges: Exchange[] = [registration()];
    for (const [turnId, trialId, turnIndex] of [["turn_1", "trial_1", 0], ["turn_2", "trial_1", 1], ["turn_3", "trial_2", 0]] as const) {
      exchanges.push(
        { method: "GET", path: NEXT, response: { turn: wireTurn(turnId, trialId, turnIndex) } },
        {
          method: "POST", path: `/v1/rmp/benchmarks/bridge/turns/${turnId}/reply`, response: { turn: { status: "answered" } },
          body: trialId === "trial_2"
            ? { reply: { message: { role: "assistant", content: "[bridge error] agent failed", tool_calls: [] }, usage: null, stop: true } }
            : WIRE_REPLY,
        },
      );
    }
    await withHttpGateway(exchanges, async (baseUrl) => {
      expect(await bridgeServer(baseUrl, recordingBridge(events), { maxTurns: 3 }).serve()).toBe(3);
    });
    expect(events).toEqual(["start:trial_1", "handle:turn_1", "handle:turn_2", "end:trial_1", "start:trial_2", "handle:turn_3", "end:trial_2"]);
  });

  it("treats an empty HTTP 204 poll as idle", async () => {
    const events: string[] = [];
    await withHttpGateway([registration(), { method: "GET", path: NEXT, status: 204 }], async (baseUrl) => {
      expect(await bridgeServer(baseUrl, recordingBridge(events), { idleTimeoutMs: 0 }).serve()).toBe(0);
    });
    expect(events).toEqual([]);
  });

  it.each([401, 403])("propagates HTTP %i authorization failure before polling", async (status) => {
    const events: string[] = [];
    await withHttpGateway([registration(status)], async (baseUrl) => {
      const server = bridgeServer(baseUrl, recordingBridge(events), { maxTurns: 1 });
      await expect(server.serve()).rejects.toThrow(String(status));
      expect(server.turnsAnswered).toBe(0);
    });
    expect(events).toEqual([]);
  });

  it("does not count a rejected turn reply as answered", async () => {
    const exchanges: Exchange[] = [
      registration(),
      { method: "GET", path: NEXT, response: { turn: wireTurn("turn_1", "trial_1", 0) } },
      { method: "POST", path: "/v1/rmp/benchmarks/bridge/turns/turn_1/reply", status: 409, body: WIRE_REPLY },
    ];
    await withHttpGateway(exchanges, async (baseUrl) => {
      const server = bridgeServer(baseUrl, recordingBridge([]), { maxTurns: 1 });
      await expect(server.serve()).rejects.toThrow("409");
      expect(server.turnsAnswered).toBe(0);
    });
  });

  it("updates, launches, follows, compares and cancels plans through HTTP", async () => {
    const selections: BenchmarkSelection[] = [{ benchmark_id: "agentdojo", benchmark_version: "v0.1.35", profile: "smoke" }];
    const plan = { plan_id: "plan_1", status: "draft" };
    const run = { run_id: "run_1", status: "running" };
    const exchanges: Exchange[] = [
      { method: "POST", path: "/v1/rmp/sessions/session_1/benchmarks/plans", response: { plan }, body: { target: "customer_agent", selections, budget: { max_total_trials: 2 } } },
      { method: "PUT", path: "/v1/rmp/benchmarks/plans/plan_1", response: { plan: { ...plan, revision: 2 } }, body: { selections, budget: {} } },
      { method: "POST", path: "/v1/rmp/benchmarks/plans/plan_1/preflight", response: { plan: { ...plan, status: "preflight_passed" } }, body: {} },
      { method: "POST", path: "/v1/rmp/benchmarks/plans/plan_1/launch", response: { plan, runs: [run], already_launched: false }, body: {} },
      { method: "POST", path: "/v1/rmp/benchmarks/plans/plan_1/launch", response: { plan, runs: [run], already_launched: true }, body: {} },
      { method: "GET", path: "/v1/rmp/benchmarks/plans/plan_1/compare?baseline=baseline%2F1%3F%26", response: { comparison: { paired_tasks: 1 } } },
      { method: "GET", path: "/v1/rmp/benchmarks/runs/run_1?after=7&limit=3", response: { run, trials: [], events: [{ sequence: 8 }], next_event_cursor: 8 } },
      { method: "POST", path: "/v1/rmp/benchmarks/runs/run_1/cancel", response: { run: { ...run, status: "cancelled" } }, body: {} },
      { method: "POST", path: "/v1/rmp/benchmarks/plans/plan_1/cancel", response: { view: { plan: { ...plan, status: "cancelled" } } }, body: {} },
    ];
    await withHttpGateway(exchanges, async (baseUrl) => {
      const benchmarks = new AgenomicClient({ baseUrl: baseUrl + "/", apiKey: "integration-key" }).benchmarks;
      expect(await benchmarks.createPlan("session_1", selections, { budget: { max_total_trials: 2 } })).toEqual(plan);
      expect((await benchmarks.updatePlan("plan_1", selections, { budget: {} })).revision).toBe(2);
      expect((await benchmarks.preflight("plan_1")).status).toBe("preflight_passed");
      expect((await benchmarks.launch("plan_1")).already_launched).toBe(false);
      expect((await benchmarks.launch("plan_1")).already_launched).toBe(true);
      expect(await benchmarks.compare("plan_1", "baseline/1?&")).toEqual({ paired_tasks: 1 });
      expect((await benchmarks.getRun("run_1", { after: 7, limit: 3 })).next_event_cursor).toBe(8);
      expect((await benchmarks.cancelRun("run_1")).status).toBe("cancelled");
      expect((await benchmarks.cancelPlan("plan_1")).plan.status).toBe("cancelled");
    });
  });
});
