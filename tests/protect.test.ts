import { afterEach, describe, expect, it, vi } from "vitest";

import { AgenomicClient } from "../src/client";
import { requestJson, ToolApprovalPending, ToolCallDenied, ToolExecutionError } from "../src/tools";

const RUN = "11111111-2222-4333-8444-555555555555";
const APPROVAL = "aaaaaaaa-0000-4000-8000-000000000001";
const PERMIT = {
  document: { schema_version: "agenomic.protect.permit/v1", record_id: "rec_local", tool: "crm.update_customer", nonce: "n-1" },
  signature: { algorithm: "ed25519", value: "sig", public_key_pem: "pem" },
};

interface Call {
  url: string;
  method?: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}

function protect(outcome: string, extra: Record<string, unknown> = {}) {
  return {
    decision_id: "dec_1",
    outcome,
    effective_mode: "enforce",
    reason_codes: ["rule_matched"],
    policy_snapshot_digest: "blake3:snap",
    evaluated_at: "2026-09-14T10:00:00Z",
    ...extra,
  };
}

function envelope(status: string, extra: Record<string, unknown> = {}, result: unknown = null) {
  return {
    result,
    agenomic: {
      record_id: "rec_gw",
      status,
      provenance: { source: "unrouted", fidelity: "contract_only", binding_mode: "live" },
      external_state: "none",
      effects: [],
      duration_ms: 1,
      expected_error: false,
      ...extra,
    },
  };
}

function stubFetch(respond: (url: string, body?: Record<string, unknown>, index?: number) => { status?: number; body: unknown }): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ url, method: init?.method, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const reply = respond(url, body, calls.length);
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

