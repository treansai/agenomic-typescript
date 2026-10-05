import { format, inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { AgenomicClient, SENSITIVE_MASK, Sensitive, type VaultLogEvent } from "../src";
import { API_KEY, BASE, CANARY, ID, RUNTIME_TOKEN, allText, errorBody, vaultClient } from "./vault-helpers";

const SECRET_INPUT = { environment: "prod", name: "crm", secretType: "api_key" as const, providerId: ID };
const DETAIL = { secret: { id: ID, environment: "prod", name: "crm", state: "active" }, versions: [] };

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

function encodings(secret: string): string[] {
  const bytes = Buffer.from(secret, "utf8");
  return [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), bytes.toString("base64"), bytes.toString("base64url"), bytes.toString("hex")];
}

function expectClean(value: unknown, label: string): void {
  const views = [allText(value), inspect(value, { depth: 12, showHidden: true }), safeJson(value), format("%O", value), String((value as { stack?: unknown })?.stack ?? "")];
  for (const view of views) {
    for (const needle of [CANARY, ...encodings(CANARY)]) {
      expect(view.includes(needle), `${label} leaked ${needle.slice(0, 12)}`).toBe(false);
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

const WRITES: Array<[string, (client: AgenomicClient) => Promise<unknown>]> = [
  ["secrets.create", (client) => client.vault.secrets.create({ ...SECRET_INPUT, value: new Sensitive(CANARY) })],
  ["secrets.addVersion", (client) => client.vault.secrets.addVersion(ID, { value: new Sensitive(CANARY) })],
  ["secrets.rotate", (client) => client.vault.secrets.rotate(ID, { value: new Sensitive(CANARY) })],
];

describe("a secret value goes in once and never comes back out", () => {
  for (const [name, write] of WRITES) {
    describe(name, () => {
      it("is sent only in the body of the request, never in the URL or a header", async () => {
        const { client, calls } = vaultClient(() => ({ body: name === "secrets.rotate" ? { id: ID } : DETAIL }));
        await write(client);
        const [call] = calls;
        expect(call?.body?.value).toBe(CANARY);
        expect(call?.url).not.toContain(CANARY);
        expect(JSON.stringify(call?.headers)).not.toContain(CANARY);
        expect(JSON.stringify({ ...call?.body, value: undefined })).not.toContain(CANARY);
      });

      it("returns a result that holds no value", async () => {
        const { client } = vaultClient(() => ({ body: name === "secrets.rotate" ? { id: ID } : DETAIL }));
        expectClean(await write(client), `${name} result`);
      });

      it("scrubs a server that echoes the value in a success body", async () => {
        const echo = vaultClient((call) => ({ body: { id: ID, secret: { id: ID, name: String(call.body?.value) }, versions: [{ note: `stored ${String(call.body?.value)}` }] } }));
        const result = await write(echo.client);
        expectClean(result, `${name} echoed result`);
        expect(JSON.stringify(result)).toContain(SENSITIVE_MASK);
      });

      it("keeps the value out of an error whose server message echoes it in every encoding", async () => {
        for (const echo of encodings(CANARY)) {
          const { client } = vaultClient(() => ({ status: 400, body: errorBody("validation_error", `the value ${echo} is not valid`) }));
          const error = await rejection(write(client));
          expect(error).toMatchObject({ code: "validation_error", status: 400 });
          expectClean(error, `${name} error (${echo.slice(0, 6)})`);
        }
      });

      it("keeps the value out of a server error on every status", async () => {
        for (const status of [401, 403, 404, 409, 429, 500, 502]) {
          const { client } = vaultClient(() => ({ status, body: errorBody("vault_backend_rejected", `backend refused ${CANARY}`) }), { retry: { maxAttempts: 1 } });
          expectClean(await rejection(write(client)), `${name} status ${status}`);
        }
      });

      it("keeps the value out of a transport error, even when the fetch layer echoes the request body", async () => {
        const echoing = vaultClient((call) => new Error(`request failed: ${call.rawBody ?? ""}`));
        const error = await rejection(write(echoing.client));
        expect(error).toMatchObject({ code: "transport_error" });
        expectClean(error, `${name} transport error`);
        const wrapped = vaultClient((call) => Object.assign(new TypeError("fetch failed"), { cause: new Error(call.rawBody ?? "") }));
        expectClean(await rejection(write(wrapped.client)), `${name} wrapped transport error`);
      });

      it("keeps the value out of a body that is not JSON", async () => {
        const { client } = vaultClient((call) => ({ status: 502, rawText: `<html>${call.rawBody ?? ""}</html>` }));
        expectClean(await rejection(write(client)), `${name} html error`);
      });

      it("keeps the value out of every log event, including retries", async () => {
        const events: VaultLogEvent[] = [];
        const { client } = vaultClient((_call, index) => (index === 1 ? { status: 429, headers: { "retry-after": "0" }, body: errorBody("too_many_requests", "slow") } : { body: name === "secrets.rotate" ? { id: ID } : DETAIL }), {
          logger: (event) => events.push(event),
        });
        await write(client);
        expect(events.length).toBeGreaterThan(2);
        expectClean(events, `${name} log events`);
      });

      it("keeps the value out of console output of everything the SDK throws or returns", async () => {
        const sink = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const { client } = vaultClient(() => ({ status: 400, body: errorBody("validation_error", `bad ${CANARY}`) }));
        const error = await rejection(write(client));
        console.log(error, { error });
        const written = format(...(sink.mock.calls.flat() as [unknown]));
        vi.restoreAllMocks();
        expect(written).not.toContain(CANARY);
      });
    });
  }

  it("refuses a plain string where a Sensitive is required, without sending and without echoing it", async () => {
    const { client, calls } = vaultClient(() => ({ body: DETAIL }));
    for (const [, write] of [
      ["create", (c: AgenomicClient) => c.vault.secrets.create({ ...SECRET_INPUT, value: CANARY as unknown as Sensitive })],
      ["addVersion", (c: AgenomicClient) => c.vault.secrets.addVersion(ID, { value: CANARY as unknown as Sensitive })],
      ["rotate", (c: AgenomicClient) => c.vault.secrets.rotate(ID, { value: CANARY as unknown as Sensitive })],
      ["object", (c: AgenomicClient) => c.vault.secrets.create({ ...SECRET_INPUT, value: { toString: () => CANARY } as unknown as Sensitive })],
    ] as const) {
      const error = await rejection(write(client));
      expect(error).toMatchObject({ code: "sensitive_required", status: 0 });
      expectClean(error, "plain string refusal");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a disposed Sensitive and one that is not valid UTF-8 text, without sending", async () => {
    const { client, calls } = vaultClient(() => ({ body: DETAIL }));
    const disposed = new Sensitive(CANARY);
    disposed.dispose();
    expect(await rejection(client.vault.secrets.create({ ...SECRET_INPUT, value: disposed }))).toMatchObject({ code: "sensitive_required" });
    const binary = new Sensitive(new Uint8Array([0xff, 0xfe, 0xfd, 0x80, 0x81, 0x82, 0x83, 0x84]));
    expect(await rejection(client.vault.secrets.create({ ...SECRET_INPUT, value: binary }))).toMatchObject({ code: "sensitive_invalid" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a Sensitive anywhere except the value of a secret write", async () => {
    const { client, calls } = vaultClient(() => ({ body: DETAIL }));
    const secret = new Sensitive(CANARY);
    const attempts = [
      client.vault.secrets.registerReference({ environment: "prod", name: secret as unknown as string, secretType: "api_key", providerId: ID, providerRef: "r", providerVersion: "1" }),
      client.vault.providers.setState(ID, { state: "disabled", reason: secret as unknown as string }),
      client.vault.killSwitch({ targetKind: "agent", targetId: "a", reason: secret as unknown as string }),
      client.tools.execute({ tool: "t", binding: "b", arguments: { nested: [{ token: secret }] } }),
    ];
    for (const attempt of attempts) expect(await rejection(attempt)).toMatchObject({ code: "sensitive_refused" });
    expect(calls).toHaveLength(0);
  });

  it("does not let the value survive in the Sensitive wrapper's views after a successful write", async () => {
    const { client } = vaultClient(() => ({ body: DETAIL }));
    const secret = new Sensitive(CANARY);
    const input = { ...SECRET_INPUT, value: secret };
    await client.vault.secrets.create(input);
    expectClean(input, "input object after the call");
    expectClean(secret, "wrapper after the call");
  });
});

describe("the client and its credentials", () => {
  it("holds the runtime token out of every serialization and inspection of the client", () => {
    const { client } = vaultClient(() => ({ body: [] }));
    const views = [JSON.stringify(client.vault), JSON.stringify(client.tools.client.vault), inspect(client, { depth: 12, showHidden: true }), inspect(client.vault, { depth: 12, showHidden: true }), inspect(client.tools, { depth: 12, showHidden: true }), format("%O", client.vault)];
    for (const view of views) expect(view).not.toContain(RUNTIME_TOKEN);
    expect(allText(client.vault)).not.toContain(RUNTIME_TOKEN);
  });

  it("keeps the API key out of runtime requests and the runtime token out of admin requests", async () => {
    const { client, calls } = vaultClient((call) => ({ body: call.path.startsWith("/v1/vault/runtime") ? [] : [] }));
    await client.vault.runtime.grants.list();
    await client.vault.grants.list();
    const [runtime, admin] = calls;
    expect(JSON.stringify(runtime)).not.toContain(API_KEY);
    expect(JSON.stringify(admin)).not.toContain(RUNTIME_TOKEN);
  });

  it("scrubs a credential that a server error message echoes back", async () => {
    const { client } = vaultClient(() => ({ status: 401, body: errorBody("unauthorized", `bad token ${RUNTIME_TOKEN} for ${API_KEY}`) }));
    const error = await rejection(client.vault.runtime.grants.list());
    expect(allText(error)).not.toContain(RUNTIME_TOKEN);
    const admin = await rejection(client.vault.providers.list());
    expect(allText(admin)).not.toContain(API_KEY);
  });

  it("sends nothing when the base URL is missing", async () => {
    const network = vaultClient(() => ({ body: DETAIL }));
    const client = new AgenomicClient({ apiKey: API_KEY, vault: { fetchImpl: network.fetchImpl } });
    expectClean(await rejection(client.vault.secrets.create({ ...SECRET_INPUT, value: new Sensitive(CANARY) })), "cloud_required");
    expect(network.calls).toHaveLength(0);
    expect(BASE).toContain("https://");
  });
});
