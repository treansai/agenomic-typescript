import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { AgenomicClient, RuntimeToken, Sensitive, VaultConfigurationError, VaultNotEntitledError, type VaultBindingContent } from "../src";
import { ACTION_ID, API_KEY, BASE, CANARY, ID, RUNTIME_TOKEN, errorBody, finished, vaultClient } from "./vault-helpers";

const OPENAPI_OPERATIONS = [
  "GET /v1/vault/status",
  "GET /v1/vault/providers",
  "POST /v1/vault/providers",
  "GET /v1/vault/providers/{id}",
  "POST /v1/vault/providers/{id}/health",
  "POST /v1/vault/providers/{id}/state",
  "GET /v1/vault/secrets",
  "POST /v1/vault/secrets",
  "POST /v1/vault/secrets/references",
  "GET /v1/vault/secrets/{id}",
  "POST /v1/vault/secrets/{id}/versions",
  "POST /v1/vault/secrets/{id}/revoke",
  "GET /v1/vault/bindings",
  "POST /v1/vault/bindings",
  "GET /v1/vault/bindings/{id}",
  "POST /v1/vault/bindings/{id}/versions",
  "POST /v1/vault/bindings/{id}/versions/{version}/submit",
  "POST /v1/vault/bindings/{id}/versions/{version}/decide",
  "POST /v1/vault/bindings/{id}/versions/{version}/activate",
  "POST /v1/vault/bindings/{id}/revoke",
  "GET /v1/vault/runtime-identities",
  "POST /v1/vault/runtime-identities",
  "POST /v1/vault/runtime-identities/{id}/revoke",
  "GET /v1/vault/grants",
  "POST /v1/vault/grants",
  "POST /v1/vault/grants/{id}/decide",
  "POST /v1/vault/grants/{id}/revoke",
  "GET /v1/vault/revocations",
  "POST /v1/vault/kill-switch",
  "GET /v1/vault/executions",
  "GET /v1/vault/executions/{action_id}",
  "GET /v1/vault/receipts",
  "POST /v1/vault/runtime/executions",
  "GET /v1/vault/runtime/executions/{action_id}",
  "GET /v1/vault/runtime/grants",
  "POST /v1/vault/runtime/grants",
  "POST /v1/vault/secrets/{id}/rotations",
  "GET /v1/vault/rotations",
  "GET /v1/vault/rotations/{id}",
  "POST /v1/vault/rotations/{id}/activate",
  "POST /v1/vault/rotations/{id}/rollback",
  "POST /v1/vault/revocations/{id}/retry",
  "POST /v1/vault/revocations/{id}/lift",
  "POST /v1/vault/executions/{action_id}/resolve",
  "POST /v1/vault/runtime/grants/{id}/delegations",
];

const CONTENT: VaultBindingContent = {
  secret_id: ID,
  upstream_identity: "crm-service-account",
  tool_contract_ref: "crm.contacts.create@1",
  destination: { scheme: "https", host: "crm.example.test", port: 443 },
  auth: { kind: "bearer" },
  request: { method: "POST", path: "/v1/accounts/{account}/contacts", path_params: [{ name: "account", pattern: "^[a-z0-9-]+$" }], body: { mode: "arguments" } },
  effect: "write",
};

