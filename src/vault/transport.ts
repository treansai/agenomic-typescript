import type { AgenomicClient } from "../client";
import { apiBase, type JsonMethod } from "../tools";
import { VaultConfigurationError, VaultError, VaultTransportError, VaultValidationError } from "./errors";
import type { VaultReplayOptions } from "./replay";
import {
  RuntimeToken,
  Sensitive,
  isMasked,
  scrubDeep,
  scrubText,
  serializeRuntimeToken,
  serializeSensitive,
} from "./sensitive";

export type VaultSurface = "admin" | "runtime";

export interface VaultRetryOptions {
  /** Total HTTP attempts per call, first included (default 3, 1 disables retries). */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** A log event. It carries routing facts only: never a body, a header, a query value or a token. */
export interface VaultLogEvent {
  phase: "request" | "response" | "retry" | "fault";
  surface: VaultSurface;
  method: string;
  path: string;
  attempt: number;
  status?: number;
  delayMs?: number;
  durationMs?: number;
  actionId?: string;
}

export type VaultLogger = (event: VaultLogEvent) => void;

export interface VaultClientOptions {
  /** Runtime-identity token (`vrt_...`) used by `client.tools.execute` and `client.vault.runtime`. Never sent on admin routes. */
  runtimeToken?: string | RuntimeToken;
  /** Replay mode: answer from fixtures and never touch the network. Cannot be combined with `runtimeToken`. */
  replay?: VaultReplayOptions;
  /** Override the global `fetch` (mainly for tests). */
  fetchImpl?: typeof fetch;
  retry?: VaultRetryOptions;
  /** Per-request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  logger?: VaultLogger;
}

export interface VaultRequest {
  surface: VaultSurface;
  method: JsonMethod;
  /** Already percent-encoded, without a query string. */
  path: string;
  query?: Record<string, string | number | undefined>;
  /** JSON body. A `Sensitive` inside it is substituted at serialization time and only when `allowSensitive` is set. */
  body?: unknown;
  allowSensitive?: boolean;
  /** True when a resend is safe (reads, and executions keyed by `actionId`). */
  idempotent?: boolean;
  actionId?: string;
  timeoutMs?: number;
}

export interface VaultExchange {
  status: number;
  body: unknown;
  retryAfterMs?: number;
  requestId?: string;
  attempts: number;
  source: "live" | "replay";
  /** Removes the secret texts of this request from text bound for an error. */
  scrub(text: string): string;
}

export interface VaultTransport {
  readonly mode: "live" | "replay";
  send(request: VaultRequest): Promise<VaultExchange>;
}

export function segment(value: string): string {
  return encodeURIComponent(value);
}

const DEFAULT_TIMEOUT_MS = 30_000;
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key"]);
const RETRYABLE_CONFLICTS = new Set(["vault_backend_unavailable", "vault_destination_unavailable"]);
const RUNTIME_TOKEN_PREFIX = "vrt_";

function queryString(query: VaultRequest["query"]): string {
  const pairs = Object.entries(query ?? {})
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return pairs.length > 0 ? `?${pairs.join("&")}` : "";
}

interface WireBody {
  text: string;
  secrets: string[];
}

function serializeBody(body: unknown, allowSensitive: boolean): WireBody {
  const secrets: string[] = [];
  const replacer = function (this: Record<string, unknown>, key: string, value: unknown): unknown {
    const original = this[key];
    if (!isMasked(original)) return value;
    if (!allowSensitive || !(original instanceof Sensitive)) {
      throw new VaultValidationError("a Sensitive value cannot be sent in this request", { code: "sensitive_refused", status: 0 });
    }
    const raw = serializeSensitive(original);
    secrets.push(raw);
    return raw;
  };
  try {
    return { text: JSON.stringify(body, replacer), secrets };
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultValidationError("the request body is not JSON serializable", { code: "body_not_serializable", status: 0 });
  }
}

/** Refuses a `Sensitive` or `RuntimeToken` anywhere inside `value`, which would otherwise travel as the mask text. */
export function assertNoSensitive(value: unknown): void {
  serializeBody(value, false);
}

function parseBody(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("retry-after");
  const seconds = raw === null || raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

function errorCodeOf(body: unknown): string {
  const error = (body as { error?: { code?: unknown } } | undefined)?.error;
  return typeof error?.code === "string" ? error.code : "";
}

function errnoCode(error: unknown): string | undefined {
  const carrier = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = carrier?.cause?.code ?? carrier?.code;
  return typeof code === "string" && /^[A-Z0-9_]{3,40}$/.test(code) ? code : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Settled = { kind: "exchange"; exchange: VaultExchange } | { kind: "fault"; fault: VaultTransportError };

interface Prepared {
  url: string;
  headers: Record<string, string>;
  body?: string;
  scrub(text: string): string;
  scrubBody(body: unknown): unknown;
  carriesSecret: boolean;
}

function callerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())));
}