describe("router admission (gateway path)", () => {
  it("202 raises ToolApprovalPending without executing and without a second request", async () => {
    const calls = stubFetch(() => ({ status: 202, body: envelope("pending", { protect: protect("require_approval", { approval_id: APPROVAL }), approval_id: APPROVAL, decision: "require_approval" }) }));
    const router = cloud().tools.router(RUN);
    const error = await router.call("crm.update_customer", { id: "c_1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolApprovalPending);
    expect(error).toMatchObject({ code: "approval_pending", status: 202, approvalId: APPROVAL, recordId: "rec_gw", tool: "crm.update_customer" });
    expect(calls).toHaveLength(1);
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]!.agenomic.status).toBe("pending");
    expect(router.calls[0]!.result).toBeNull();
    expect(router.summary().hasRealCalls).toBe(false);
  });

  it("403 with an envelope raises ToolCallDenied carrying the decision", async () => {
    stubFetch(() => ({ status: 403, body: envelope("denied", { protect: protect("deny", { reason_codes: ["non_derogable"] }), decision: "deny", safe_explanation: "deletion is forbidden" }) }));
    const router = cloud().tools.router(RUN);
    const error = await router.call("crm.delete_customer", { id: "c_1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolCallDenied);
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect(error).toMatchObject({ code: "policy_denied", status: 403, message: "policy_denied: deletion is forbidden" });
    expect((error as ToolCallDenied).decision?.reason_codes).toEqual(["non_derogable"]);
    expect(router.calls[0]!.agenomic.status).toBe("denied");
  });

  it("403 transform proposal exposes the transformation", async () => {
    stubFetch(() => ({ status: 403, body: envelope("denied", { protect: protect("transform_proposal"), transformation: { kind: "redact_arguments", fields: ["body"] } }) }));
    const error = await cloud().tools.router(RUN).call("email.send", { body: "x" }).catch((e: unknown) => e);
    expect((error as ToolCallDenied).transformation).toEqual({ kind: "redact_arguments", fields: ["body"] });
  });

  it("403 with a plain error body stays a ToolExecutionError with the server code", async () => {
    stubFetch(() => ({ status: 403, body: { error: { code: "capability_denied", message: "plan lapsed" } } }));
    const error = await cloud().tools.router(RUN).call("crm.get_customer").catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ToolCallDenied);
    expect(error).toMatchObject({ name: "ToolExecutionError", code: "capability_denied", status: 403 });
  });

  it("a 200 envelope with status denied is treated as denied regardless of raiseOnError", async () => {
    stubFetch(() => ({ body: envelope("denied", { protect: protect("deny") }) }));
    await expect(cloud().tools.router(RUN, { raiseOnError: false }).call("x")).rejects.toBeInstanceOf(ToolCallDenied);
  });
});

describe("router admission (runtime-local path)", () => {
  it("pending authorization never runs the local function", async () => {
    const effects: string[] = [];
    const calls = stubFetch(() => ({ status: 202, body: { decision: "pending", record_id: "rec_local", approval_id: APPROVAL, protect: protect("require_approval", { approval_id: APPROVAL }) } }));
    const router = cloud().tools.router(RUN, { localFunctions: { "crm.update_customer": () => effects.push("ran") } });
    const error = await router.call("crm.update_customer", { id: "c_1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolApprovalPending);
    expect(error).toMatchObject({ approvalId: APPROVAL, recordId: "rec_local" });
    expect(effects).toEqual([]);
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["authorize"]);
    expect(router.calls[0]!.agenomic).toMatchObject({ status: "pending", approval_id: APPROVAL, provenance: { source: "unrouted" } });
  });

  it("denied authorization never runs the local function", async () => {
    const effects: string[] = [];
    stubFetch(() => ({ status: 403, body: { decision: "denied", record_id: "rec_local", protect: protect("deny") } }));
    const router = cloud().tools.router(RUN, { localFunctions: { "crm.update_customer": () => effects.push("ran") } });
    await expect(router.call("crm.update_customer")).rejects.toBeInstanceOf(ToolCallDenied);
    expect(effects).toEqual([]);
    expect(router.calls[0]!.agenomic).toMatchObject({ status: "denied", record_id: "rec_local" });
  });

  it.each(["allow", "approved", "", 42])("unknown decision %j is treated as denied", async (decision) => {
    const effects: string[] = [];
    stubFetch(() => ({ body: { decision, record_id: "rec_local" } }));
    const router = cloud().tools.router(RUN, { localFunctions: { "crm.update_customer": () => effects.push("ran") } });
    await expect(router.call("crm.update_customer")).rejects.toMatchObject({ name: "ToolCallDenied", code: "policy_denied" });
    expect(effects).toEqual([]);
  });

  it("forwards the permit verbatim to report-local", async () => {
    const calls = stubFetch((url) => {
      if (url.endsWith("/local/authorize")) return { body: { decision: "local", record_id: "rec_local", permit: PERMIT, protect: protect("allow") } };
      return { body: { record_id: "rec_local" } };
    });
    const router = cloud().tools.router(RUN, { localFunctions: { "crm.update_customer": (a) => ({ updated: a.id }) } });
    expect(await router.call("crm.update_customer", { id: "c_1" })).toEqual({ updated: "c_1" });
    expect(calls[1]!.url).toBe(`https://api.agenomic.dev/v1/tool-execution/runs/${RUN}/report-local`);
    expect(calls[1]!.body?.permit).toEqual(PERMIT);
    expect(JSON.stringify(calls[1]!.body?.permit)).toBe(JSON.stringify(PERMIT));
  });

  it("omits the permit when the authorization carried none", async () => {
    const calls = stubFetch((url) => (url.endsWith("/local/authorize") ? { body: { decision: "local", record_id: "rec_local" } } : { body: { record_id: "rec_local" } }));
    await cloud().tools.router(RUN, { localFunctions: { "math.add": () => 1 } }).call("math.add");
    expect("permit" in (calls[1]!.body ?? {})).toBe(false);
  });
});

describe("beforeAction", () => {
  it("a throwing hook aborts before any request on both paths", async () => {
    const effects: string[] = [];
    const calls = stubFetch(() => ({ body: {} }));
    const seen: unknown[] = [];
    const router = cloud().tools.router(RUN, {
      localFunctions: { "math.add": () => effects.push("ran") },
      beforeAction: (intent) => {
        seen.push(intent);
        throw new Error("blocked locally");
      },
    });
    await expect(router.call("math.add", { a: 1 })).rejects.toThrow("blocked locally");
    await expect(router.call("email.send", { to: "x" })).rejects.toThrow("blocked locally");
    expect(calls).toHaveLength(0);
    expect(effects).toEqual([]);
    expect(router.calls).toHaveLength(0);
    expect(seen).toEqual([
      { runId: RUN, tool: "math.add", arguments: { a: 1 }, logicalCallId: "math.add#1", repetition: 1, attempt: 1, executionPoint: "runtime_local" },
      { runId: RUN, tool: "email.send", arguments: { to: "x" }, logicalCallId: "email.send#2", repetition: 1, attempt: 1, executionPoint: "gateway" },
    ]);
  });

  it("an async hook is awaited before the request", async () => {
    const order: string[] = [];
    stubFetch(() => {
      order.push("request");
      return { body: envelope("success", { provenance: { source: "static", fidelity: "contract_only", binding_mode: "mock" } }, { ok: true }) };
    });
    const router = cloud().tools.router(RUN, {
      beforeAction: async () => {
        await new Promise((r) => setTimeout(r, 1));
        order.push("hook");
      },
    });
    expect(await router.call("x")).toEqual({ ok: true });
    expect(order).toEqual(["hook", "request"]);
  });
});

describe("router.resume", () => {
  const pendingBody = envelope("pending", { protect: protect("require_approval", { approval_id: APPROVAL }), approval_id: APPROVAL, decision: "require_approval" });

  it("polls the approval then re-issues the identical body once with the original idempotency key", async () => {
    let polls = 0;
    const calls = stubFetch((url) => {
      if (url.endsWith(`/v1/protect/approvals/${APPROVAL}`)) {
        polls += 1;
        return { body: { id: APPROVAL, status: polls < 3 ? "pending" : "approved" } };
      }
      if (calls.length === 1) return { status: 202, body: pendingBody };
      return { body: envelope("success", { provenance: { source: "live", fidelity: "live", binding_mode: "live" }, external_state: "confirmed", protect: protect("allow") }, { updated: true }) };
    });
    const router = cloud().tools.router(RUN);
    const pending = (await router.call("crm.update_customer", { id: "c_1", fields: { credit_limit: 5 } }).catch((e: unknown) => e)) as ToolApprovalPending;
    expect(pending).toBeInstanceOf(ToolApprovalPending);
    expect(await router.resume<{ updated: boolean }>(pending as ToolApprovalPending, { pollIntervalMs: 0 })).toEqual({ updated: true });
    const invokes = calls.filter((c) => c.url.endsWith("/invoke"));
    expect(invokes).toHaveLength(2);
    expect(invokes[1]!.body).toEqual(invokes[0]!.body);
    expect(invokes[0]!.headers["idempotency-key"]).toBeTypeOf("string");
    expect(invokes[1]!.headers["idempotency-key"]).toBe(invokes[0]!.headers["idempotency-key"]);
    expect(polls).toBe(3);
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "GET", "GET", "POST"]);
    expect(router.calls.map((c) => c.agenomic.status)).toEqual(["pending", "success"]);
  });

  it("accepts the approval id as a string", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/approvals/")) return { body: { id: APPROVAL, status: "approved" } };
      if (calls.length === 1) return { status: 202, body: pendingBody };
      return { body: envelope("success", {}, { ok: 1 }) };
    });
    const router = cloud().tools.router(RUN);
    await router.call("x", { a: 1 }).catch(() => undefined);
    expect(await router.resume(APPROVAL, { pollIntervalMs: 0 })).toEqual({ ok: 1 });
    expect(calls.filter((c) => c.url.endsWith("/invoke"))).toHaveLength(2);
  });

  it("replays a consumed approval with the original idempotency key and recovers the stored result", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/approvals/")) return { body: { id: APPROVAL, status: "consumed" } };
      if (calls.length === 1) return { status: 202, body: pendingBody };
      return { body: envelope("success", { provenance: { source: "live", fidelity: "live", binding_mode: "live" }, external_state: "confirmed", protect: protect("allow") }, { refunded: true }) };
    });
    const router = cloud().tools.router(RUN);
    const pending = (await router.call("payments.refund", { amount_minor: 900 }).catch((e: unknown) => e)) as ToolApprovalPending;
    expect(await router.resume<{ refunded: boolean }>(pending, { pollIntervalMs: 0 })).toEqual({ refunded: true });
    const invokes = calls.filter((c) => c.url.endsWith("/invoke"));
    expect(invokes).toHaveLength(2);
    expect(invokes[1]!.body).toEqual(invokes[0]!.body);
    expect(invokes[1]!.headers["idempotency-key"]).toBe(invokes[0]!.headers["idempotency-key"]);
    expect(router.calls.map((c) => c.agenomic.status)).toEqual(["pending", "success"]);
  });

  it("raises a typed conflict when the consumed replay answers 409", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/approvals/")) return { body: { id: APPROVAL, status: "consumed" } };
      if (calls.length === 1) return { status: 202, body: pendingBody };
      return { status: 409, body: { error: { code: "approval_invalid", message: "approval is consumed" } } };
    });
    const router = cloud().tools.router(RUN);
    const pending = (await router.call("payments.refund", { amount_minor: 900 }).catch((e: unknown) => e)) as ToolApprovalPending;
    const error = (await router.resume(pending, { pollIntervalMs: 0 }).catch((e: unknown) => e)) as ToolExecutionError;
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect(error).not.toBeInstanceOf(ToolCallDenied);
    expect({ code: error.code, status: error.status }).toEqual({ code: "conflict", status: 409 });
    expect(calls.filter((c) => c.url.endsWith("/invoke"))).toHaveLength(2);
  });

  it.each(["rejected", "expired", "weird"])("%s throws ToolCallDenied with that status as code and never re-issues", async (status) => {
    const calls = stubFetch((url) => {
      if (url.includes("/approvals/")) return { body: { id: APPROVAL, status } };
      return { status: 202, body: pendingBody };
    });
    const router = cloud().tools.router(RUN);
    const pending = (await router.call("x").catch((e: unknown) => e)) as ToolApprovalPending;
    await expect(router.resume(pending, { pollIntervalMs: 0 })).rejects.toMatchObject({ name: "ToolCallDenied", code: status, status: 403 });
    expect(calls.filter((c) => c.url.endsWith("/invoke"))).toHaveLength(1);
  });

  it("times out with approval_timeout while the approval stays pending", async () => {
    stubFetch((url) => (url.includes("/approvals/") ? { body: { id: APPROVAL, status: "pending" } } : { status: 202, body: pendingBody }));
    const router = cloud().tools.router(RUN);
    const pending = (await router.call("x").catch((e: unknown) => e)) as ToolApprovalPending;
    await expect(router.resume(pending, { pollIntervalMs: 0, timeoutMs: 0 })).rejects.toMatchObject({ code: "approval_timeout" });
  });

  it("refuses an approval it never registered", async () => {
    await expect(cloud().tools.router(RUN).resume("unknown")).rejects.toMatchObject({ code: "unknown_approval" });
  });

  it("resumes a runtime-local call and runs the function only after the permit arrives", async () => {
    const effects: string[] = [];
    const calls = stubFetch((url) => {
      if (url.includes("/approvals/")) return { body: { id: APPROVAL, status: "approved" } };
      if (url.endsWith("/local/authorize")) {
        return calls.filter((c) => c.url.endsWith("/local/authorize")).length === 1
          ? { status: 202, body: { decision: "pending", record_id: "rec_local", approval_id: APPROVAL } }
          : { body: { decision: "local", record_id: "rec_local", permit: PERMIT } };
      }
      return { body: { record_id: "rec_local" } };
    });
    const router = cloud().tools.router(RUN, { localFunctions: { "crm.update_customer": () => { effects.push("ran"); return { ok: true }; } } });
    const pending = (await router.call("crm.update_customer", { id: "c_1" }).catch((e: unknown) => e)) as ToolApprovalPending;
    expect(effects).toEqual([]);
    expect(await router.resume(pending, { pollIntervalMs: 0 })).toEqual({ ok: true });
    expect(effects).toEqual(["ran"]);
    const authorizes = calls.filter((c) => c.url.endsWith("/local/authorize"));
    expect(authorizes[1]!.body).toEqual(authorizes[0]!.body);
    expect(calls.at(-1)!.body?.permit).toEqual(PERMIT);
  });
});

