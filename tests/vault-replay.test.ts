import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import {
  AgenomicClient,
  VaultApprovalRequiredError,
  VaultConfigurationError,
  VaultConflictError,
  VaultNotEntitledError,
  VaultOutcomeUnknownError,
  VaultPolicyDeniedError,
  VaultReplayFixtureMissingError,
  Sensitive,
  VaultReplayUnavailableError,
  parseVaultReplayFixtures,
  type VaultReplayFixture,
} from "../src";
import { ACTION_ID, API_KEY, APPROVAL_ID, BASE, ID, OTHER_ACTION_ID, RUNTIME_TOKEN, fakeNetwork } from "./vault-helpers";

const CREATE = { tool: "crm.contacts.create", binding: "binding-crm-sales" };

afterEach(() => {
  vi.restoreAllMocks();
});

function replayClient(fixtures: VaultReplayFixture[]): { client: AgenomicClient; liveFetch: MockInstance; injected: MockInstance } {
  const liveFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("a live request was attempted from replay mode");
  });
  const network = fakeNetwork(() => ({ body: {} }));
  const injected = vi.fn(network.fetchImpl);
  const client = new AgenomicClient({ apiKey: API_KEY, baseUrl: BASE, vault: { replay: { fixtures }, fetchImpl: injected as unknown as typeof fetch } });
  return { client, liveFetch, injected };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

