import { afterEach, describe, expect, it, vi } from "vitest";

import { AgenomicClient } from "../src/client";
import { ToolCallError, ToolExecutionError } from "../src/tools";

const RUN = "11111111-2222-4333-8444-555555555555";
const CANARY = "tok_canary_ts_0badf00d";

interface Call {
  url: string;
  method?: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}

function envelope(result: unknown, source = "static", status = "success") {
  return {
    result,
    agenomic: {
      record_id: "rec_1",
      status,
      provenance: { source, fidelity: "contract_only", binding_mode: source === "live" ? "live" : "mock" },
      external_state: source === "live" ? "confirmed" : "none",
      effects: [],
      duration_ms: 2,
      expected_error: false,
    },
  };
}

function stubFetch(respond: (url: string, body?: Record<string, unknown>) => { status?: number; body: unknown }): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ url, method: init?.method, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const reply = respond(url, body);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  return calls;
}

function cloud(): AgenomicClient {
  return new AgenomicClient({ apiKey: "key_123", baseUrl: "https://api.agenomic.dev/" });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tools (cloud mode)", () => {
  it("refuses without a base url instead of falling back locally", async () => {
    const client = new AgenomicClient();
    await expect(client.tools.validate({ config: { schema_version: "agenomic.tool_execution/v1", mode: "mock" } })).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "cloud_required",
    });
  });

  it("stores variables write-only and reads availability without values", async () => {
    const calls = stubFetch((url) =>
      url.endsWith("/variables/CRM_API_TOKEN")
        ? { body: { name: "CRM_API_TOKEN", version: 1 } }
        : { body: { profile: { id: "p1" }, variables: [{ name: "CRM_API_TOKEN", available: true, source: "stored", version: 1 }] } },
    );
    const tools = cloud().tools;
    await tools.setVariable("p1", "CRM_API_TOKEN", CANARY);
    const status = await tools.variableStatus("p1");
    expect(calls[0]!).toMatchObject({ method: "PUT", url: "https://api.agenomic.dev/v1/tool-execution/profiles/p1/variables/CRM_API_TOKEN", body: { value: CANARY } });
    expect(status[0]!).toMatchObject({ name: "CRM_API_TOKEN", available: true });
    expect(JSON.stringify(status)).not.toContain(CANARY);
  });

  it("invokes with a normalized body and a stable idempotency key across attempts", async () => {
    const calls = stubFetch(() => ({ body: envelope({ customer: { id: "c_1" } }, "live") }));
    const tools = cloud().tools;
    const first = await tools.invoke<{ customer: { id: string } }>(RUN, "crm.get_customer", { id: "c_1" }, { logicalCallId: "c1" });
    await tools.invoke(RUN, "crm.get_customer", { id: "c_1" }, { logicalCallId: "c1", attempt: 2 });
    expect(first.result?.customer.id).toBe("c_1");
    expect(first.agenomic.provenance.source).toBe("live");
    expect(calls[0]!).toMatchObject({
      method: "POST",
      url: `https://api.agenomic.dev/v1/tool-execution/runs/${RUN}/invoke`,
      body: { repetition: 1, logical_call_id: "c1", attempt: 1, tool: "crm.get_customer", arguments: { id: "c_1" } },
    });
    expect(calls[0]!.headers.authorization).toBe("Bearer key_123");
    expect(calls[0]!.headers["idempotency-key"]).toBe(calls[1]!.headers["idempotency-key"]);
    expect(calls[1]!.body?.attempt).toBe(2);
  });

  it("router routes remote tools, reports local functions and raises typed errors", async () => {
    const calls = stubFetch((url, body) => {
      if (url.endsWith("/local/authorize")) return { body: { decision: "local", record_id: "rec_local" } };
      if (url.endsWith("/report-local")) return { body: { record_id: "rec_local" } };
      if (body?.tool === "tickets.get") return { body: envelope({ error: { code: "not_found", message: "gone" } }, "scenario", "error") };
      return { body: envelope({ delivered: true }) };
    });
    const router = cloud().tools.router(RUN, { localFunctions: { "math.add": (a) => ({ sum: Number(a.a) + Number(a.b) }) } });
    expect(await router.call("email.send", { to: "a@example.test" })).toEqual({ delivered: true });
    expect(await router.wrap<{ sum: number }>("math.add")({ a: 2, b: 3 })).toEqual({ sum: 5 });
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["invoke", "authorize", "report-local"]);
    expect(calls[1]!.body).toMatchObject({ tool: "math.add", logical_call_id: "math.add#2" });
    expect(calls[2]!.body).toMatchObject({ tool: "math.add", result: { sum: 5 }, is_error: false, logical_call_id: "math.add#2" });
    await expect(router.call("tickets.get", { ticket_id: "x" })).rejects.toBeInstanceOf(ToolCallError);
    expect(router.summary()).toEqual({ calls: 3, bySource: { static: 1, runtime_local: 1, scenario: 1 }, hasRealCalls: true, unreported: 0 });
  });

  it("offline router refuses before running local functions", async () => {
    const effects: string[] = [];
    const router = new AgenomicClient().tools.router(RUN, { localFunctions: { "email.send": () => effects.push("sent") } });
    await expect(router.call("email.send")).rejects.toMatchObject({ code: "cloud_required" });
    expect(effects).toEqual([]);
    expect(router.summary().calls).toBe(0);
  });

  it.each(["live_call_denied", "run_not_active", "live_budget_exhausted"])("%s is refused before any local side effect", async (code) => {
    const effects: string[] = [];
    const calls = stubFetch(() => ({ status: 400, body: { error: { code, message: "rejected by gateway" } } }));
    const router = cloud().tools.router(RUN, { localFunctions: { "email.send": () => effects.push("sent") } });
    await expect(router.call("email.send")).rejects.toMatchObject({ code });
    expect(effects).toEqual([]);
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["authorize"]);
  });

  it("refuses to execute when the authorization carries no record id", async () => {
    const effects: string[] = [];
    stubFetch(() => ({ body: { decision: "local" } }));
    const router = cloud().tools.router(RUN, { localFunctions: { "email.send": () => effects.push("sent") } });
    await expect(router.call("email.send")).rejects.toMatchObject({ code: "invalid_response" });
    expect(effects).toEqual([]);
    expect(router.summary().calls).toBe(0);
  });

  it("routes a mock-bound tool to the gateway instead of the local function", async () => {
    const effects: string[] = [];
    stubFetch((url) => {
      if (url.endsWith("/local/authorize")) return { body: { decision: "gateway" } };
      return { body: envelope({ delivered: true, mocked: true }) };
    });
    const router = cloud().tools.router(RUN, { localFunctions: { "email.send": () => effects.push("sent") } });
    expect(await router.call("email.send", { to: "a@example.test" })).toEqual({ delivered: true, mocked: true });
    expect(effects).toEqual([]);
    expect(router.summary().hasRealCalls).toBe(false);
  });

  it("keeps local evidence as unreported when the report fails", async () => {
    const effects: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/local/authorize")) return new Response(JSON.stringify({ decision: "local", record_id: "rec_pending" }), { status: 200 });
      return new Response("<html>Bad Gateway</html>", { status: 502 });
    });
    const router = cloud().tools.router(RUN, { localFunctions: { "email.send": () => { effects.push("sent"); return { ok: true }; } } });
    await expect(router.call("email.send", { to: "a@example.test" })).rejects.toMatchObject({ code: "http_error", status: 502 });
    expect(effects).toEqual(["sent"]);
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]!.agenomic).toMatchObject({ record_id: "rec_pending", reported: false, external_state: "indeterminate" });
    expect(router.summary()).toEqual({ calls: 1, bySource: { runtime_local: 1 }, hasRealCalls: true, unreported: 1 });
  });

  it("keeps the HTTP status on a non-JSON error body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>Bad Gateway</html>", { status: 502 }));
    await expect(cloud().tools.adapters()).rejects.toMatchObject({ name: "ToolExecutionError", code: "http_error", status: 502 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>ok</html>", { status: 200 }));
    await expect(cloud().tools.adapters()).rejects.toMatchObject({ code: "invalid_response", status: 200 });
  });

  it("surfaces server error codes", async () => {
    stubFetch(() => ({ status: 400, body: { error: { code: "mock_unmatched", message: "no fixture" } } }));
    await expect(cloud().tools.invoke(RUN, "x", {})).rejects.toMatchObject({ code: "mock_unmatched", status: 400 });
    await expect(cloud().tools.preflight({ config: {}, configText: "{}" })).rejects.toThrow(/exactly one/);
    const error = new ToolExecutionError("plan_approval_required", "approve first", 400);
    expect(error.message).toBe("plan_approval_required: approve first");
  });

  it("create, approve and start a run", async () => {
    const calls = stubFetch((url) => {
      if (url.endsWith("/runs")) return { body: { run: { id: RUN, status: "planned", plan_hash: "blake3:abc" } } };
      if (url.endsWith("/approve")) return { body: { run: { id: RUN, status: "approved" } } };
      return { body: { run: { id: RUN, status: "running" } } };
    });
    const tools = cloud().tools;
    const run = await tools.createRun({ name: "demo", configText: "schema_version: agenomic.tool_execution/v1\nmode: mock\n", repetitions: 2 });
    expect(run.status).toBe("planned");
    expect(calls[0]!.body).toMatchObject({ name: "demo", repetitions: 2 });
    expect((await tools.approveRun(RUN, "blake3:abc")).status).toBe("approved");
    expect((await tools.startRun(RUN)).status).toBe("running");
    expect(calls[1]!.body).toEqual({ plan_hash: "blake3:abc" });
  });
});