describe("client.protect resources", () => {
  const BASE = "https://api.agenomic.dev";
  const WIRE = {
    id: "x",
    text: "t",
    digest: "blake3:o",
    version: "1",
    record: {},
    policy: {},
    from: "crm@2.0.0",
    to: "crm@1.0.0",
    lines: [],
    decisions: [],
    next_cursor: null,
    policy_snapshot_digest: "blake3:snap",
    warnings: [],
    policies: [],
    bindings: [],
    approvals: [],
    restrictions: [],
    families: [],
    tools: [],
    decisions_by_outcome: {},
    restriction: { id: "r_1" },
    cancelled_runs: [],
    cancellation_note: "",
  };
  const cases: Array<{ name: string; run: (c: AgenomicClient) => Promise<unknown>; method: string; url: string; body?: unknown }> = [
    { name: "overlay", run: (c) => c.protect.overlay(RUN), method: "GET", url: `/v1/protect/runs/${RUN}/overlay` },
    { name: "catalog", run: (c) => c.protect.catalog(RUN), method: "GET", url: `/v1/protect/runs/${RUN}/catalog` },
    { name: "approvals.list", run: (c) => c.protect.approvals.list({ status: "pending", runId: RUN }), method: "GET", url: `/v1/protect/approvals?status=pending&run_id=${RUN}` },
    { name: "approvals.get", run: (c) => c.protect.approvals.get(APPROVAL), method: "GET", url: `/v1/protect/approvals/${APPROVAL}` },
    { name: "approvals.decide", run: (c) => c.protect.approvals.decide(APPROVAL, { decision: "approve", comment: "ok" }), method: "POST", url: `/v1/protect/approvals/${APPROVAL}/decide`, body: { decision: "approve", comment: "ok" } },
    { name: "decisions.list", run: (c) => c.protect.decisions.list({ runId: RUN, outcome: "deny", since: "2026-09-14T00:00:00Z", limit: 10, cursor: "c1" }), method: "GET", url: `/v1/protect/decisions?run_id=${RUN}&outcome=deny&since=2026-09-14T00%3A00%3A00Z&limit=10&cursor=c1` },
    { name: "decisions.get", run: (c) => c.protect.decisions.get("dec_1"), method: "GET", url: "/v1/protect/decisions/dec_1" },
    { name: "policies.list", run: (c) => c.protect.policies.list(), method: "GET", url: "/v1/policies" },
    { name: "policies.register", run: (c) => c.protect.policies.register({ policy_id: "crm", version: "1.0.0", rules: [] }), method: "POST", url: "/v1/policies", body: { policy_id: "crm", version: "1.0.0", rules: [] } },
    { name: "policies.register text", run: (c) => c.protect.policies.register("policy_id: crm\nversion: 1.0.0\n"), method: "POST", url: "/v1/policies", body: { document_text: "policy_id: crm\nversion: 1.0.0\n" } },
    { name: "policies.get", run: (c) => c.protect.policies.get("crm", "1.0.0"), method: "GET", url: "/v1/policies/crm%401.0.0" },
    { name: "policies.release", run: (c) => c.protect.policies.release("crm", "1.0.0"), method: "POST", url: "/v1/policies/crm%401.0.0/release", body: {} },
    { name: "policies.deprecate", run: (c) => c.protect.policies.deprecate("crm", "1.0.0"), method: "POST", url: "/v1/policies/crm%401.0.0/deprecate", body: {} },
    { name: "policies.simulate", run: (c) => c.protect.policies.simulate("crm", "1.0.0", [{ tool_id: "x" }]), method: "POST", url: "/v1/policies/crm%401.0.0/simulate", body: { intents: [{ tool_id: "x" }] } },
    { name: "policies.diff", run: (c) => c.protect.policies.diff("crm", "2.0.0", "1.0.0"), method: "GET", url: "/v1/policies/crm%402.0.0/diff?against=1.0.0" },
    { name: "bindings.list", run: (c) => c.protect.bindings.list({ scopeKind: "run", scopeRef: RUN, status: "active" }), method: "GET", url: `/v1/protect/bindings?scope_kind=run&scope_ref=${RUN}&status=active` },
    { name: "bindings.create", run: (c) => c.protect.bindings.create({ policyId: "crm", version: "1.0.0", scopeKind: "org", mode: "enforce" }), method: "POST", url: "/v1/protect/bindings", body: { policy_id: "crm", version: "1.0.0", scope_kind: "org", scope_ref: "", mode: "enforce" } },
    { name: "bindings.revoke", run: (c) => c.protect.bindings.revoke("b_1", "rotated"), method: "POST", url: "/v1/protect/bindings/b_1/revoke", body: { reason: "rotated" } },
    { name: "restrictions.list", run: (c) => c.protect.restrictions.list({ status: "active" }), method: "GET", url: "/v1/protect/restrictions?status=active" },
    { name: "restrictions.create", run: (c) => c.protect.restrictions.create({ scopeKind: "tool", scopeRef: "email.send", kind: "block_tool", reason: "incident", expiresAt: "2026-09-15T00:00:00Z" }), method: "POST", url: "/v1/protect/restrictions", body: { scope_kind: "tool", scope_ref: "email.send", kind: "block_tool", parameters: {}, reason: "incident", expires_at: "2026-09-15T00:00:00Z" } },
    { name: "restrictions.lift", run: (c) => c.protect.restrictions.lift("r_1"), method: "POST", url: "/v1/protect/restrictions/r_1/lift", body: {} },
    { name: "killSwitch", run: (c) => c.protect.killSwitch({ scopeKind: "agent", scopeRef: "agent://acme/support", reason: "runaway" }), method: "POST", url: "/v1/protect/kill-switch", body: { scope_kind: "agent", scope_ref: "agent://acme/support", reason: "runaway" } },
    { name: "simulate", run: (c) => c.protect.simulate({ intents: [{ tool_id: "x" }], policyRefs: ["crm@1.0.0"], decisionsFromRun: RUN }), method: "POST", url: "/v1/protect/simulate", body: { intents: [{ tool_id: "x" }], policy_refs: ["crm@1.0.0"], decisions_from_run: RUN } },
    { name: "coverage", run: (c) => c.protect.coverage(), method: "GET", url: "/v1/protect/coverage" },
    { name: "metricsSummary", run: (c) => c.protect.metricsSummary(), method: "GET", url: "/v1/protect/metrics/summary" },
  ];

  it.each(cases)("$name hits $method $url", async ({ run, method, url, body }) => {
    const calls = stubFetch(() => ({ body: WIRE }));
    await run(cloud());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe(method);
    expect(calls[0]!.url).toBe(BASE + url);
    expect(calls[0]!.headers.authorization).toBe("Bearer key_123");
    if (body === undefined) expect(calls[0]!.body).toBeUndefined();
    else expect(calls[0]!.body).toEqual(body);
  });

  it("reads enveloped lists and bare single records", async () => {
    stubFetch((url) => {
      if (url.endsWith("/overlay")) return { body: { version: "1", digest: "blake3:o", text: "Never delete customers.", policies: ["crm@1.0.0"], truncated: false } };
      if (url.endsWith("/catalog")) return { body: { tools: [{ tool: "crm.get_customer", allowed: true, requires_approval: false, effect: "read" }] } };
      if (url.endsWith("/approvals")) return { body: { approvals: [{ id: APPROVAL, status: "pending" }] } };
      if (url.endsWith("/decisions")) return { body: { decisions: [{ id: "dec_1" }], next_cursor: "cur_2" } };
      if (url.endsWith("/release")) return { body: { policy: { policy_id: "crm", version: "1.0.0", status: "released" } } };
      return { body: { id: APPROVAL, status: "approved" } };
    });
    const client = cloud();
    expect((await client.protect.overlay(RUN)).text).toBe("Never delete customers.");
    expect((await client.protect.catalog(RUN)).tools[0]!.tool).toBe("crm.get_customer");
    expect(await client.protect.approvals.list()).toEqual([{ id: APPROVAL, status: "pending" }]);
    expect((await client.protect.approvals.get(APPROVAL)).status).toBe("approved");
    expect(await client.protect.decisions.list()).toEqual({ decisions: [{ id: "dec_1" }], next_cursor: "cur_2" });
    expect((await client.protect.policies.release("crm", "1.0.0")).status).toBe("released");
  });

  it.each([
    { name: "an enveloped single record", url: "/v1/protect/approvals/", body: { approval: { id: APPROVAL } }, run: (c: AgenomicClient) => c.protect.approvals.get(APPROVAL) },
    { name: "a bare list", url: "/v1/protect/restrictions", body: [{ id: "r_1" }], run: (c: AgenomicClient) => c.protect.restrictions.list() },
    { name: "a list under another key", url: "/v1/protect/coverage", body: { rows: [] }, run: (c: AgenomicClient) => c.protect.coverage() },
    { name: "a bare policy record", url: "/v1/policies", body: { policy_id: "crm" }, run: (c: AgenomicClient) => c.protect.policies.release("crm", "1.0.0") },
  ])("refuses $name as invalid_response", async ({ body, run }) => {
    stubFetch(() => ({ body }));
    await expect(run(cloud())).rejects.toMatchObject({ name: "ToolExecutionError", code: "invalid_response" });
  });

  it("surfaces { error } bodies as typed ToolExecutionError and refuses without a base url", async () => {
    stubFetch(() => ({ status: 409, body: { error: { code: "approval_expired", message: "too late" } } }));
    await expect(cloud().protect.approvals.decide(APPROVAL, { decision: "approve" })).rejects.toMatchObject({ name: "ToolExecutionError", code: "approval_expired", status: 409 });
    await expect(new AgenomicClient().protect.overlay(RUN)).rejects.toMatchObject({ code: "cloud_required" });
  });

  it("keeps the RMP protect methods working", async () => {
    const calls = stubFetch(() => ({ body: { alerts: [{ alert_id: "al_1" }] } }));
    expect(await cloud().protect.alerts({ sessionId: "rmp_1" })).toEqual([{ alert_id: "al_1" }]);
    expect(calls[0]!.url).toBe(`${BASE}/v1/protect/alerts?session_id=rmp_1`);
    await expect(new AgenomicClient().protect.alerts({ sessionId: "rmp_1" })).resolves.toEqual([]);
  });
});

