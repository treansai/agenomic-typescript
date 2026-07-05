/**
 * Hugging Face provider connection.
 *
 * Provides:
 * - {@link normalizeProvider} / {@link isHuggingFace}: canonicalize the provider
 *   name from its accepted aliases.
 * - {@link HuggingFaceConfig}: environment-sourced configuration that holds the
 *   API token privately and can {@link HuggingFaceConfig.redact | redact} it (and
 *   any `hf_...`-shaped token) out of arbitrary text.
 * - {@link HuggingFaceClient}: a thin client over the Hub + Inference APIs using
 *   the global `fetch`, with a per-request timeout via `AbortController`.
 * - {@link lockModel}: build a deterministic, credential-free "lock" block that
 *   pins a model revision/commit + task + endpoint + parameters by hash.
 *
 * Security: the token is never logged, returned, or embedded in any object,
 * trace, or error. All error strings are passed through {@link HuggingFaceConfig.redact}.
 */

import { createHash } from "node:crypto";

import { stableStringify } from "../utils";

/** Canonical provider name shared across the platform. */
export const HUGGINGFACE_PROVIDER = "huggingface" as const;

/** Default Hugging Face Hub API root. */
export const HUGGINGFACE_HUB_URL = "https://huggingface.co";
/** Default serverless Inference API root. */
export const HUGGINGFACE_INFERENCE_URL = "https://api-inference.huggingface.co";
/** Default request timeout (seconds). */
export const HUGGINGFACE_DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * Accepted aliases (case-insensitive; `-` and `_` are equivalent), each
 * normalized to {@link HUGGINGFACE_PROVIDER}.
 */
const HUGGINGFACE_ALIASES = new Set(["huggingface", "hf", "hugging_face"]);

function canonicalizeAlias(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, "_");
}

/**
 * Normalize a provider name to its canonical form, or `null` when it is not a
 * recognized provider. Only Hugging Face aliases are recognized here; any other
 * (already-canonical) provider name is passed through unchanged.
 */
export function normalizeProvider(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const canonical = canonicalizeAlias(name);
  if (canonical.length === 0) return null;
  if (HUGGINGFACE_ALIASES.has(canonical)) return HUGGINGFACE_PROVIDER;
  return canonical;
}

/** Whether `name` refers to the Hugging Face provider (via any alias). */
export function isHuggingFace(name: string | null | undefined): boolean {
  if (typeof name !== "string") return false;
  return HUGGINGFACE_ALIASES.has(canonicalizeAlias(name));
}

/** A token-shaped string (`hf_...`). Used for defense-in-depth redaction. */
const HF_TOKEN_PATTERN = /hf_[A-Za-z0-9]{8,}/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove every occurrence of `token` and any `hf_...`-shaped token from `text`,
 * replacing them with `[REDACTED]`. Returns the input unchanged when it contains
 * no secrets.
 */
export function redactToken(text: string, token?: string): string {
  let out = text.replace(HF_TOKEN_PATTERN, "[REDACTED]");
  if (token && token.length > 0) {
    out = out.replace(new RegExp(escapeRegExp(token), "g"), "[REDACTED]");
  }
  return out;
}

export interface HuggingFaceConfigInit {
  /** API token. Held privately; never serialized. */
  token?: string;
  /** Custom inference endpoint base URL (no inline credentials allowed). */
  endpointUrl?: string;
  /** Default organization / namespace. */
  org?: string;
  /** Default model id. */
  defaultModel?: string;
  /** Per-request timeout in seconds. */
  timeoutSeconds?: number;
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Reject endpoint URLs that embed inline credentials (`user:pass@host`). */
function assertNoInlineCredentials(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`HuggingFace endpoint URL is not a valid URL: ${url}`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error(
      "HuggingFace endpoint URL must not contain inline credentials",
    );
  }
}

/**
 * Hugging Face configuration. The token is stored on a non-enumerable private
 * field so it is never copied into traces, JSON, or error payloads. Use
 * {@link HuggingFaceConfig.hasToken} to check presence and {@link HuggingFaceConfig.redact}
 * to scrub it from text.
 */