function normalizeRuntimeToken(token: string | RuntimeToken | undefined): string | undefined {
  if (token === undefined) return undefined;
  const text = serializeRuntimeToken(token);
  if (!text.startsWith(RUNTIME_TOKEN_PREFIX)) {
    throw new VaultConfigurationError(
      "runtime_token_invalid",
      `the runtime token must be a ${RUNTIME_TOKEN_PREFIX} enrollment token; organisation API keys are never accepted on runtime routes`,
    );
  }
  return text;
}

function resolveRetry(retry: VaultRetryOptions | undefined): Required<VaultRetryOptions> {
  return {
    maxAttempts: Math.max(1, Math.floor(retry?.maxAttempts ?? 3)),
    baseDelayMs: Math.max(0, retry?.baseDelayMs ?? 250),
    maxDelayMs: Math.max(0, retry?.maxDelayMs ?? 5000),
  };
}

function isRetryable(settled: Settled, request: VaultRequest): boolean {
  if (settled.kind === "fault") return settled.fault.retryable;
  const { status, body } = settled.exchange;
  if (status === 429) return true;
  if (request.idempotent !== true) return false;
  return status === 502 || status === 503 || status === 504 || (status === 409 && RETRYABLE_CONFLICTS.has(errorCodeOf(body)));
}

function retryDelay(settled: Settled, attempt: number, request: VaultRequest, retry: Required<VaultRetryOptions>): number | undefined {
  if (attempt >= retry.maxAttempts || !isRetryable(settled, request)) return undefined;
  const hinted = settled.kind === "exchange" ? settled.exchange.retryAfterMs : undefined;
  if (hinted !== undefined && hinted > retry.maxDelayMs) return undefined;
  return Math.max(Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1)), hinted ?? 0);
}

function faultFor(error: unknown, request: VaultRequest): VaultTransportError {
  const name = error instanceof Error ? error.name : "Error";
  const timedOut = name === "TimeoutError" || name === "AbortError";
  const detail = timedOut ? "timed out" : (errnoCode(error) ?? name);
  return new VaultTransportError(`${request.method} ${request.path} did not complete: no response was received (${detail})`, {
    timedOut,
    maybeSent: true,
    actionId: request.actionId,
    retryable: !timedOut && request.idempotent === true,
  });
}

/**
 * The live HTTP transport. Admin calls carry the client API key and runtime
 * calls carry the `vrt_` token; neither credential is ever sent on the other
 * surface. Retries resend the identical serialized body, so an `actionId`
 * never changes between attempts. Errors and logs are built from routing facts
 * and scrubbed server text only; the request body never reaches them.
 */
export class LiveVaultTransport implements VaultTransport {
  readonly mode = "live" as const;
  readonly #client: AgenomicClient;
  readonly #runtimeToken?: string;
  readonly #fetchImpl?: typeof fetch;
  readonly #retry: Required<VaultRetryOptions>;
  readonly #timeoutMs: number;
  readonly #logger?: VaultLogger;

