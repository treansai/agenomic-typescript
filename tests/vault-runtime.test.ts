import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgenomicClient,
  ToolExecutionError,
  VaultApprovalRequiredError,
  VaultAuthenticationError,
  VaultConfigurationError,
  VaultConflictError,
  VaultError,
  VaultExecutionFailedError,
  VaultGrantUnusableError,
  VaultNotEntitledError,
  VaultNotFoundError,
  VaultOutcomeUnknownError,
  VaultPolicyDeniedError,
  VaultRateLimitedError,
  VaultRefusedError,
  VaultRevokedError,
  VaultTransportError,
  VaultValidationError,
  Sensitive,
  isVaultLocked,
  type VaultLogEvent,
} from "../src";
import { ACTION_ID, APPROVAL_ID, BASE, CANARY, FAST_RETRY, OTHER_ACTION_ID, API_KEY, RUNTIME_TOKEN, errorBody, finished, vaultClient } from "./vault-helpers";

const INPUT = { tool: "crm.contacts.create", binding: "binding-crm-sales", arguments: { email: "ada@example.test" } };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.restoreAllMocks();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

describe("tools.execute", () => {
  it("returns the filtered result with its receipt and a generated actionId", async () => {
    const { client, calls } = vaultClient((call) => ({ body: finished(String(call.body?.action_id)) }));
    const result = await client.tools.execute<{ id: string }>(INPUT);
    expect(result).toMatchObject({
      status: "succeeded",
      result: { id: "contact_1" },
      receiptId: "9f60be54-5172-439a-8ebd-4f5061728394",
      statusCode: 201,
      attempts: 1,
      source: "live",
    });
    expect(result.actionId).toMatch(UUID_V4);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${BASE}/v1/vault/runtime/executions` });
    expect(calls[0]?.body).toEqual({ ...INPUT, action_id: result.actionId });
  });

  it("keeps a caller supplied actionId and refuses one that is not a UUID before any request", async () => {
    const { client, calls } = vaultClient((call) => ({ body: finished(String(call.body?.action_id)) }));
    expect((await client.tools.execute({ ...INPUT, actionId: ACTION_ID })).actionId).toBe(ACTION_ID);
    const error = await rejection(client.tools.execute({ ...INPUT, actionId: "not-a-uuid" }));
    expect(error).toBeInstanceOf(VaultValidationError);
    expect(calls).toHaveLength(1);
  });

  it("sends the runtime token on runtime routes and never the API key", async () => {
    const { client, calls } = vaultClient(() => ({ body: finished(ACTION_ID) }));
    await client.tools.execute({ ...INPUT, actionId: ACTION_ID });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${RUNTIME_TOKEN}`);
    expect(JSON.stringify(calls[0])).not.toContain(API_KEY);
  });

  it("cannot have its credentials overridden by caller headers", async () => {
    const network = vaultClient(() => ({ body: finished(ACTION_ID) }));
    const client = new AgenomicClient({
      apiKey: API_KEY,
      baseUrl: BASE,
      headers: { Authorization: "Bearer attacker", "X-Api-Key": "attacker", "x-trace": "ok" },
      vault: { runtimeToken: RUNTIME_TOKEN, fetchImpl: network.fetchImpl },
    });
    await client.tools.execute({ ...INPUT, actionId: ACTION_ID });
    const headers = network.calls[0]?.headers ?? {};
    expect(headers.authorization).toBe(`Bearer ${RUNTIME_TOKEN}`);
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["x-trace"]).toBe("ok");
  });

  it("forwards the optional identity cross-checks and deadline", async () => {
    const { client, calls } = vaultClient(() => ({ body: finished(ACTION_ID) }));
    await client.tools.execute({ ...INPUT, actionId: ACTION_ID, environment: "prod", agentId: "agent-1", deadlineMs: 5000 });
    expect(calls[0]?.body).toMatchObject({ environment: "prod", agent_id: "agent-1", deadline_ms: 5000 });
  });

  it("refuses a Sensitive inside the arguments instead of sending its mask", async () => {
    const { client, calls } = vaultClient(() => ({ body: finished(ACTION_ID) }));
    const error = await rejection(client.tools.execute({ ...INPUT, arguments: { token: new Sensitive(CANARY) } }));
    expect(error).toMatchObject({ code: "sensitive_refused" });
    expect(calls).toHaveLength(0);
  });
});

