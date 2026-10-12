import { AgenomicClient } from "../src/client";
import type { VaultClientOptions } from "../src/vault/transport";

export const BASE = "https://api.agenomic.test";
export const API_KEY = "agm_admin_key_for_tests_0001";
export const RUNTIME_TOKEN = "vrt_runtime_token_for_tests_0001";
export const CANARY = "sk_live_canary_Zx9Qe7Lm2Vb4Nc6T_do_not_leak";
export const ACTION_ID = "5b2c7a10-1d3e-4f56-8a79-0b1c2d3e4f50";
export const OTHER_ACTION_ID = "6c3d8b21-2e4f-4067-9b8a-1c2d3e4f5061";
export const APPROVAL_ID = "7d4e9c32-3f50-4178-8c9b-2d3e4f506172";
export const ID = "8e5fad43-4061-4289-9dac-3e4f50617283";

export interface RecordedCall {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  rawBody?: string;
  body?: Record<string, unknown>;
}

export interface FakeReply {
  status?: number;
  body?: unknown;
  rawText?: string;
  headers?: Record<string, string>;
}

export type Responder = (call: RecordedCall, index: number) => FakeReply | Error;

export interface FakeNetwork {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
}

function record(input: unknown, init: RequestInit | undefined): RecordedCall {
  const url = String(input);
  const rawBody = typeof init?.body === "string" ? init.body : undefined;
  return {
    url,
    path: new URL(url).pathname,
    method: init?.method ?? "GET",
    headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
    ...(rawBody !== undefined ? { rawBody, body: JSON.parse(rawBody) as Record<string, unknown> } : {}),
  };
}

export function fakeNetwork(respond: Responder): FakeNetwork {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const call = record(input, init);
    calls.push(call);
    const reply = respond(call, calls.length);
    if (reply instanceof Error) throw reply;
    const text = reply.rawText ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return new Response(text, { status: reply.status ?? 200, headers: reply.headers });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export const FAST_RETRY = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 };

export function vaultClient(respond: Responder, vault: VaultClientOptions = {}): { client: AgenomicClient } & FakeNetwork {
  const network = fakeNetwork(respond);
  const client = new AgenomicClient({
    apiKey: API_KEY,
    baseUrl: `${BASE}/`,
    vault: { runtimeToken: RUNTIME_TOKEN, fetchImpl: network.fetchImpl, retry: FAST_RETRY, ...vault },
  });
  return { client, ...network };
}

export function finished(actionId: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "finished",
    action_id: actionId,
    state: "succeeded",
    receipt_id: "9f60be54-5172-439a-8ebd-4f5061728394",
    result: { id: "contact_1" },
    status_code: 201,
    error_class: null,
    limitations: [],
    ...fields,
  };
}

export function errorBody(code: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { error: { code, message, request_id: "req_test_1", ...extra } };
}

export function allText(value: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") parts.push(node);
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    for (const key of Object.getOwnPropertyNames(node)) {
      parts.push(key);
      visit((node as Record<string, unknown>)[key]);
    }
  };
  visit(value);
  return parts.join("\n");
}
