import { afterEach, describe, expect, it, vi } from "vitest";

import { AgenomicClient } from "../src/client";
import { ToolCallConflict, ToolExecutionError } from "../src/tools";

const RUN = "11111111-2222-4333-8444-555555555555";
const EXEMPTION = "bbbbbbbb-0000-4000-8000-000000000002";

interface Call {
  url: string;
  method?: string;
  body?: Record<string, unknown>;
}

function stubFetch(respond: (url: string) => { status?: number; body: unknown }): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method, body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined });
    const reply = respond(url);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  return calls;
}

function cloud(): AgenomicClient {
  return new AgenomicClient({ apiKey: "key_123", baseUrl: "https://api.agenomic.dev/" });
}

function conflict(reason: string, phase: string) {
  return {
    status: 409,
    body: {
      error: { code: "conflict", reason, message: `call is ${reason}`, request_id: "req_1" },
      agenomic: {
        record_id: "rec_1",
        run_id: RUN,
        phase,
        status: "pending",
        external_state: "indeterminate",
        tool: "crm.update_customer",
        logical_call_id: "call_1",
        repetition: 1,
        attempt: 1,
        requires_reconciliation: phase === "outcome_unknown",
        started_at: "2026-10-15T00:00:00Z",
      },
    },
  };
}

const EXEMPTION_BODY = {
  id: EXEMPTION,
  scope_kind: "org",
  scope_ref: "",
  reason: "migration window",
  status: "active",
  created_at: "2026-10-15T00:00:00Z",
  expires_at: "2026-10-16T00:00:00Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("409 on an unresolved attempt", () => {
  it.each([
    ["in_flight", "dispatching", "inFlight"],
    ["ambiguous_outcome", "outcome_unknown", "ambiguous"],
  ] as const)("invoke raises a typed conflict for %s", async (reason, phase, flag) => {
    stubFetch(() => conflict(reason, phase));
    const error = await cloud().tools.invoke(RUN, "crm.update_customer", {}, { logicalCallId: "call_1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolCallConflict);
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect(error).toMatchObject({ code: "conflict", status: 409, reason, requestId: "req_1", invocation: { phase, record_id: "rec_1" } });
    expect((error as ToolCallConflict)[flag]).toBe(true);
  });

  it("authorizeLocal raises the same conflict", async () => {
    stubFetch(() => conflict("ambiguous_outcome", "outcome_unknown"));
    const error = await cloud().tools.authorizeLocal(RUN, "crm.update_customer", {}, { logicalCallId: "call_1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolCallConflict);
    expect((error as ToolCallConflict).invocation?.requires_reconciliation).toBe(true);
  });

  it("a plain 409 stays a ToolExecutionError", async () => {
    stubFetch(() => ({ status: 409, body: { error: { code: "conflict", message: "approval consumed" } } }));
    const error = await cloud().tools.invoke(RUN, "t", {}, { logicalCallId: "call_1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect(error).not.toBeInstanceOf(ToolCallConflict);
  });
});

describe("phase and effective protection", () => {
  it("authorizeLocal carries the phase", async () => {
    stubFetch(() => ({ body: { decision: "local", record_id: "rec_1", phase: "authorized" } }));
    const auth = await cloud().tools.authorizeLocal(RUN, "t", {}, { logicalCallId: "call_1" });
    expect(auth).toMatchObject({ decision: "local", phase: "authorized" });
  });

  it("run reads expose the effective protection", async () => {
    const protection = { entitlement: "not_entitled", org_mandatory: true, run_mode: "live", protect_block: false, state: "none" };
    stubFetch(() => ({ body: { run: { id: RUN, status: "running" }, protection } }));
    const run = await cloud().tools.getRun(RUN);
    expect(run).toMatchObject({ id: RUN, protection: { state: "none", entitlement: "not_entitled" } });
  });
});

describe("protect settings and exemptions", () => {
  it("reads and updates the mandatory setting", async () => {
    const body = { protect_mandatory: true, mandatory_in_force: false, entitlement: "not_entitled", revision: 4 };
    const calls = stubFetch(() => ({ body }));
    const protect = cloud().protect;
    expect(await protect.getSettings()).toMatchObject({ mandatory_in_force: false, revision: 4 });
    await protect.updateSettings({ protectMandatory: true, expectedRevision: 3 });
    expect(calls[1]).toMatchObject({ method: "PUT", url: expect.stringContaining("/v1/protect/settings") });
    expect(calls[1]!.body).toEqual({ protect_mandatory: true, expected_revision: 3 });
  });

  it("rejects a settings body without the fields", async () => {
    stubFetch(() => ({ body: {} }));
    await expect(cloud().protect.getSettings()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("lists, creates and lifts exemptions", async () => {
    const calls = stubFetch((url) => (url.includes("?") ? { body: { exemptions: [EXEMPTION_BODY] } } : { body: EXEMPTION_BODY }));
    const { exemptions } = cloud().protect;
    expect(await exemptions.list({ status: "active" })).toHaveLength(1);
    await exemptions.create({ scopeKind: "org", reason: "migration window", expiresAt: "2026-10-16T00:00:00Z" });
    await exemptions.lift(EXEMPTION);
    expect(calls[0]!.url).toContain("/v1/protect/exemptions?status=active");
    expect(calls[1]!.body).toEqual({ scope_kind: "org", scope_ref: "", reason: "migration window", expires_at: "2026-10-16T00:00:00Z" });
    expect(calls[2]).toMatchObject({ method: "POST", url: expect.stringContaining(`/v1/protect/exemptions/${EXEMPTION}/lift`) });
  });

  it("coverage returns the organization block when present", async () => {
    const organization = { entitlement: "not_entitled", protect_mandatory: true, mandatory_in_force: false, settings_revision: 3, active_bindings: 0, active_exemptions: 0 };
    stubFetch(() => ({ body: { families: [], organization } }));
    expect((await cloud().protect.coverage()).organization).toEqual(organization);
    stubFetch(() => ({ body: { families: [] } }));
    expect((await cloud().protect.coverage()).organization).toBeUndefined();
  });
});