describe("technical retries keep the same actionId", () => {
  it("resends the identical request after a 503 and a network fault, then succeeds", async () => {
    const { client, calls } = vaultClient((call, index) => {
      if (index === 1) return { status: 503, rawText: "<html>bad gateway</html>" };
      if (index === 2) return new TypeError("fetch failed");
      return { body: finished(String(call.body?.action_id)) };
    });
    const result = await client.tools.execute({ ...INPUT, actionId: ACTION_ID });
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((call) => call.rawBody)).size).toBe(1);
    expect(calls.map((call) => call.body?.action_id)).toEqual([ACTION_ID, ACTION_ID, ACTION_ID]);
    expect(result.attempts).toBe(3);
  });

  it("keeps the generated actionId across retries and returns it", async () => {
    const { client, calls } = vaultClient((call, index) => (index === 1 ? { status: 502 } : { body: finished(String(call.body?.action_id)) }));
    const result = await client.tools.execute(INPUT);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body?.action_id).toBe(result.actionId);
    expect(calls[1]?.body?.action_id).toBe(result.actionId);
  });

  it("retries 429 honoring Retry-After and surfaces a typed error once the attempts are spent", async () => {
    const { client, calls } = vaultClient(() => ({ status: 429, headers: { "retry-after": "0" }, body: errorBody("too_many_requests", "vault execution rate limited; retry after 60s") }));
    const error = await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }));
    expect(error).toBeInstanceOf(VaultRateLimitedError);
    expect(error).toMatchObject({ code: "too_many_requests", status: 429, retryable: true, actionId: ACTION_ID, retryAfterMs: 0 });
    expect(calls).toHaveLength(3);
  });

  it("does not wait for a Retry-After longer than the retry budget", async () => {
    const { client, calls } = vaultClient(() => ({ status: 429, headers: { "retry-after": "60" }, body: errorBody("too_many_requests", "slow down") }));
    const error = await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }));
    expect(error).toMatchObject({ retryAfterMs: 60_000 });
    expect(calls).toHaveLength(1);
  });

  it("retries a transient vault refusal and stops at the configured attempts", async () => {
    const { client, calls } = vaultClient(() => ({ status: 409, body: errorBody("vault_destination_unavailable", "destination is unreachable") }), {
      retry: { ...FAST_RETRY, maxAttempts: 2 },
    });
    const error = await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }));
    expect(error).toBeInstanceOf(VaultRefusedError);
    expect(error).toMatchObject({ code: "vault_destination_unavailable", retryable: true });
    expect(calls).toHaveLength(2);
  });

  it("surfaces a network fault with the actionId after the last attempt", async () => {
    const { client, calls } = vaultClient(() => new TypeError("fetch failed"));
    const error = await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }));
    expect(error).toBeInstanceOf(VaultTransportError);
    expect(error).toMatchObject({ actionId: ACTION_ID, maybeSent: true, timedOut: false });
    expect(calls).toHaveLength(3);
  });

  it("does not retry after its own timeout: the server may still be executing", async () => {
    const { client, calls } = vaultClient(() => Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    const error = await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }));
    expect(error).toMatchObject({ code: "timeout", timedOut: true, actionId: ACTION_ID, retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("does not retry a server error or any definitive answer", async () => {
    const { client, calls } = vaultClient(() => ({ status: 500, body: errorBody("internal_error", "an internal error occurred") }));
    const error = await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }));
    expect(error).toMatchObject({ code: "internal_error", status: 500, retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("can be told not to retry at all", async () => {
    const { client, calls } = vaultClient(() => ({ status: 503 }), { retry: { maxAttempts: 1 } });
    await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }));
    expect(calls).toHaveLength(1);
  });
});