describe("replay mode", () => {
  it("answers from a fixture, marks the result as replayed, and never touches the network", async () => {
    const { client, liveFetch, injected } = replayClient([{ ...CREATE, outcome: { kind: "succeeded", result: { id: "contact_1" }, receiptId: ID, statusCode: 201 } }]);
    const result = await client.tools.execute({ ...CREATE, arguments: { email: "ada@example.test" }, actionId: ACTION_ID });
    expect(result).toMatchObject({ actionId: ACTION_ID, status: "succeeded", result: { id: "contact_1" }, receiptId: ID, statusCode: 201, source: "replay", attempts: 1 });
    expect(client.vault.mode).toBe("replay");
    expect(liveFetch).not.toHaveBeenCalled();
    expect(injected).not.toHaveBeenCalled();
  });

  it("a missing fixture is an explicit error and never a live call", async () => {
    const { client, liveFetch, injected } = replayClient([{ ...CREATE, outcome: { kind: "succeeded" } }]);
    const error = await rejection(client.tools.execute({ tool: "crm.contacts.delete", binding: "binding-crm-sales", actionId: ACTION_ID }));
    expect(error).toBeInstanceOf(VaultReplayFixtureMissingError);
    expect(error).toMatchObject({ code: "replay_fixture_missing", actionId: ACTION_ID, status: 0 });
    expect(String((error as Error).message)).toMatch(/crm\.contacts\.delete/);
    expect(String((error as Error).message)).toMatch(/never falls back to a live call/);
    expect(liveFetch).not.toHaveBeenCalled();
    expect(injected).not.toHaveBeenCalled();
  });

  it("refuses a Sensitive in the arguments in replay mode too, where no serializer would catch it", async () => {
    const { client, liveFetch } = replayClient([{ ...CREATE, outcome: { kind: "succeeded" } }]);
    const error = await rejection(client.tools.execute({ ...CREATE, arguments: { token: new Sensitive("sk_live_canary_value_123") } }));
    expect(error).toMatchObject({ code: "sensitive_refused", status: 0 });
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("an empty fixture set refuses every call", async () => {
    const { client, liveFetch } = replayClient([]);
    expect(await rejection(client.tools.execute({ ...CREATE }))).toBeInstanceOf(VaultReplayFixtureMissingError);
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("matches on tool, binding and, when given, the exact arguments, preferring the exact fixture", async () => {
    const { client } = replayClient([
      { ...CREATE, outcome: { kind: "succeeded", result: "any" } },
      { ...CREATE, arguments: { b: 2, a: { y: 1, x: 0 } }, outcome: { kind: "succeeded", result: "exact" } },
      { tool: "crm.contacts.create", binding: "other-binding", outcome: { kind: "succeeded", result: "other" } },
    ]);
    expect((await client.tools.execute({ ...CREATE, arguments: { a: { x: 0, y: 1 }, b: 2 } })).result).toBe("exact");
    expect((await client.tools.execute({ ...CREATE, arguments: { a: 1 } })).result).toBe("any");
    expect((await client.tools.execute({ tool: "crm.contacts.create", binding: "other-binding" })).result).toBe("other");
  });

  it("a fixture restricted to arguments does not match other arguments", async () => {
    const { client } = replayClient([{ ...CREATE, arguments: { email: "ada@example.test" }, outcome: { kind: "succeeded" } }]);
    expect(await rejection(client.tools.execute({ ...CREATE, arguments: { email: "grace@example.test" } }))).toBeInstanceOf(VaultReplayFixtureMissingError);
  });

  it("answers a settled action the same way on resend and refuses the actionId for a different request", async () => {
    const { client } = replayClient([{ ...CREATE, outcomes: [{ kind: "succeeded", result: "first" }, { kind: "succeeded", result: "second" }] }]);
    expect((await client.tools.execute({ ...CREATE, actionId: ACTION_ID })).result).toBe("first");
    expect((await client.tools.execute({ ...CREATE, actionId: ACTION_ID })).result).toBe("first");
    expect((await client.tools.execute({ ...CREATE, actionId: OTHER_ACTION_ID })).result).toBe("first");
    const reused = await rejection(client.tools.execute({ ...CREATE, arguments: { different: true }, actionId: ACTION_ID }));
    expect(reused).toBeInstanceOf(VaultConflictError);
    expect(reused).toMatchObject({ code: "conflict", status: 409 });
  });

  it("replays an approval: pending first, the same actionId succeeds afterwards", async () => {
    const { client } = replayClient([{ ...CREATE, outcomes: [{ kind: "approval_required", approvalId: APPROVAL_ID }, { kind: "succeeded", result: { merged: true } }] }]);
    const pending = await rejection(client.tools.execute({ ...CREATE, actionId: ACTION_ID }));
    expect(pending).toBeInstanceOf(VaultApprovalRequiredError);
    expect(pending).toMatchObject({ approvalId: APPROVAL_ID, actionId: ACTION_ID });
    expect((await client.tools.execute({ ...CREATE, actionId: ACTION_ID })).result).toEqual({ merged: true });
    expect(await rejection(client.tools.execute({ ...CREATE, actionId: OTHER_ACTION_ID }))).toBeInstanceOf(VaultApprovalRequiredError);
  });

  it("replays a denial like the server: denied first, then a settled refusal with the same reason codes", async () => {
    const { client } = replayClient([{ ...CREATE, outcome: { kind: "denied", reasonCodes: ["destructive_effect"], explanation: "not permitted" } }]);
    const first = await rejection(client.tools.execute({ ...CREATE, actionId: ACTION_ID }));
    const second = await rejection(client.tools.execute({ ...CREATE, actionId: ACTION_ID }));
    for (const error of [first, second]) {
      expect(error).toBeInstanceOf(VaultPolicyDeniedError);
      expect((error as VaultPolicyDeniedError).reasonCodes).toEqual(["destructive_effect"]);
    }
  });

  it("accepts a denied fixture without reason codes", async () => {
    const { client } = replayClient([{ ...CREATE, outcome: { kind: "denied" } }]);
    const error = await rejection(client.tools.execute({ ...CREATE, actionId: ACTION_ID }));
    expect(error).toBeInstanceOf(VaultPolicyDeniedError);
    expect((error as VaultPolicyDeniedError).reasonCodes).toEqual([]);
  });

  it("replays an unknown outcome and never turns it into a success on resend", async () => {
    const { client } = replayClient([{ ...CREATE, outcomes: [{ kind: "outcome_unknown", receiptId: ID }, { kind: "succeeded" }] }]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const error = await rejection(client.tools.execute({ ...CREATE, actionId: ACTION_ID }));
      expect(error).toBeInstanceOf(VaultOutcomeUnknownError);
      expect(error).toMatchObject({ actionId: ACTION_ID, receiptId: ID, retryable: false });
    }
  });

  it("replays a locked add-on through the same error class as a live call", async () => {
    const { client } = replayClient([{ ...CREATE, outcome: { kind: "error", status: 403, code: "capability_not_entitled", capability: "agents_vault", requiredPlan: "addon" } }]);
    const error = await rejection(client.tools.execute({ ...CREATE }));
    expect(error).toBeInstanceOf(VaultNotEntitledError);
    expect(error).toMatchObject({ locked: true, reason: "not_entitled", requiredPlan: "addon" });
  });

  it("replays a failure that succeeds on the next call of the same action (an error does not settle)", async () => {
    const { client } = replayClient([{ ...CREATE, outcomes: [{ kind: "error", status: 429, code: "too_many_requests" }, { kind: "succeeded", result: "ok" }] }]);
    expect(await rejection(client.tools.execute({ ...CREATE, actionId: ACTION_ID }))).toMatchObject({ code: "too_many_requests" });
    expect((await client.tools.execute({ ...CREATE, actionId: ACTION_ID })).result).toBe("ok");
  });

  it("reads back a replayed execution and refuses to read one it never replayed", async () => {
    const { client, liveFetch } = replayClient([{ ...CREATE, outcome: { kind: "succeeded", result: { id: 1 } } }]);
    await client.tools.execute({ ...CREATE, actionId: ACTION_ID });
    expect(await client.tools.executionStatus(ACTION_ID)).toMatchObject({ action_id: ACTION_ID, state: "succeeded", result: { id: 1 } });
    expect(await rejection(client.tools.executionStatus(OTHER_ACTION_ID))).toBeInstanceOf(VaultReplayFixtureMissingError);
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("never sends admin or grant calls live", async () => {
    const { client, liveFetch, injected } = replayClient([]);
    const calls = [
      client.vault.status(),
      client.vault.providers.list(),
      client.vault.secrets.list(),
      client.vault.killSwitch({ targetKind: "workspace", targetId: "w", reason: "r" }),
      client.vault.runtime.grants.list(),
      client.vault.runtime.grants.request({ bindingId: ID, maxUses: 1, ttlSeconds: 60, reason: "r" }),
    ];
    for (const call of calls) {
      const error = await rejection(call);
      expect(error).toBeInstanceOf(VaultReplayUnavailableError);
      expect(error).toMatchObject({ code: "replay_unavailable" });
    }
    expect(liveFetch).not.toHaveBeenCalled();
    expect(injected).not.toHaveBeenCalled();
  });

  it("cannot be combined with a runtime token: a replay client holds nothing to go live with", () => {
    const build = (): AgenomicClient => new AgenomicClient({ baseUrl: BASE, vault: { replay: { fixtures: [] }, runtimeToken: RUNTIME_TOKEN } });
    expect(build).toThrowError(VaultConfigurationError);
    expect(build).toThrowError(/replay_with_credentials|cannot be combined/);
  });

  it("does not exist as a live client unless asked for", () => {
    expect(new AgenomicClient({ baseUrl: BASE, vault: { runtimeToken: RUNTIME_TOKEN } }).vault.mode).toBe("live");
  });
});

describe("replay fixtures", () => {
  it("validates fixtures read from JSON and normalizes a single outcome", () => {
    const parsed = parseVaultReplayFixtures(JSON.parse(JSON.stringify([{ ...CREATE, outcome: { kind: "succeeded", result: { id: 1 } } }])));
    expect(parsed).toEqual([{ ...CREATE, outcomes: [{ kind: "succeeded", result: { id: 1 } }] }]);
  });

  it("names the offending path and never echoes a value", () => {
    const bad = [{ ...CREATE, outcome: { kind: "succeeded", result: "ok" }, extra: "sk_live_canary_value" }, { ...CREATE, outcome: { kind: "teleport" } }, { ...CREATE }, { ...CREATE, outcome: { kind: "succeeded" }, outcomes: [{ kind: "succeeded" }] }];
    for (const fixture of bad) {
      let message = "";
      try {
        parseVaultReplayFixtures([fixture]);
      } catch (error) {
        expect(error).toBeInstanceOf(VaultConfigurationError);
        expect(error).toMatchObject({ code: "replay_fixtures_invalid" });
        message = String((error as Error).message);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("sk_live_canary_value");
    }
  });

  it("refuses an invalid fixture set when the client is built", () => {
    expect(() => new AgenomicClient({ vault: { replay: { fixtures: [{ tool: "", binding: "b", outcome: { kind: "succeeded" } }] } } })).toThrowError(/invalid replay fixtures/);
  });
});
