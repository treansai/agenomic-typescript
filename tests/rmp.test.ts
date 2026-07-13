import { afterEach, describe, expect, it, vi } from "vitest";

import { AgenomicClient } from "../src/client";

describe("RMP (local mode)", () => {
  it("constructs a spec-shaped rmp session with an rmp_ id", async () => {
    const client = new AgenomicClient();
    const session = await client.rmp.start({
      agent: "agent://treans/claims-agent",
      releaseId: "release_123",
      ledger: true,
      genomeHash: "blake3:abc",
    });

    expect(session.session_id).toMatch(/^rmp_/);
    expect(session).toMatchObject({
      spec_version: "agenomic.rmp/v0.1",
      agent_id: "agent://treans/claims-agent",
      environment: "production",
      status: "active",
      release_id: "release_123",
      genome_hash: "blake3:abc",
      ledger_enabled: true,
    });

    // buffered session is readable back
    expect(await client.rmp.get(session.session_id)).toEqual(session);
    expect(await client.rmp.list()).toEqual([session]);
    expect(await client.rmp.get("rmp_missing")).toBeUndefined();

    const report = await client.rmp.report(session.session_id);
    expect(report).toMatchObject({
      report_version: "agenomic.rmp.report/v0.1",
      session_id: session.session_id,
      agent_id: "agent://treans/claims-agent",
      summary: { event_count: 0, finding_count: 0, alert_count: 0 },
    });
  });

  it("monitor sessions stamp and buffer events", async () => {
    const client = new AgenomicClient();
    const session = await client.monitor.start({ agent: "agent://acme/a" });
    expect(session.sessionId).toMatch(/^mon_/);

    await session.event({ type: "tool.call.completed", tool_name: "db.lookup" });
    const second = await session.event({ type: "loop.detected" });

    expect(session.events).toHaveLength(2);
    expect(session.events[0]).toMatchObject({
      spec_version: "agenomic.rmp/v0.1",
      session_id: session.sessionId,
      sequence_number: 0,
      type: "tool.call.completed",
      agent_id: "agent://acme/a",
      tool_name: "db.lookup",
    });
    expect(session.events[0]!.event_id).toMatch(/^evt_/);
    expect(typeof session.events[0]!.timestamp).toBe("string");
    expect(second.sequence_number).toBe(1);
  });

  it("rejects monitor events without a type", async () => {
    const client = new AgenomicClient();
    const session = await client.monitor.start({ agent: "agent://acme/a" });
    // deliberately malformed input
    await expect(
      session.event({ type: "" } as { type: string }),
    ).rejects.toThrow(/non-empty string `type`/);
    expect(session.events).toHaveLength(0);
  });

  it("stop() is idempotent and events after stop throw", async () => {
    const client = new AgenomicClient();
    const session = await client.monitor.start({ agent: "agent://acme/a" });
    await session.stop();
    await expect(session.stop()).resolves.toBeUndefined();
    await expect(session.event({ type: "x" })).rejects.toThrow(/stopped/);
  });

  it("resource-level monitor.event routes to the local session buffer", async () => {
    const client = new AgenomicClient();
    const session = await client.monitor.start({ agent: "agent://acme/a" });
    await client.monitor.event({
      sessionId: session.sessionId,
      event: { type: "drift.detected" },
    });
    expect(session.events).toHaveLength(1);
    expect(await client.monitor.findings({ sessionId: session.sessionId })).toEqual([]);
  });

  it("protect reads return empty data and never throw", async () => {
    const client = new AgenomicClient();
    await expect(client.protect.alerts({ sessionId: "rmp_x" })).resolves.toEqual([]);
    await expect(
      client.protect.recommendations({ sessionId: "rmp_x" }),
    ).resolves.toEqual([]);
    const plan = await client.protect.actionPlan({ alertId: "al_1", sessionId: "rmp_x" });
    expect(plan).toMatchObject({ alert_id: "al_1", session_id: "rmp_x", steps: [] });
    expect(plan.plan_id).toMatch(/^plan_/);
    await expect(client.protect.notify({ alertId: "al_1" })).resolves.toMatchObject({
      alert_id: "al_1",
      routed: false,
    });
  });

  it("review runs a stub pass and buffers scenarios", async () => {
    const client = new AgenomicClient();
    const outcome = await client.review.run({ agent: "agent://acme/a" });
    expect(outcome).toMatchObject({ result: "pass", agent_id: "agent://acme/a" });

    const scenario = await client.review.addScenario({
      name: "prompt injection via tool output",
      source: "incident_derived",
      severity: "high",
    });
    expect(scenario.scenario_id).toMatch(/^scn_/);
    expect(await client.review.listScenarios()).toEqual([scenario]);
  });

  it("review approves a scenario-enrichment proposal locally", async () => {
    const client = new AgenomicClient();
    const proposal = await client.review.approveScenarioEnrichment({
      proposalId: "prop_1",
      reviewer: "gabin",
    });
    expect(proposal).toMatchObject({
      proposal_id: "prop_1",
      status: "approved",
      human_approval_required: true,
      reviewed_by: "gabin",
    });
    // buffered status is flipped (idempotently) to approved
    const again = await client.review.approveScenarioEnrichment({ proposalId: "prop_1" });
    expect(again.status).toBe("approved");
    expect(client.review.proposals).toHaveLength(1);
    expect(client.review.proposals[0]!.status).toBe("approved");
  });
});