describe("outcome_unknown is never retried", () => {
  it("a finished execution in state outcome_unknown raises a dedicated error carrying the actionId, after one request", async () => {
    const { client, calls } = vaultClient((call, index) =>
      index === 1
        ? { body: finished(String(call.body?.action_id), { state: "outcome_unknown", result: null, status_code: null, error_class: "outcome_unknown", limitations: ["not repeated automatically"] }) }
        : { body: finished(String(call.body?.action_id)) },
    );
    const error = await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }));
    expect(error).toBeInstanceOf(VaultOutcomeUnknownError);
    expect(error).toMatchObject({ code: "vault_outcome_unknown", actionId: ACTION_ID, retryable: false, limitations: ["not repeated automatically"] });
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect(calls).toHaveLength(1);
  });

  it("the vault_outcome_unknown refusal is not retried either", async () => {
    const { client, calls } = vaultClient(() => ({ status: 409, body: errorBody("vault_outcome_unknown", "action outcome is unknown") }));
    const error = await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }));
    expect(error).toBeInstanceOf(VaultOutcomeUnknownError);
    expect((error as VaultOutcomeUnknownError).actionId).toBe(ACTION_ID);
    expect(calls).toHaveLength(1);
  });

  it("a destination 5xx on a write that the server reports as outcome_unknown stays one request", async () => {
    const { client, calls } = vaultClient(() => ({ body: finished(ACTION_ID, { state: "outcome_unknown", result: null, status_code: 503, error_class: "destination_error" }) }));
    const error = await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }));
    expect(error).toMatchObject({ code: "vault_outcome_unknown", statusCode: 503 });
    expect(calls).toHaveLength(1);
  });

  it("reading the status of an unknown outcome returns it as data", async () => {
    const { client, calls } = vaultClient(() => ({ body: finished(ACTION_ID, { state: "outcome_unknown", result: null, error_class: "outcome_unknown" }) }));
    const status = await client.tools.executionStatus(ACTION_ID);
    expect(status).toMatchObject({ action_id: ACTION_ID, state: "outcome_unknown" });
    expect(calls[0]).toMatchObject({ method: "GET", url: `${BASE}/v1/vault/runtime/executions/${ACTION_ID}` });
  });
});

