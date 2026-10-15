import { afterEach, describe, expect, it, vi } from "vitest";

import { AgenomicClient } from "../src/client";
import { ModelCallDenied, ModelCallPending, type ModelCallRequest } from "../src/model-calls";
import { ToolCallConflict, ToolExecutionError } from "../src/tools";

const RUN = "11111111-2222-4333-8444-555555555555";
const REC = "rrrrrrrr-0000-4000-8000-000000000001";
const PERMIT = { document: { id: "permit_1" }, signature: { sig: "s" } };

interface Call {
  url: string;
  method?: string;
  body?: Record<string, unknown>;
}

type Reply = { status?: number; body: unknown };

function stubFetch(respond: (url: string) => Reply): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method,
      body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    const reply = respond(call.url);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  return calls;
}

function cloud(): AgenomicClient {
  return new AgenomicClient({ apiKey: "key_123", baseUrl: "https://api.agenomic.dev/" });
}

const REQUEST: ModelCallRequest = {
  logicalCallId: "llm_1",
  provider: "anthropic",
  model: "claude-sonnet-5",
  maxOutputTokens: 1000,
  estimatedInputTokens: 500,
  estimatedCost: { amountMinor: 12, currency: "EUR" },
  dataClassification: ["internal"],
  endpointHost: "api.anthropic.com",
};