const IDENTITY = { id: ID, environment: "prod", agent_id: "agent-1", label: "ci", declared_release: null, declared_genome_digest: null, assurance: "enrollment_token_declared_release", expires_at: "2026-10-05T12:00:00Z", revoked_at: null, created_at: "2026-10-05T11:00:00Z", last_used_at: null };
const REVOCATION = { id: ID, target_kind: "binding", target_id: ID, agenomic_state: "blocked_locally", provider_state: "not_applicable", reason: "incident", requested_by: null, requested_at: "2026-10-05T11:00:00Z", provider_confirmed_at: null, attempts: 0 };
const GRANT = { id: ID, binding_id: ID, binding_version: 3, environment: "prod", agent_id: "agent-1", state: "requested", max_uses: 5, uses: 0, expires_at: "2026-10-06T00:00:00Z", requested_by_user: null, requested_by_identity: null, requested_at: "2026-10-05T11:00:00Z", decided_by: null, decided_at: null, reason: "monthly sync", parent_grant_id: null, depth: 0 };
const ROTATION = { id: ID, secret_id: ID, new_version_id: ID, old_version_id: ID, retire_version_id: null, state: "prepared", direction: "forward", overlap_seconds: 3600, retire_after: null, attempts: 0, next_attempt_at: null, last_error: null, requested_by: null, created_at: "2026-10-05T11:00:00Z", updated_at: "2026-10-05T11:00:00Z" };
const SECRET_DETAIL = { secret: { id: ID, environment: "prod", name: "crm", state: "active" }, versions: [] };
const BINDING_DETAIL = { binding: { id: ID, name: "binding-crm-sales" }, versions: [] };
const BINDING_VERSION = { version: 3, state: "draft", digest: "sha256:abc", content: CONTENT };
const PROVIDER = { id: ID, name: "bao", kind: "openbao", mode: "managed", state: "active" };

interface Operation {
  template: string;
  run: (client: AgenomicClient) => Promise<unknown>;
  reply: unknown;
  query?: Record<string, string>;
  body?: unknown;
}

const REASON = { reason: "incident" };