describe("typed errors", () => {
  it("maps a locked add-on so a UI can show an upgrade hint, without retrying", async () => {
    const { client, calls } = vaultClient(() => ({
      status: 403,
      body: errorBody("capability_not_entitled", "Agents Vault is not part of this workspace", { capability: "agents_vault", reason: "not_entitled", required_plan: "agents_vault_addon" }),
    }));
    const error = await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }));
    expect(error).toBeInstanceOf(VaultNotEntitledError);
    expect(isVaultLocked(error)).toBe(true);
    expect(error).toMatchObject({
      code: "capability_not_entitled",
      locked: true,
      reason: "not_entitled",
      capability: "agents_vault",
      requiredPlan: "agents_vault_addon",
      requestId: "req_test_1",
      status: 403,
      actionId: ACTION_ID,
    });
    expect(calls).toHaveLength(1);
  });

  it("distinguishes an edition that does not include the module and a disabled rollout", async () => {
    for (const [code, reason] of [["capability_not_in_edition", "not_in_edition"], ["capability_disabled", "disabled"]] as const) {
      const { client } = vaultClient(() => ({ status: 403, body: errorBody(code, "locked") }));
      const error = await rejection(client.tools.execute(INPUT));
      expect(error).toMatchObject({ locked: true, reason });
    }
  });

  it("does not call a permission failure a lock", async () => {
    const { client } = vaultClient(() => ({ status: 403, body: errorBody("vault_permission_denied", "permission credential.use is required") }));
    const error = await rejection(client.tools.execute(INPUT));
    expect(isVaultLocked(error)).toBe(false);
    expect(error).toMatchObject({ name: "VaultPermissionError", code: "vault_permission_denied" });
  });

  it("maps a pending approval with its approval id, and the same actionId resumes it", async () => {
    const { client, calls } = vaultClient((call, index) =>
      index === 1
        ? { status: 202, body: { status: "approval_required", action_id: ACTION_ID, approval_id: APPROVAL_ID } }
        : { body: finished(String(call.body?.action_id), { result: { merged: true } }) },
    );
    const pending = await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }));
    expect(pending).toBeInstanceOf(VaultApprovalRequiredError);
    expect(pending).toMatchObject({ code: "approval_required", pending: true, approvalId: APPROVAL_ID, actionId: ACTION_ID, status: 202, retryable: false });
    const resumed = await client.tools.execute({ ...INPUT, actionId: (pending as VaultApprovalRequiredError).actionId });
    expect(resumed.result).toEqual({ merged: true });
    expect(calls.map((call) => call.body?.action_id)).toEqual([ACTION_ID, ACTION_ID]);
  });

  it("maps a policy denial with its reason codes", async () => {
    const { client, calls } = vaultClient(() => ({
      status: 403,
      body: { status: "denied", action_id: ACTION_ID, reason_codes: ["destructive_effect", "no_policy_bound"], explanation: "This action is not permitted." },
    }));
    const error = await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }));
    expect(error).toBeInstanceOf(VaultPolicyDeniedError);
    expect(error).toMatchObject({ code: "policy_denied", reasonCodes: ["destructive_effect", "no_policy_bound"], explanation: "This action is not permitted.", actionId: ACTION_ID });
    expect(calls).toHaveLength(1);
  });

  it("maps a resent denied action, settled as refused, back to a policy denial", async () => {
    const { client } = vaultClient(() => ({ body: finished(ACTION_ID, { state: "refused", result: null, status_code: null, error_class: "destructive_effect,no_policy_bound" }) }));
    const error = await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }));
    expect(error).toBeInstanceOf(VaultPolicyDeniedError);
    expect((error as VaultPolicyDeniedError).reasonCodes).toEqual(["destructive_effect", "no_policy_bound"]);
  });

  it("maps grant failures and tells a missing grant from an exhausted one", async () => {
    for (const reason of ["not_found", "not_approved", "expired", "exhausted"] as const) {
      const { client } = vaultClient(() => ({ status: 409, body: errorBody("vault_grant_unusable", `grant is not usable: ${reason}`) }));
      const error = await rejection(client.tools.execute(INPUT));
      expect(error).toBeInstanceOf(VaultGrantUnusableError);
      expect(error).toMatchObject({ code: "vault_grant_unusable", reason });
    }
  });

  it("maps a revoked or suspended binding", async () => {
    const { client } = vaultClient(() => ({ status: 409, body: errorBody("vault_revoked", "credential or authority is revoked") }));
    const error = await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }));
    expect(error).toBeInstanceOf(VaultRevokedError);
    expect(error).toMatchObject({ code: "vault_revoked", status: 409, actionId: ACTION_ID });
  });

  it("maps validation, authentication, not found and conflict", async () => {
    const cases: Array<[number, string, new (...args: never[]) => VaultError]> = [
      [400, "validation_error", VaultValidationError],
      [401, "unauthorized", VaultAuthenticationError],
      [404, "not_found", VaultNotFoundError],
      [409, "conflict", VaultConflictError],
    ];
    for (const [status, code, type] of cases) {
      const { client } = vaultClient(() => ({ status, body: errorBody(code, "refused") }));
      const error = await rejection(client.tools.execute(INPUT));
      expect(error).toBeInstanceOf(type);
      expect(error).toMatchObject({ code, status });
    }
  });

  it("maps a refused body from the tool gateway and keeps unknown vault_ codes typed", async () => {
    const refused = vaultClient(() => ({ status: 409, body: { status: "refused", action_id: ACTION_ID, code: "live_writes_denied", message: "live writes are denied" } }));
    expect(await rejection(refused.client.tools.execute({ ...INPUT, actionId: ACTION_ID }))).toMatchObject({ name: "VaultRefusedError", code: "live_writes_denied", actionId: ACTION_ID });
    const other = vaultClient(() => ({ status: 409, body: errorBody("vault_result_blocked", "response blocked by the result filter") }));
    expect(await rejection(other.client.tools.execute(INPUT))).toMatchObject({ name: "VaultRefusedError", code: "vault_result_blocked" });
  });

  it("maps a destination failure to an error that carries the filtered body", async () => {
    const { client } = vaultClient(() => ({ body: finished(ACTION_ID, { state: "failed", result: { error: "not found" }, status_code: 404, error_class: "http_404" }) }));
    const error = await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }));
    expect(error).toBeInstanceOf(VaultExecutionFailedError);
    expect(error).toMatchObject({ code: "execution_failed", statusCode: 404, errorClass: "http_404", result: { error: "not found" }, actionId: ACTION_ID });
  });

  it("reports an execution still in flight as a conflict to poll, not as a result", async () => {
    const { client } = vaultClient(() => ({ body: finished(ACTION_ID, { state: "sent", result: null }) }));
    expect(await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }))).toMatchObject({ name: "VaultConflictError", code: "execution_in_progress" });
  });
});