  constructor(client: AgenomicClient, options: VaultClientOptions = {}) {
    this.#client = client;
    this.#runtimeToken = normalizeRuntimeToken(options.runtimeToken);
    this.#fetchImpl = options.fetchImpl;
    this.#retry = resolveRetry(options.retry);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#logger = options.logger;
  }

  async send(request: VaultRequest): Promise<VaultExchange> {
    const prepared = this.prepare(request);
    for (let attempt = 1; ; attempt += 1) {
      const settled = await this.attempt(prepared, request, attempt);
      const delayMs = retryDelay(settled, attempt, request, this.#retry);
      if (delayMs === undefined) return settle(settled);
      this.log({ phase: "retry", attempt, delayMs }, request);
      await sleep(delayMs);
    }
  }

  private credential(surface: VaultSurface): string {
    const credential = surface === "admin" ? this.#client.apiKey : this.#runtimeToken;
    if (credential) return credential;
    throw surface === "admin"
      ? new VaultConfigurationError("api_key_required", "client.vault admin calls need an apiKey on the AgenomicClient")
      : new VaultConfigurationError("runtime_token_required", "runtime calls need vault.runtimeToken (a vrt_ enrollment token) on the AgenomicClient");
  }

  private prepare(request: VaultRequest): Prepared {
    const base = apiBase(this.#client);
    if (!base) {
      throw new VaultConfigurationError("cloud_required", "this call requires a baseUrl on the client; there is no local fallback");
    }
    const credential = this.credential(request.surface);
    const wire = request.body === undefined ? undefined : serializeBody(request.body, request.allowSensitive === true);
    const secrets = [...(wire?.secrets ?? []), credential];
    return {
      url: base + request.path + queryString(request.query),
      headers: {
        accept: "application/json",
        ...(wire ? { "content-type": "application/json" } : {}),
        ...callerHeaders(this.#client.headers),
        authorization: `Bearer ${credential}`,
      },
      ...(wire ? { body: wire.text } : {}),
      scrub: (text) => scrubText(text, secrets),
      scrubBody: (body) => scrubDeep(body, secrets),
      carriesSecret: (wire?.secrets.length ?? 0) > 0,
    };
  }

  private async attempt(prepared: Prepared, request: VaultRequest, attempt: number): Promise<Settled> {
    const started = Date.now();
    this.log({ phase: "request", attempt }, request);
    try {
      const response = await (this.#fetchImpl ?? globalThis.fetch)(prepared.url, {
        method: request.method,
        headers: prepared.headers,
        ...(prepared.body !== undefined ? { body: prepared.body } : {}),
        signal: AbortSignal.timeout(request.timeoutMs ?? this.#timeoutMs),
      });
      const text = await response.text();
      const durationMs = Date.now() - started;
      this.log({ phase: "response", attempt, status: response.status, durationMs }, request);
      return { kind: "exchange", exchange: exchangeOf(response, text, attempt, prepared) };
    } catch (error) {
      this.log({ phase: "fault", attempt, durationMs: Date.now() - started }, request);
      return { kind: "fault", fault: faultFor(error, request) };
    }
  }

  private log(event: Pick<VaultLogEvent, "phase" | "attempt"> & Partial<VaultLogEvent>, request: VaultRequest): void {
    try {
      this.#logger?.({
        surface: request.surface,
        method: request.method,
        path: request.path,
        ...(request.actionId ? { actionId: request.actionId } : {}),
        ...event,
      });
    } catch {
      return;
    }
  }
}

function exchangeOf(response: Response, text: string, attempts: number, prepared: Prepared): VaultExchange {
  const requestId = response.headers?.get("x-request-id") ?? undefined;
  const body = parseBody(text);
  return {
    status: response.status,
    body: prepared.carriesSecret ? prepared.scrubBody(body) : body,
    retryAfterMs: retryAfterMs(response.headers),
    ...(requestId ? { requestId } : {}),
    attempts,
    source: "live",
    scrub: prepared.scrub,
  };
}

function settle(settled: Settled): VaultExchange {
  if (settled.kind === "fault") throw settled.fault;
  return settled.exchange;
}