const OPERATIONS: Operation[] = [
  { template: "GET /v1/vault/status", run: (c) => c.vault.status(), reply: { installed: true, entitled: false, capability: { id: "agents_vault", enabled: false, reason: "not_entitled", required_plan: null }, permissions: [], usage: { providers: 0, secrets: 0, bindings: 0, runtime_identities: 0 }, limitations: [] } },
  { template: "GET /v1/vault/providers", run: (c) => c.vault.providers.list(), reply: [PROVIDER] },
  { template: "POST /v1/vault/providers", run: (c) => c.vault.providers.create({ name: "bao", mode: "managed", descriptor: { kind: "openbao", address: "http://127.0.0.1:8200", mount: "kv", auth: { method: "token", env_var: "AGENOMIC_VAULT_TOKEN" } } }), reply: PROVIDER, body: { name: "bao", mode: "managed", descriptor: { kind: "openbao", address: "http://127.0.0.1:8200", mount: "kv", auth: { method: "token", env_var: "AGENOMIC_VAULT_TOKEN" } } } },
  { template: "GET /v1/vault/providers/{id}", run: (c) => c.vault.providers.get(ID), reply: PROVIDER },
  { template: "POST /v1/vault/providers/{id}/health", run: (c) => c.vault.providers.checkHealth(ID), reply: PROVIDER },
  { template: "POST /v1/vault/providers/{id}/state", run: (c) => c.vault.providers.setState(ID, { state: "disabled", reason: "maintenance" }), reply: PROVIDER, body: { state: "disabled", reason: "maintenance" } },
  { template: "GET /v1/vault/secrets", run: (c) => c.vault.secrets.list({ environment: "prod", providerId: ID, state: "active" }), reply: [], query: { environment: "prod", provider_id: ID, state: "active" } },
  { template: "POST /v1/vault/secrets", run: (c) => c.vault.secrets.create({ environment: "prod", name: "crm", secretType: "api_key", classification: "restricted", providerId: ID, providerRef: "kv/crm", value: new Sensitive(CANARY) }), reply: SECRET_DETAIL, body: { environment: "prod", name: "crm", secret_type: "api_key", classification: "restricted", provider_id: ID, provider_ref: "kv/crm", value: CANARY } },
  { template: "POST /v1/vault/secrets/references", run: (c) => c.vault.secrets.registerReference({ environment: "prod", name: "crm", secretType: "api_key", providerId: ID, providerRef: "kv/crm", providerVersion: "7" }), reply: SECRET_DETAIL, body: { environment: "prod", name: "crm", secret_type: "api_key", provider_id: ID, provider_ref: "kv/crm", provider_version: "7" } },
  { template: "GET /v1/vault/secrets/{id}", run: (c) => c.vault.secrets.get(ID), reply: SECRET_DETAIL },
  { template: "POST /v1/vault/secrets/{id}/versions", run: (c) => c.vault.secrets.addVersion(ID, { value: new Sensitive(CANARY) }), reply: SECRET_DETAIL, body: { value: CANARY } },
  { template: "POST /v1/vault/secrets/{id}/revoke", run: (c) => c.vault.secrets.revoke(ID, REASON), reply: REVOCATION, body: REASON },
  { template: "GET /v1/vault/bindings", run: (c) => c.vault.bindings.list({ environment: "prod", agentId: "agent-1", state: "active" }), reply: [], query: { environment: "prod", agent_id: "agent-1", state: "active" } },
  { template: "POST /v1/vault/bindings", run: (c) => c.vault.bindings.create({ environment: "prod", name: "binding-crm-sales", agentId: "agent-1", toolName: "crm.contacts.create", content: CONTENT }), reply: BINDING_DETAIL, body: { environment: "prod", name: "binding-crm-sales", agent_id: "agent-1", tool_name: "crm.contacts.create", content: CONTENT } },
  { template: "GET /v1/vault/bindings/{id}", run: (c) => c.vault.bindings.get(ID), reply: BINDING_DETAIL },
  { template: "POST /v1/vault/bindings/{id}/versions", run: (c) => c.vault.bindings.proposeVersion(ID, { content: CONTENT }), reply: BINDING_VERSION, body: { content: CONTENT } },
  { template: "POST /v1/vault/bindings/{id}/versions/{version}/submit", run: (c) => c.vault.bindings.submit(ID, 3), reply: BINDING_VERSION },
  { template: "POST /v1/vault/bindings/{id}/versions/{version}/decide", run: (c) => c.vault.bindings.approve(ID, 3), reply: BINDING_VERSION, body: { approve: true } },
  { template: "POST /v1/vault/bindings/{id}/versions/{version}/activate", run: (c) => c.vault.bindings.activate(ID, 3), reply: BINDING_DETAIL },
  { template: "POST /v1/vault/bindings/{id}/revoke", run: (c) => c.vault.bindings.revoke(ID, REASON), reply: REVOCATION, body: REASON },
  { template: "GET /v1/vault/runtime-identities", run: (c) => c.vault.runtimeIdentities.list(), reply: [IDENTITY] },
  { template: "POST /v1/vault/runtime-identities", run: (c) => c.vault.runtimeIdentities.issue({ environment: "prod", agentId: "agent-1", label: "ci", ttlSeconds: 3600, declaredRelease: "r1", declaredGenomeDigest: "blake3:abc" }), reply: { identity: IDENTITY, token: "vrt_issued_once_token_0001" }, body: { environment: "prod", agent_id: "agent-1", label: "ci", ttl_seconds: 3600, declared_release: "r1", declared_genome_digest: "blake3:abc" } },
  { template: "POST /v1/vault/runtime-identities/{id}/revoke", run: (c) => c.vault.runtimeIdentities.revoke(ID, REASON), reply: IDENTITY, body: REASON },
  { template: "GET /v1/vault/grants", run: (c) => c.vault.grants.list({ bindingId: ID, agentId: "agent-1", state: "requested" }), reply: [GRANT], query: { binding_id: ID, agent_id: "agent-1", state: "requested" } },
  { template: "POST /v1/vault/grants", run: (c) => c.vault.grants.request({ bindingId: ID, version: 3, maxUses: 5, ttlSeconds: 3600, reason: "monthly sync" }), reply: GRANT, body: { binding_id: ID, version: 3, max_uses: 5, ttl_seconds: 3600, reason: "monthly sync" } },
  { template: "POST /v1/vault/grants/{id}/decide", run: (c) => c.vault.grants.approve(ID), reply: GRANT, body: { approve: true } },
  { template: "POST /v1/vault/grants/{id}/revoke", run: (c) => c.vault.grants.revoke(ID, REASON), reply: REVOCATION, body: REASON },
  { template: "GET /v1/vault/revocations", run: (c) => c.vault.revocations.list(), reply: [REVOCATION] },
  { template: "POST /v1/vault/kill-switch", run: (c) => c.vault.killSwitch({ targetKind: "agent", targetId: "agent-1", reason: "incident" }), reply: REVOCATION, body: { target_kind: "agent", target_id: "agent-1", reason: "incident" } },
  { template: "GET /v1/vault/executions", run: (c) => c.vault.executions.list({ state: "outcome_unknown", limit: 25 }), reply: [], query: { state: "outcome_unknown", limit: "25" } },
  { template: "GET /v1/vault/executions/{action_id}", run: (c) => c.vault.executions.get(ACTION_ID), reply: finished(ACTION_ID) },
  { template: "GET /v1/vault/receipts", run: (c) => c.vault.receipts.list({ actionId: ACTION_ID, limit: 10 }), reply: [], query: { action_id: ACTION_ID, limit: "10" } },
  { template: "POST /v1/vault/runtime/executions", run: (c) => c.tools.execute({ tool: "crm.contacts.create", binding: "binding-crm-sales", actionId: ACTION_ID }), reply: finished(ACTION_ID), body: { tool: "crm.contacts.create", binding: "binding-crm-sales", arguments: {}, action_id: ACTION_ID } },
  { template: "GET /v1/vault/runtime/executions/{action_id}", run: (c) => c.vault.runtime.getExecution(ACTION_ID), reply: finished(ACTION_ID) },
  { template: "GET /v1/vault/runtime/grants", run: (c) => c.vault.runtime.grants.list({ bindingId: ID, state: "approved" }), reply: [GRANT], query: { binding_id: ID, state: "approved" } },
  { template: "POST /v1/vault/runtime/grants", run: (c) => c.vault.runtime.grants.request({ bindingId: ID, maxUses: 2, ttlSeconds: 600, reason: "one off" }), reply: GRANT, body: { binding_id: ID, max_uses: 2, ttl_seconds: 600, reason: "one off" } },
  { template: "POST /v1/vault/secrets/{id}/rotations", run: (c) => c.vault.secrets.rotate(ID, { value: new Sensitive(CANARY), overlapSeconds: 600 }), reply: ROTATION, body: { value: CANARY, overlap_seconds: 600 } },
  { template: "GET /v1/vault/rotations", run: (c) => c.vault.rotations.list(), reply: [ROTATION] },
  { template: "GET /v1/vault/rotations/{id}", run: (c) => c.vault.rotations.get(ID), reply: ROTATION },
  { template: "POST /v1/vault/rotations/{id}/activate", run: (c) => c.vault.rotations.activate(ID), reply: ROTATION },
  { template: "POST /v1/vault/rotations/{id}/rollback", run: (c) => c.vault.rotations.rollback(ID, REASON), reply: ROTATION, body: REASON },
  { template: "POST /v1/vault/revocations/{id}/retry", run: (c) => c.vault.revocations.retry(ID), reply: REVOCATION },
  { template: "POST /v1/vault/revocations/{id}/lift", run: (c) => c.vault.revocations.lift(ID, REASON), reply: { ...REVOCATION, agenomic_state: "lifted", lifted_by: ID, lifted_at: "2026-10-05T12:00:00Z", lift_reason: "incident over" }, body: REASON },
  { template: "POST /v1/vault/executions/{action_id}/resolve", run: (c) => c.vault.executions.resolve(ACTION_ID, { resolution: "not_applied", note: "verified at the destination: no record" }), reply: finished(ACTION_ID, { state: "failed", result: null, error_class: "operator_resolved" }), body: { resolution: "not_applied", note: "verified at the destination: no record" } },
  { template: "POST /v1/vault/runtime/grants/{id}/delegations", run: (c) => c.vault.runtime.grants.delegate(ID, { delegateAgentId: "agent-2", maxUses: 1, ttlSeconds: 300, reason: "hand over" }), reply: { ...GRANT, parent_grant_id: ID, depth: 1 }, body: { delegate_agent_id: "agent-2", max_uses: 1, ttl_seconds: 300, reason: "hand over" } },
];