export class HuggingFaceConfig {
  /** Custom inference endpoint base URL, if configured. */
  readonly endpointUrl?: string;
  /** Default organization / namespace, if configured. */
  readonly org?: string;
  /** Default model id, if configured. */
  readonly defaultModel?: string;
  /** Per-request timeout in seconds. */
  readonly timeoutSeconds: number;

  /** Private token store — never enumerable, never serialized. */
  #token?: string;

  constructor(init: HuggingFaceConfigInit = {}) {
    if (init.endpointUrl) {
      assertNoInlineCredentials(init.endpointUrl);
    }
    this.#token = init.token;
    this.endpointUrl = init.endpointUrl;
    this.org = init.org;
    this.defaultModel = init.defaultModel;
    this.timeoutSeconds =
      init.timeoutSeconds && init.timeoutSeconds > 0
        ? init.timeoutSeconds
        : HUGGINGFACE_DEFAULT_TIMEOUT_SECONDS;
  }

  /**
   * Build a config from the environment.
   *
   * Token precedence: `HUGGINGFACE_API_TOKEN` then `HF_TOKEN`.
   * Optional: `HUGGINGFACE_ENDPOINT_URL`, `HUGGINGFACE_ORG`,
   * `HUGGINGFACE_DEFAULT_MODEL`, `HUGGINGFACE_TIMEOUT_SECONDS` (default 30).
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): HuggingFaceConfig {
    const token =
      readEnv(env, "HUGGINGFACE_API_TOKEN") ?? readEnv(env, "HF_TOKEN");
    const timeoutRaw = readEnv(env, "HUGGINGFACE_TIMEOUT_SECONDS");
    const timeoutSeconds = timeoutRaw ? Number(timeoutRaw) : undefined;

    return new HuggingFaceConfig({
      token,
      endpointUrl: readEnv(env, "HUGGINGFACE_ENDPOINT_URL"),
      org: readEnv(env, "HUGGINGFACE_ORG"),
      defaultModel: readEnv(env, "HUGGINGFACE_DEFAULT_MODEL"),
      timeoutSeconds:
        timeoutSeconds !== undefined && Number.isFinite(timeoutSeconds)
          ? timeoutSeconds
          : undefined,
    });
  }

  /** Whether a token is configured (without exposing it). */
  hasToken(): boolean {
    return typeof this.#token === "string" && this.#token.length > 0;
  }

  /**
   * Internal accessor for the raw token. Not part of the public surface that is
   * ever serialized — callers must only use it to populate an `Authorization`
   * header and must never log the result.
   */
  getToken(): string | undefined {
    return this.#token;
  }

  /** Scrub the configured token and any `hf_...` token from `text`. */
  redact(text: string): string {
    return redactToken(text, this.#token);
  }

  /** Keep the token out of `JSON.stringify`, `console.log`, etc. */
  toJSON(): Record<string, unknown> {
    return {
      endpointUrl: this.endpointUrl,
      org: this.org,
      defaultModel: this.defaultModel,
      timeoutSeconds: this.timeoutSeconds,
      hasToken: this.hasToken(),
    };
  }
}

/** Raised for any Hugging Face request failure; message is always redacted. */
export class HuggingFaceError extends Error {
  readonly status?: number;
  constructor(message: string, options: { status?: number; redact?: (t: string) => string } = {}) {
    const redact = options.redact ?? ((t: string) => redactToken(t));
    super(redact(message));
    this.name = "HuggingFaceError";
    this.status = options.status;
  }
}

/** Raised on 401/403 from the Hub / Inference API. */
export class HuggingFaceAuthError extends HuggingFaceError {
  constructor(message: string, options: { status?: number; redact?: (t: string) => string } = {}) {
    super(message, options);
    this.name = "HuggingFaceAuthError";
  }
}

/** Metadata resolved for a model revision from the Hub. */
export interface HuggingFaceModelMetadata {
  modelId: string;
  revision: string;
  /** Resolved commit SHA (`sha`) for the requested revision. */
  resolvedCommit?: string;
  /** Pipeline tag / task (`pipeline_tag`). */
  task?: string;
  /** Whether the repo is private. */
  private?: boolean;
}

export interface HuggingFaceClientOptions {
  config?: HuggingFaceConfig;
  /** Override the global `fetch` (mainly for tests). */
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Whether the call requires an auth token. */
  auth?: boolean;
  /** Accept 401/403 without throwing (caller inspects status). */
  raw?: boolean;
}

/**
 * Client over the Hub metadata API, whoami, and the Inference API. All errors
 * are redacted; 401/403 become {@link HuggingFaceAuthError}.
 */
export class HuggingFaceClient {
  readonly config: HuggingFaceConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HuggingFaceClientOptions = {}) {
    this.config = options.config ?? HuggingFaceConfig.fromEnv();
    const impl = options.fetchImpl ?? globalThis.fetch;
    if (typeof impl !== "function") {
      throw new Error(
        "global fetch is not available; pass fetchImpl or run on Node 18+",
      );
    }
    this.fetchImpl = impl;
  }