describe("Codex review on #9", () => {
  const pendingBody = envelope("pending", { protect: protect("require_approval", { approval_id: APPROVAL }), approval_id: APPROVAL, decision: "require_approval" });

  it("resume replays the arguments as they were approved, not as the caller later mutated them", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/approvals/")) return { body: { id: APPROVAL, status: "approved" } };
      if (calls.length === 1) return { status: 202, body: pendingBody };
      return { body: envelope("success", {}, { ok: 1 }) };
    });
    const router = cloud().tools.router(RUN);
    const args = { id: "c_1", fields: { credit_limit: 5 } };
    await router.call("crm.update_customer", args).catch(() => undefined);
    args.id = "c_2";
    (args.fields as { credit_limit: number }).credit_limit = 500_000;
    await router.resume(APPROVAL, { pollIntervalMs: 0 });
    const invokes = calls.filter((c) => c.url.endsWith("/invoke"));
    expect(invokes).toHaveLength(2);
    expect(invokes[1]!.body).toEqual(invokes[0]!.body);
    expect((invokes[1]!.body as { arguments: Record<string, unknown> }).arguments).toEqual({ id: "c_1", fields: { credit_limit: 5 } });
  });

  it("a second concurrent resume of the same approval is refused instead of re-issuing the call", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/approvals/")) return { body: { id: APPROVAL, status: "approved" } };
      if (calls.length === 1) return { status: 202, body: { decision: "pending", record_id: "rec_local", approval_id: APPROVAL, protect: protect("require_approval", { approval_id: APPROVAL }) } };
      if (url.endsWith("/local/authorize")) return { body: { decision: "local", record_id: "rec_local" } };
      return { body: { record_id: "rec_local" } };
    });
    let executions = 0;
    const router = cloud().tools.router(RUN, { localFunctions: { "crm.update_customer": () => ++executions } });
    await router.call("crm.update_customer", { id: "c_1" }).catch(() => undefined);
    const first = router.resume(APPROVAL, { pollIntervalMs: 0 });
    const second = await router.resume(APPROVAL, { pollIntervalMs: 0 }).catch((e: unknown) => e);
    await first.catch(() => undefined);
    expect(second).toBeInstanceOf(ToolExecutionError);
    expect(second).toMatchObject({ code: "resume_in_flight" });
    expect(executions).toBe(1);
  });

  it("an empty 2xx body stays an invalid response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 200 }));
    const error = await requestJson(cloud(), "GET", "/v1/tool-execution/runs").catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ToolExecutionError", code: "invalid_response" });
  });

  it("a 403 carrying a non-string decision is a denial, not a transport error", async () => {
    const effects: string[] = [];
    stubFetch(() => ({ status: 403, body: { decision: null, record_id: "rec_local" } }));
    const router = cloud().tools.router(RUN, { localFunctions: { "crm.update_customer": () => effects.push("ran") } });
    const error = await router.call("crm.update_customer").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolCallDenied);
    expect(effects).toEqual([]);
    expect(router.calls[0]!.agenomic.status).toBe("denied");
  });
});