function pathOf(template: string): string {
  return (template.split(" ")[1] ?? "").replace("{id}", ID).replace("{action_id}", ACTION_ID).replace("{version}", "3");
}

describe("vault admin and runtime surface", () => {
  it("has a test for every operation of the OpenAPI document and nothing else", () => {
    expect(new Set(OPERATIONS.map((operation) => operation.template))).toEqual(new Set(OPENAPI_OPERATIONS));
    expect(OPERATIONS).toHaveLength(OPENAPI_OPERATIONS.length);
  });

  for (const operation of OPERATIONS) {
    it(`${operation.template}`, async () => {
      const { client, calls } = vaultClient(() => ({ body: operation.reply }));
      await operation.run(client);
      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call?.method).toBe(operation.template.split(" ")[0]);
      expect(call?.path).toBe(pathOf(operation.template));
      expect(Object.fromEntries(new URL(call?.url ?? BASE).searchParams)).toEqual(operation.query ?? {});
      expect(call?.body).toEqual(operation.body);
      const runtime = operation.template.includes("/runtime/");
      expect(call?.headers.authorization).toBe(`Bearer ${runtime ? RUNTIME_TOKEN : API_KEY}`);
    });
  }
});

describe("responses", () => {
  it("returns new fields of revocations, grants and rotations as the server sent them", async () => {
    const lifted = vaultClient(() => ({ body: { ...REVOCATION, agenomic_state: "lifted", next_attempt_at: null, last_error: "provider_timeout", lifted_at: "2026-10-05T12:00:00Z", lifted_by: ID, lift_reason: "done" } }));
    expect(await lifted.client.vault.revocations.lift(ID, REASON)).toMatchObject({ agenomic_state: "lifted", last_error: "provider_timeout", lift_reason: "done" });
    const delegated = vaultClient(() => ({ body: { ...GRANT, parent_grant_id: ID, depth: 2 } }));
    expect(await delegated.client.vault.runtime.grants.delegate(ID, { delegateAgentId: "a", maxUses: 1, ttlSeconds: 1, reason: "r" })).toMatchObject({ parent_grant_id: ID, depth: 2 });
  });

  it("approves and rejects a binding version and approves and denies a grant through the same decide routes", async () => {
    const { client, calls } = vaultClient((call) => ({ body: call.path.includes("grants") ? GRANT : BINDING_VERSION }));
    await client.vault.bindings.reject(ID, 4);
    await client.vault.grants.deny(ID);
    expect(calls.map((call) => [call.path.split("/").slice(-1)[0], call.body])).toEqual([["decide", { approve: false }], ["decide", { approve: false }]]);
  });

  it("encodes path segments", async () => {
    const { client, calls } = vaultClient(() => ({ body: PROVIDER }));
    await client.vault.providers.get("a/b ?x");
    expect(calls[0]?.url).toBe(`${BASE}/v1/vault/providers/a%2Fb%20%3Fx`);
  });

  it("refuses a body of the wrong shape instead of typing it", async () => {
    const notList = vaultClient(() => ({ body: { providers: [] } }));
    expect(await notList.client.vault.providers.list().catch((error: unknown) => error)).toMatchObject({ code: "invalid_response" });
    const noKey = vaultClient(() => ({ body: { id: ID } }));
    expect(await noKey.client.vault.secrets.get(ID).catch((error: unknown) => error)).toMatchObject({ code: "invalid_response" });
    const empty = vaultClient(() => ({ rawText: "" }));
    expect(await empty.client.vault.status().catch((error: unknown) => error)).toMatchObject({ code: "invalid_response" });
  });
});