describe("fails closed on anything it does not recognize", () => {
  const unrecognized: Array<[string, { status?: number; body?: unknown; rawText?: string }]> = [
    ["an empty 2xx body", { rawText: "" }],
    ["a non JSON 2xx body", { rawText: "<html>ok</html>" }],
    ["a 2xx body without a status", { body: { ok: true } }],
    ["a succeeded state that is not finished", { body: { status: "succeeded", action_id: ACTION_ID } }],
    ["an unknown state", { body: finished(ACTION_ID, { state: "mystery" }) }],
    ["a denied body on a 200", { body: { status: "denied", action_id: ACTION_ID, reason_codes: [] } }],
    ["an approval body on a 200", { body: { status: "approval_required", action_id: ACTION_ID, approval_id: APPROVAL_ID } }],
    ["a finished body for another action", { body: finished(OTHER_ACTION_ID) }],
  ];
  for (const [name, reply] of unrecognized) {
    it(`refuses ${name}`, async () => {
      const { client, calls } = vaultClient(() => reply);
      const error = await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }));
      expect(error).toBeInstanceOf(VaultError);
      expect(error).toMatchObject({ code: "invalid_response" });
      expect(calls).toHaveLength(1);
    });
  }

  it("does not put a non JSON error page in the message", async () => {
    const { client } = vaultClient(() => ({ status: 502, rawText: `<html>${CANARY}</html>` }));
    const error = await rejection(client.tools.execute({ ...INPUT, actionId: ACTION_ID }));
    expect(error).toMatchObject({ status: 502, retryable: true });
    expect(String((error as Error).message)).not.toContain("html");
  });
});

describe("configuration", () => {
  it("refuses a runtime call without a runtime token and sends nothing", async () => {
    const { client, calls } = vaultClient(() => ({ body: finished(ACTION_ID) }), { runtimeToken: undefined });
    const error = await rejection(client.tools.execute(INPUT));
    expect(error).toBeInstanceOf(VaultConfigurationError);
    expect(error).toMatchObject({ code: "runtime_token_required" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a token that is not a vrt_ enrollment token, without echoing it", () => {
    const attempt = (): AgenomicClient => new AgenomicClient({ apiKey: API_KEY, baseUrl: BASE, vault: { runtimeToken: API_KEY } });
    expect(attempt).toThrowError(VaultConfigurationError);
    expect(() => attempt()).toThrowError(/vrt_/);
    try {
      attempt();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(API_KEY);
    }
  });

  it("requires a base url like the rest of client.tools", async () => {
    const client = new AgenomicClient({ vault: { runtimeToken: RUNTIME_TOKEN } });
    expect(await rejection(client.tools.execute(INPUT))).toMatchObject({ code: "cloud_required" });
  });

  it("falls back to the global fetch when no fetchImpl is given", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(finished(ACTION_ID)), { status: 200 }));
    const client = new AgenomicClient({ baseUrl: BASE, vault: { runtimeToken: RUNTIME_TOKEN } });
    expect((await client.tools.execute({ ...INPUT, actionId: ACTION_ID })).actionId).toBe(ACTION_ID);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("logging", () => {
  it("logs routing facts only, with retries visible and no body, header or token", async () => {
    const events: VaultLogEvent[] = [];
    const { client } = vaultClient((call, index) => (index === 1 ? { status: 503 } : { body: finished(String(call.body?.action_id)) }), { logger: (event) => events.push(event) });
    await client.tools.execute({ ...INPUT, actionId: ACTION_ID });
    expect(events.map((event) => event.phase)).toEqual(["request", "response", "retry", "request", "response"]);
    const text = JSON.stringify(events);
    expect(text).not.toContain("ada@example.test");
    expect(text).not.toContain(RUNTIME_TOKEN);
    expect(events[0]).toMatchObject({ surface: "runtime", method: "POST", path: "/v1/vault/runtime/executions", actionId: ACTION_ID });
  });

  it("survives a logger that throws", async () => {
    const { client } = vaultClient(() => ({ body: finished(ACTION_ID) }), {
      logger: () => {
        throw new Error("logger broke");
      },
    });
    expect((await client.tools.execute({ ...INPUT, actionId: ACTION_ID })).actionId).toBe(ACTION_ID);
  });
});