const STAMP = { outcome: "allow", reason_codes: ["policy_allow"] };
const ALLOW = { decision: "allow", tool: "model:anthropic/claude-sonnet-5", record_id: REC, permit: PERMIT, protect: STAMP, phase: "dispatching" };
const DENIED = { decision: "denied", tool: "model:a/b", record_id: REC, protect: { outcome: "deny", reason_codes: ["no_policy_bound"] }, phase: "denied" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("model call admission", () => {
  it("posts the declared values in wire form and never a prompt", async () => {
    const calls = stubFetch(() => ({ body: ALLOW }));
    const decision = await cloud().tools.authorizeModelCall(RUN, { ...REQUEST, toolChoice: "required", tools: ["search"], stream: true });
    expect(calls[0]!.url).toContain(`/v1/tool-execution/runs/${RUN}/model-calls/authorize`);
    expect(calls[0]!.body).toEqual({
      repetition: 1,
      logical_call_id: "llm_1",
      attempt: 1,
      provider: "anthropic",
      model: "claude-sonnet-5",
      max_output_tokens: 1000,
      estimated_input_tokens: 500,
      endpoint_host: "api.anthropic.com",
      estimated_cost: { amount_minor: 12, currency: "EUR" },
      data_classification: ["internal"],
      tool_choice: "required",
      tools: ["search"],
      stream: true,
    });
    expect(decision).toMatchObject({ decision: "allow", recordId: REC, permit: PERMIT, phase: "dispatching", tool: "model:anthropic/claude-sonnet-5" });
  });

  it("returns pending on 202 and denied on 403 as data", async () => {
    stubFetch(() => ({ status: 202, body: { decision: "pending", tool: "model:a/b", record_id: REC, approval_id: "apr_1", phase: "approval_pending" } }));
    expect(await cloud().tools.authorizeModelCall(RUN, REQUEST)).toMatchObject({ decision: "pending", approvalId: "apr_1" });
    vi.restoreAllMocks();
    stubFetch(() => ({ status: 403, body: DENIED }));
    expect(await cloud().tools.authorizeModelCall(RUN, REQUEST)).toMatchObject({ decision: "denied", protect: { reason_codes: ["no_policy_bound"] } });
  });

  it("a 403 without a decision stays a ToolExecutionError", async () => {
    stubFetch(() => ({ status: 403, body: { error: { code: "forbidden", message: "role" } } }));
    await expect(cloud().tools.authorizeModelCall(RUN, REQUEST)).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });

  it("refuses an allow without a permit and a pending without an approval id", async () => {
    stubFetch(() => ({ body: { ...ALLOW, permit: undefined } }));
    await expect(cloud().tools.authorizeModelCall(RUN, REQUEST)).rejects.toMatchObject({ code: "invalid_response" });
    vi.restoreAllMocks();
    stubFetch(() => ({ status: 202, body: { decision: "pending", tool: "model:a/b", record_id: REC } }));
    await expect(cloud().tools.authorizeModelCall(RUN, REQUEST)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("raises the typed conflict on a recorded identity", async () => {
    stubFetch(() => ({
      status: 409,
      body: {
        error: { code: "conflict", reason: "in_flight", message: "being processed", request_id: "req_9" },
        agenomic: { record_id: REC, run_id: RUN, phase: "dispatching" },
      },
    }));
    const error = await cloud().tools.authorizeModelCall(RUN, REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolCallConflict);
    expect(error).toMatchObject({ reason: "in_flight", inFlight: true, otherAttempt: false });
  });

  it("reports usage and the permit in wire form", async () => {
    const calls = stubFetch(() => ({ body: { record_id: REC } }));
    const id = await cloud().tools.reportModelCall(RUN, {
      logicalCallId: "llm_1",
      provider: "anthropic",
      model: "claude-sonnet-5",
      permit: PERMIT,
      usage: { inputTokens: 10, outputTokens: 20 },
      durationMs: 150,
    });
    expect(id).toBe(REC);
    expect(calls[0]!.url).toContain("/model-calls/report");
    expect(calls[0]!.body).toEqual({
      repetition: 1,
      logical_call_id: "llm_1",
      attempt: 1,
      provider: "anthropic",
      model: "claude-sonnet-5",
      is_error: false,
      duration_ms: 150,
      permit: PERMIT,
      usage: { input_tokens: 10, output_tokens: 20 },
    });
  });
});

describe("guardModelCall", () => {
  function route(authorize: Reply): Call[] {
    return stubFetch((url) => (url.endsWith("/authorize") ? authorize : { body: { record_id: REC } }));
  }

  it("runs the call on allow and reports the usage", async () => {
    const calls = route({ body: ALLOW });
    const call = vi.fn(async () => ({ text: "hi", usage: { in: 3, out: 4 } }));
    const result = await cloud().tools.guardModelCall(RUN, REQUEST, call, { usage: (r) => ({ inputTokens: r.usage.in, outputTokens: r.usage.out }) });
    expect(result.text).toBe("hi");
    expect(call).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toMatchObject({ is_error: false, permit: PERMIT, usage: { input_tokens: 3, output_tokens: 4 } });
  });

  it("does not call the provider when denied", async () => {
    const calls = route({ status: 403, body: DENIED });
    const call = vi.fn(async () => "never");
    const error = await cloud().tools.guardModelCall(RUN, REQUEST, call).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelCallDenied);
    expect((error as ModelCallDenied).reasonCodes).toEqual(["no_policy_bound"]);
    expect(call).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("does not call the provider when pending", async () => {
    route({ status: 202, body: { decision: "pending", tool: "model:a/b", record_id: REC, approval_id: "apr_1" } });
    const call = vi.fn(async () => "never");
    const error = await cloud().tools.guardModelCall(RUN, REQUEST, call).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelCallPending);
    expect((error as ModelCallPending).approvalId).toBe("apr_1");
    expect(call).not.toHaveBeenCalled();
  });

  it("does not call the provider on a recorded identity", async () => {
    route({ status: 409, body: { error: { code: "conflict", reason: "ambiguous_outcome", message: "m" }, agenomic: { record_id: REC, phase: "outcome_unknown" } } });
    const call = vi.fn(async () => "never");
    await expect(cloud().tools.guardModelCall(RUN, REQUEST, call)).rejects.toBeInstanceOf(ToolCallConflict);
    expect(call).not.toHaveBeenCalled();
  });

  it("reports a failing call as an error and rethrows it unchanged", async () => {
    const calls = route({ body: ALLOW });
    const failure = new Error("provider down");
    const error = await cloud().tools.guardModelCall(RUN, REQUEST, () => Promise.reject(failure)).catch((e: unknown) => e);
    expect(error).toBe(failure);
    expect(calls[1]!.body).toMatchObject({ is_error: true, permit: PERMIT });
  });

  it("keeps the call error when the error report also fails", async () => {
    stubFetch((url) => (url.endsWith("/authorize") ? { body: ALLOW } : { status: 500, body: { error: { code: "internal_error", message: "x" } } }));
    const failure = new Error("provider down");
    const error = await cloud().tools.guardModelCall(RUN, REQUEST, () => Promise.reject(failure)).catch((e: unknown) => e);
    expect(error).toBe(failure);
  });

  it("surfaces a failed report after a successful call", async () => {
    stubFetch((url) => (url.endsWith("/authorize") ? { body: ALLOW } : { status: 409, body: { error: { code: "conflict", message: "already reported" } } }));
    await expect(cloud().tools.guardModelCall(RUN, REQUEST, async () => "ok")).rejects.toBeInstanceOf(ToolExecutionError);
  });
});

describe("second 409 form", () => {
  it.each([
    ["attempt_in_flight", "inFlight"],
    ["ambiguous_outcome", "ambiguous"],
  ] as const)("types %s with no reason and no invocation", async (code, flag) => {
    stubFetch(() => ({ status: 409, body: { error: { code, message: `${code}: another attempt is unresolved`, request_id: "req_2" } } }));
    const error = await cloud().tools.invoke(RUN, "crm.update", {}, { logicalCallId: "c", attempt: 2 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolCallConflict);
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect(error).toMatchObject({ code, reason: code, status: 409, otherAttempt: true, invocation: undefined, requestId: "req_2" });
    expect((error as ToolCallConflict)[flag]).toBe(true);
    expect((error as ToolCallConflict).message).toBe(`${code}: another attempt is unresolved`);
  });

  it("also reaches authorizeLocal and the model call route", async () => {
    stubFetch(() => ({ status: 409, body: { error: { code: "attempt_in_flight", message: "wait" } } }));
    await expect(cloud().tools.authorizeLocal(RUN, "t", {}, { logicalCallId: "c" })).rejects.toBeInstanceOf(ToolCallConflict);
    await expect(cloud().tools.authorizeModelCall(RUN, REQUEST)).rejects.toBeInstanceOf(ToolCallConflict);
  });

  it("an idempotency_key_reuse 409 stays plain", async () => {
    stubFetch(() => ({ status: 409, body: { error: { code: "idempotency_key_reuse", message: "other arguments" } } }));
    const error = await cloud().tools.invoke(RUN, "t", {}, { logicalCallId: "c" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect(error).not.toBeInstanceOf(ToolCallConflict);
  });
});

describe("invocation status and resolve", () => {
  const STATUS = { record_id: REC, run_id: RUN, phase: "outcome_unknown", status: "pending", external_state: "indeterminate", requires_reconciliation: true };

  it("reads the status", async () => {
    const calls = stubFetch(() => ({ body: STATUS }));
    expect(await cloud().tools.getInvocation(RUN, REC)).toMatchObject({ phase: "outcome_unknown", requires_reconciliation: true });
    expect(calls[0]).toMatchObject({ method: "GET", url: expect.stringContaining(`/runs/${RUN}/invocations/${REC}`) });
  });

  it("resolves from operator evidence", async () => {
    const calls = stubFetch(() => ({ body: { ...STATUS, phase: "succeeded", requires_reconciliation: false } }));
    const status = await cloud().tools.resolveInvocation(RUN, REC, { resolution: "not_executed", evidence: "ticket 42 shows no write" });
    expect(status.phase).toBe("succeeded");
    expect(calls[0]).toMatchObject({ method: "POST", url: expect.stringContaining(`/invocations/${REC}/resolve`) });
    expect(calls[0]!.body).toEqual({ resolution: "not_executed", evidence: "ticket 42 shows no write" });
  });

  it("a refused resolve is a typed error and a bad body is invalid_response", async () => {
    stubFetch(() => ({ status: 403, body: { error: { code: "forbidden", message: "owner only" } } }));
    await expect(cloud().tools.resolveInvocation(RUN, REC, { resolution: "failed", evidence: "e" })).rejects.toMatchObject({ code: "forbidden" });
    vi.restoreAllMocks();
    stubFetch(() => ({ body: {} }));
    await expect(cloud().tools.getInvocation(RUN, REC)).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("families and delegation", () => {
  const LINK = { document: { id: "dlg_1" }, signature: { sig: "s" } };

  it("issues and reads a delegation in wire form", async () => {
    const calls = stubFetch(() => ({ status: 201, body: LINK }));
    const issued = await cloud().protect.delegations.issue({
      parentId: "dlg_0",
      delegateAgentId: "agent-b",
      scope: { tools: ["crm.*"], families: ["financial"], effect_ceiling: "reversible_write" },
      maxActions: 5,
      expiresAt: "2026-10-16T00:00:00Z",
    });
    expect(issued.document.id).toBe("dlg_1");
    expect(calls[0]!.body).toEqual({
      parent_id: "dlg_0",
      delegate_agent_id: "agent-b",
      scope: { tools: ["crm.*"], families: ["financial"], effect_ceiling: "reversible_write" },
      budget: { max_actions: 5 },
      expires_at: "2026-10-16T00:00:00Z",
    });
    await cloud().protect.delegations.get("dlg_1");
    expect(calls[1]).toMatchObject({ method: "GET", url: expect.stringContaining("/v1/protect/delegations/dlg_1") });
  });

  it("rejects a delegation body without a signed document", async () => {
    stubFetch(() => ({ body: {} }));
    await expect(cloud().protect.delegations.get("dlg_1")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("simulate carries families, tiers and the chain untouched", async () => {
    const calls = stubFetch(() => ({ body: { decisions: [], policy_snapshot_digest: "d", warnings: [] } }));
    await cloud().protect.simulate({
      intents: [{ tool_id: "payments.refund", effect: "irreversible_write", families: ["financial"], family_tiers: { financial: "high" }, delegation_chain: ["dlg_1:ref"] }],
    });
    expect((calls[0]!.body!.intents as unknown[])[0]).toMatchObject({ families: ["financial"], family_tiers: { financial: "high" }, delegation_chain: ["dlg_1:ref"] });
  });
});

describe("correction client", () => {
  const INCIDENT = { id: "inc_1", status: "open" };
  const CANDIDATE = { id: "cand_1", status: "proposed", content_digest: "sha256:aa" };

  it("opens and lists incidents", async () => {
    const calls = stubFetch((url) => (url.includes("?") ? { body: { incidents: [INCIDENT] } } : { status: 201, body: { incident: INCIDENT, created: true } }));
    const { correction } = cloud();
    expect(await correction.incidents.open({ source: "protect_decision", sourceRef: "dec_1" })).toMatchObject({ created: true });
    expect(await correction.incidents.list({ status: "open", agentId: "agent-a", limit: 10 })).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ source: "protect_decision", source_ref: "dec_1" });
    expect(calls[1]!.url).toContain("/v1/correction/incidents?status=open&agent_id=agent-a&limit=10");
  });

  it("converts and dismisses an incident", async () => {
    const calls = stubFetch(() => ({ body: INCIDENT }));
    const { incidents } = cloud().correction;
    await incidents.convertToScenario("inc_1");
    await incidents.dismiss("inc_1", "duplicate");
    await incidents.dismiss("inc_1");
    expect(calls[0]).toMatchObject({ method: "POST", url: expect.stringContaining("/incidents/inc_1/scenario") });
    expect(calls[1]!.body).toEqual({ reason: "duplicate" });
    expect(calls[2]!.body).toEqual({});
  });

  it("creates a candidate in wire form", async () => {
    const calls = stubFetch(() => ({ status: 201, body: CANDIDATE }));
    await cloud().correction.candidates.create({
      incidentId: "inc_1",
      kind: "policy_change",
      title: "tighten refunds",
      payload: { policy_id: "crm", candidate_version: "2.0.0", scope_kind: "org", mode: "shadow" },
      claimsWeakening: false,
    });
    expect(calls[0]!.body).toEqual({
      incident_id: "inc_1",
      kind: "policy_change",
      title: "tighten refunds",
      payload: { policy_id: "crm", candidate_version: "2.0.0", scope_kind: "org", mode: "shadow" },
      claims_weakening: false,
    });
  });

  it("drives verify, review, approve, promote, enforce, rollback with digests", async () => {
    const calls = stubFetch((url) =>
      url.endsWith("/verify") ? { body: { candidate: CANDIDATE, report: { id: "rep_1", verdict: "passed" } } } : { body: CANDIDATE },
    );
    const { candidates } = cloud().correction;
    const verified = await candidates.verify("cand_1", { contentDigest: "sha256:aa" });
    expect(verified.report.verdict).toBe("passed");
    await candidates.review("cand_1", { contentDigest: "sha256:aa", reportId: "rep_1", note: "read it" });
    await candidates.approve("cand_1", { contentDigest: "sha256:aa", reportId: "rep_1", acknowledgeWeakening: true, note: "accepted" });
    await candidates.promote("cand_1", { contentDigest: "sha256:aa" });
    await candidates.enforce("cand_1", { contentDigest: "sha256:aa" });
    await candidates.rollback("cand_1", "regression");
    await candidates.reject("cand_1");
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["verify", "review", "approve", "promote", "enforce", "rollback", "reject"]);
    expect(calls[0]!.body).toEqual({ content_digest: "sha256:aa" });
    expect(calls[1]!.body).toEqual({ content_digest: "sha256:aa", report_id: "rep_1", note: "read it" });
    expect(calls[2]!.body).toEqual({ content_digest: "sha256:aa", report_id: "rep_1", acknowledge_weakening: true, note: "accepted" });
    expect(calls[5]!.body).toEqual({ reason: "regression" });
    expect(calls[6]!.body).toEqual({});
  });

  it("reads candidates, transitions and the replay report", async () => {
    stubFetch((url) => {
      if (url.endsWith("/transitions")) return { body: { transitions: [{ id: "t1" }] } };
      if (url.endsWith("/replay")) return { body: { id: "rep_1", verdict: "failed" } };
      if (url.includes("?")) return { body: { candidates: [CANDIDATE] } };
      return { body: CANDIDATE };
    });
    const { candidates } = cloud().correction;
    expect(await candidates.list({ incidentId: "inc_1", status: "proposed" })).toHaveLength(1);
    expect((await candidates.get("cand_1")).id).toBe("cand_1");
    expect(await candidates.transitions("cand_1")).toHaveLength(1);
    expect((await candidates.replay("cand_1")).verdict).toBe("failed");
  });

  it("reads and writes settings and runs the sweep", async () => {
    const body = { trigger_enabled: false, deny_threshold: 5, window_secs: 3600, max_incidents_per_hour: 3, min_shadow_secs: 300 };
    const calls = stubFetch((url) => (url.endsWith("/sweep") ? { body: { enabled: false, groups_over_threshold: 0, opened: [], rate_limited: 0 } } : { body }));
    const { correction } = cloud();
    expect(await correction.getSettings()).toEqual(body);
    await correction.updateSettings({ ...body, trigger_enabled: true });
    expect(calls[1]).toMatchObject({ method: "PUT" });
    expect(calls[1]!.body).toEqual({ ...body, trigger_enabled: true });
    expect(await correction.sweep()).toMatchObject({ enabled: false, opened: [] });
  });

  it("surfaces a server refusal as a typed error and a malformed body as invalid_response", async () => {
    stubFetch(() => ({ status: 409, body: { error: { code: "conflict", message: "stale digest" } } }));
    await expect(cloud().correction.candidates.promote("cand_1", { contentDigest: "x" })).rejects.toMatchObject({ code: "conflict", status: 409 });
    vi.restoreAllMocks();
    stubFetch(() => ({ body: {} }));
    await expect(cloud().correction.candidates.get("cand_1")).rejects.toMatchObject({ code: "invalid_response" });
    await expect(cloud().correction.getSettings()).rejects.toMatchObject({ code: "invalid_response" });
  });
});