  private get inferenceBase(): string {
    return (this.config.endpointUrl ?? HUGGINGFACE_INFERENCE_URL).replace(/\/+$/, "");
  }

  private authHeaders(required: boolean): Record<string, string> {
    const token = this.config.getToken();
    if (!token) {
      if (required) {
        throw new HuggingFaceAuthError(
          "HuggingFace API token is required; set HUGGINGFACE_API_TOKEN or HF_TOKEN",
          { status: 401, redact: (t) => this.config.redact(t) },
        );
      }
      return {};
    }
    return { authorization: `Bearer ${token}` };
  }

  private async request(url: string, options: RequestOptions = {}): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutSeconds * 1000,
    );
    try {
      const headers: Record<string, string> = {
        ...this.authHeaders(options.auth ?? false),
      };
      if (options.body !== undefined) {
        headers["content-type"] = "application/json";
      }
      const response = await this.fetchImpl(url, {
        method: options.method ?? "GET",
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      if (!options.raw && (response.status === 401 || response.status === 403)) {
        throw new HuggingFaceAuthError(
          `HuggingFace authentication failed (${response.status}); check your API token`,
          { status: response.status, redact: (t) => this.config.redact(t) },
        );
      }
      return response;
    } catch (error) {
      if (error instanceof HuggingFaceError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new HuggingFaceError(
          `HuggingFace request timed out after ${this.config.timeoutSeconds}s`,
          { redact: (t) => this.config.redact(t) },
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new HuggingFaceError(`HuggingFace request failed: ${message}`, {
        redact: (t) => this.config.redact(t),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!response.ok) {
      throw new HuggingFaceError(
        `HuggingFace request failed with ${response.status} ${response.statusText}: ${text}`,
        { status: response.status, redact: (t) => this.config.redact(t) },
      );
    }
    return text ? (JSON.parse(text) as unknown) : {};
  }

  /**
   * Validate the configured credentials via `GET /api/whoami-v2`. Returns the
   * decoded whoami record (no token). Throws {@link HuggingFaceAuthError} on
   * 401/403 or when no token is configured.
   */
  async validateCredentials(): Promise<Record<string, unknown>> {
    const response = await this.request(`${HUGGINGFACE_HUB_URL}/api/whoami-v2`, {
      auth: true,
    });
    return (await this.readJson(response)) as Record<string, unknown>;
  }

  /**
   * Resolve metadata for `modelId` at `revision` via
   * `GET /api/models/{id}/revision/{rev}`, extracting the resolved commit
   * (`sha`), task (`pipeline_tag`), and `private` flag.
   */
  async resolveModelMetadata(
    modelId: string,
    revision = "main",
  ): Promise<HuggingFaceModelMetadata> {
    const url = `${HUGGINGFACE_HUB_URL}/api/models/${encodeURIComponent(modelId)}/revision/${encodeURIComponent(revision)}`;
    const response = await this.request(url, { auth: this.config.hasToken() });
    const body = (await this.readJson(response)) as Record<string, unknown>;
    return {
      modelId: typeof body.id === "string" ? body.id : modelId,
      revision,
      resolvedCommit: typeof body.sha === "string" ? body.sha : undefined,
      task: typeof body.pipeline_tag === "string" ? body.pipeline_tag : undefined,
      private: typeof body.private === "boolean" ? body.private : undefined,
    };
  }

  /**
   * Run text generation against `POST {inference}/models/{model}` with
   * `{ inputs, parameters }`. Returns the parsed response body.
   */
  async generateText(
    model: string,
    prompt: string,
    parameters?: Record<string, unknown>,
  ): Promise<unknown> {
    const url = `${this.inferenceBase}/models/${model}`;
    const response = await this.request(url, {
      method: "POST",
      auth: this.config.hasToken(),
      body: {
        inputs: prompt,
        ...(parameters ? { parameters } : {}),
      },
    });
    return this.readJson(response);
  }

  /**
   * Run feature extraction / embeddings against `POST {inference}/models/{model}`
   * with `{ inputs }`. Returns the parsed response body.
   */
  async embeddings(model: string, inputs: string | string[]): Promise<unknown> {
    const url = `${this.inferenceBase}/models/${model}`;
    const response = await this.request(url, {
      method: "POST",
      auth: this.config.hasToken(),
      body: { inputs },
    });
    return this.readJson(response);
  }
}

/**
 * A credential-free "lock" block that pins a model to a resolved revision +
 * task + endpoint + parameters. Hashes are sha256 hex over canonical (stably
 * key-sorted) JSON of the relevant inputs, so the lock is reproducible and
 * diff-able without storing any secrets.
 */
export interface HuggingFaceLock {
  provider: typeof HUGGINGFACE_PROVIDER;
  modelId: string;
  /** Snake-case mirror for cross-language genome compatibility. */
  model_id: string;
  revision: string;
  resolvedCommit?: string;
  task?: string;
  /** Redacted `scheme://host[/path]` reference, or undefined for the default. */
  endpointRef?: string;
  /** sha256 over the redacted endpoint reference (undefined when no endpoint). */
  endpointHash?: string;
  /** sha256 over the canonical metadata (modelId/revision/commit/task/private). */
  metadataHash: string;
  /** sha256 over the canonical parameters (`{}` when none). */
  parameterHash: string;
}

/** sha256 hex over canonical JSON of `value` (stable key ordering). */
function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/**
 * Reduce an endpoint URL to a redacted `scheme://host[/path]` reference, with
 * any inline credentials and query/fragment stripped. Returns `undefined` for a
 * missing/invalid URL.
 */
function redactEndpointRef(endpointUrl?: string): string | undefined {
  if (!endpointUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return undefined;
  }
  const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname.replace(/\/+$/, "") : "";
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/**
 * Build a {@link HuggingFaceLock} from resolved metadata. Never stores
 * credentials: the endpoint is reduced to a redacted host reference, and the
 * token is not consulted.
 */
export function lockModel(
  meta: HuggingFaceModelMetadata,
  endpointUrl?: string,
  parameters?: Record<string, unknown>,
): HuggingFaceLock {
  const endpointRef = redactEndpointRef(endpointUrl);
  const params = parameters ?? {};

  return {
    provider: HUGGINGFACE_PROVIDER,
    modelId: meta.modelId,
    model_id: meta.modelId,
    revision: meta.revision,
    resolvedCommit: meta.resolvedCommit,
    task: meta.task,
    endpointRef,
    endpointHash: endpointRef ? sha256Canonical(endpointRef) : undefined,
    metadataHash: sha256Canonical({
      modelId: meta.modelId,
      revision: meta.revision,
      resolvedCommit: meta.resolvedCommit,
      task: meta.task,
      private: meta.private,
    }),
    parameterHash: sha256Canonical(params),
  };
}