describe("RMP (cloud mode)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  interface Call {
    url: string;
    method?: string;
    body?: unknown;
    auth?: string;
  }

  function stubFetch(respond: (url: string) => unknown): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          method: init?.method,
          body: init?.body ? JSON.parse(init.body as string) : undefined,
          auth: (init?.headers as Record<string, string>)?.authorization,
        });
        return new Response(JSON.stringify(respond(url)), { status: 200 });
      }),
    );
    return calls;
  }

  function cloudClient(): AgenomicClient {
    return new AgenomicClient({
      apiKey: "key_123",
      baseUrl: "https://api.agenomic.dev/",
    });
  }

  it("rmp.start POSTs the snake_case session body", async () => {
    const calls = stubFetch(() => ({ session: { session_id: "rmp_cloud_1" } }));
    const session = await cloudClient().rmp.start({
      agent: "agent://treans/claims-agent",
      releaseId: "release_123",
      ledger: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api.agenomic.dev/v1/rmp/sessions",
      method: "POST",
      auth: "Bearer key_123",
      body: {
        spec_version: "agenomic.rmp/v0.1",
        agent_id: "agent://treans/claims-agent",
        environment: "production",
        release_id: "release_123",
        ledger: true,
      },
    });
    expect(session.session_id).toBe("rmp_cloud_1");
  });

  it("monitor sessions POST stamped events", async () => {
    const calls = stubFetch((url) =>
      url.endsWith("/sessions") ? { session: { session_id: "mon_cloud_1" } } : {},
    );
    const client = cloudClient();
    const session = await client.monitor.start({ agent: "agent://acme/a" });
    expect(session.sessionId).toBe("mon_cloud_1");

    await session.event({ type: "tool.call.completed", tool_name: "db.lookup" });
    await session.stop();
    await session.stop(); // idempotent: no extra POST

    expect(calls).toHaveLength(3);
    expect(calls[1]).toMatchObject({
      url: "https://api.agenomic.dev/v1/monitor/sessions/mon_cloud_1/events",
      method: "POST",
      auth: "Bearer key_123",
      body: {
        spec_version: "agenomic.rmp/v0.1",
        session_id: "mon_cloud_1",
        sequence_number: 0,
        type: "tool.call.completed",
        agent_id: "agent://acme/a",
        tool_name: "db.lookup",
      },
    });
    expect(calls[2]!.url).toBe(
      "https://api.agenomic.dev/v1/monitor/sessions/mon_cloud_1/stop",
    );
    // events are not buffered in cloud mode
    expect(session.events).toHaveLength(0);
  });

  it("resource-level monitor.event stamps wire metadata in cloud mode", async () => {
    const calls = stubFetch(() => ({}));
    await cloudClient().monitor.event({
      sessionId: "mon_cloud_9",
      event: { type: "tool.call.completed", tool_name: "db.lookup" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api.agenomic.dev/v1/monitor/sessions/mon_cloud_9/events",
      method: "POST",
      body: {
        spec_version: "agenomic.rmp/v0.1",
        session_id: "mon_cloud_9",
        sequence_number: 0,
        type: "tool.call.completed",
        tool_name: "db.lookup",
      },
    });
    const body = calls[0]!.body as Record<string, unknown>;
    expect(typeof body.event_id).toBe("string");
    expect(typeof body.timestamp).toBe("string");
  });

  it("protect.alerts GETs with a session_id query", async () => {
    const alert = {
      alert_id: "al_1",
      severity: "high",
      status: "open",
      dedup_key: "loop:agent://acme/a",
      occurrence_count: 3,
      routes: ["slack"],
      throttled: false,
      escalated: true,
    };
    const calls = stubFetch(() => ({ alerts: [alert] }));
    const alerts = await cloudClient().protect.alerts({ sessionId: "rmp_1" });

    expect(calls[0]).toMatchObject({
      url: "https://api.agenomic.dev/v1/protect/alerts?session_id=rmp_1",
      method: "GET",
      auth: "Bearer key_123",
    });
    expect(calls[0]!.body).toBeUndefined();
    expect(alerts).toEqual([alert]);
  });

  it("protect.actionPlan POSTs to the alert action-plan route", async () => {
    const plan = { plan_id: "plan_1", alert_id: "al_1", steps: [] };
    const calls = stubFetch(() => ({ plan }));
    const result = await cloudClient().protect.actionPlan({
      alertId: "al_1",
      sessionId: "rmp_1",
    });

    expect(calls[0]).toMatchObject({
      url: "https://api.agenomic.dev/v1/protect/alerts/al_1/action-plan",
      method: "POST",
      auth: "Bearer key_123",
      body: { session_id: "rmp_1" },
    });
    expect(result).toEqual(plan);
  });

  it("review.approveScenarioEnrichment POSTs to the proposal approve route", async () => {
    const proposal = {
      proposal_id: "prop_1",
      status: "approved",
      human_approval_required: true,
    };
    const calls = stubFetch(() => ({ proposal }));
    const result = await cloudClient().review.approveScenarioEnrichment({
      proposalId: "prop_1",
      sessionId: "rmp_1",
      reviewer: "gabin",
    });

    expect(calls[0]).toMatchObject({
      url: "https://api.agenomic.dev/v1/review/proposals/prop_1/approve",
      method: "POST",
      auth: "Bearer key_123",
      body: { session_id: "rmp_1", reviewer: "gabin" },
    });
    expect(result).toEqual(proposal);
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500, statusText: "err" })),
    );
    await expect(cloudClient().rmp.start({ agent: "agent://a/b" })).rejects.toThrow(
      /failed with 500/,
    );
  });
});