describe("entitlement", () => {
  it("relays a locked business operation as VaultNotEntitledError and still reads metadata", async () => {
    const { client } = vaultClient((call) =>
      call.method === "GET" ? { body: [] } : { status: 403, body: errorBody("capability_not_entitled", "locked", { capability: "agents_vault", required_plan: "addon" }) },
    );
    const error = await client.vault.providers.create({ name: "p", mode: "managed", descriptor: { kind: "openbao", address: "http://x", mount: "kv", auth: { method: "token", env_var: "T" } } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultNotEntitledError);
    expect(error).toMatchObject({ locked: true, reason: "not_entitled", requiredPlan: "addon" });
    expect(await client.vault.secrets.list()).toEqual([]);
  });

  it("does not decide entitlement: status is returned exactly as the server reports it", async () => {
    const status = { installed: false, entitled: false, capability: { id: "agents_vault", enabled: false, reason: "not_in_edition", required_plan: null }, permissions: [], usage: { providers: 0, secrets: 0, bindings: 0, runtime_identities: 0 }, limitations: ["x"] };
    const { client } = vaultClient(() => ({ body: status }));
    expect(await client.vault.status()).toEqual(status);
  });
});

describe("retries on the admin surface", () => {
  it("retries a read after a 503 but never resends a write", async () => {
    const reads = vaultClient((_call, index) => (index === 1 ? { status: 503 } : { body: [] }));
    await reads.client.vault.providers.list();
    expect(reads.calls).toHaveLength(2);
    const writes = vaultClient(() => ({ status: 503 }));
    await writes.client.vault.killSwitch({ targetKind: "workspace", targetId: "w", reason: "r" }).catch(() => undefined);
    expect(writes.calls).toHaveLength(1);
  });

  it("retries a rate limited write: the server refused it before processing", async () => {
    const { client, calls } = vaultClient((_call, index) => (index === 1 ? { status: 429, headers: { "retry-after": "0" }, body: errorBody("too_many_requests", "slow down") } : { body: REVOCATION }));
    await client.vault.killSwitch({ targetKind: "workspace", targetId: "w", reason: "r" });
    expect(calls).toHaveLength(2);
  });
});

describe("credentials", () => {
  it("needs an apiKey for admin calls and a baseUrl for any call", async () => {
    const network = vaultClient(() => ({ body: [] }));
    const noKey = new AgenomicClient({ baseUrl: BASE, vault: { fetchImpl: network.fetchImpl } });
    await expect(noKey.vault.providers.list()).rejects.toMatchObject({ code: "api_key_required" });
    const noBase = new AgenomicClient({ apiKey: API_KEY, vault: { fetchImpl: network.fetchImpl } });
    await expect(noBase.vault.providers.list()).rejects.toBeInstanceOf(VaultConfigurationError);
    expect(network.calls).toHaveLength(0);
  });

  it("never sends the runtime token on an admin route", async () => {
    const { client, calls } = vaultClient(() => ({ body: [] }));
    await client.vault.providers.list();
    expect(JSON.stringify(calls)).not.toContain(RUNTIME_TOKEN);
  });
});

describe("runtime identity tokens", () => {
  it("is shown once, masked in every view, and not kept in the response object", async () => {
    const { client } = vaultClient(() => ({ body: { identity: IDENTITY, token: "vrt_issued_once_token_0001" } }));
    const issued = await client.vault.runtimeIdentities.issue({ environment: "prod", agentId: "agent-1", label: "ci" });
    expect(issued.token).toBeInstanceOf(RuntimeToken);
    for (const view of [JSON.stringify(issued), inspect(issued, { depth: 5 }), String(issued.token), `${String(issued.token)}`, JSON.stringify(structuredClone(issued.token))]) {
      expect(view).not.toContain("vrt_issued_once");
    }
    const configured = new AgenomicClient({ baseUrl: BASE, vault: { runtimeToken: issued.token, fetchImpl: vaultClient(() => ({ body: finished(ACTION_ID) })).fetchImpl } });
    expect(configured.vault.mode).toBe("live");
    expect(issued.token.takeOnce()).toBe("vrt_issued_once_token_0001");
    expect(() => issued.token.takeOnce()).toThrow();
  });

  it("uses a RuntimeToken passed straight to the client and sends it as the bearer", async () => {
    const issuer = vaultClient(() => ({ body: { identity: IDENTITY, token: "vrt_issued_once_token_0001" } }));
    const issued = await issuer.client.vault.runtimeIdentities.issue({ environment: "prod", agentId: "agent-1", label: "ci" });
    const agent = vaultClient(() => ({ body: finished(ACTION_ID) }), { runtimeToken: issued.token });
    await agent.client.tools.execute({ tool: "t", binding: "b", actionId: ACTION_ID });
    expect(agent.calls[0]?.headers.authorization).toBe("Bearer vrt_issued_once_token_0001");
  });

  it("refuses an issue response without a token", async () => {
    const { client } = vaultClient(() => ({ body: { identity: IDENTITY } }));
    await expect(client.vault.runtimeIdentities.issue({ environment: "prod", agentId: "agent-1", label: "ci" })).rejects.toMatchObject({ code: "invalid_response" });
  });
});
