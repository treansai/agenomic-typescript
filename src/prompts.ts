import { createHash } from "node:crypto";

import type { AgenomicClient } from "./client";
import { ApiError, PromptRefError, apiError, bindingError, integrityError } from "./errors";
import { PromptBundle } from "./prompt-bundle";
import { LONE_SURROGATE, isPlainRecord } from "./prompt-digest";
import {
  formatPromptRef,
  isUuid,
  parseExecutionRef,
  parsePromptRef,
  versionRefOf,
  type PromptAliasRef,
  type PromptReference,
  type PromptVersionRef,
} from "./prompt-refs";
import {
  buildPromptVersion,
  verifyRecord,
  withResolvedFrom,
  type ManagedPromptVersion,
  type PromptVersionRecord,
} from "./prompt-template";
import { SDK_METADATA } from "./utils";
import { ToolExecutionError, fetchJson, type JsonExchange, type JsonMethod } from "./tools";

const THREAD_KEY_DOMAIN = "agenomic.thread_key/v1";
const MAX_CACHED_VERSIONS = 1024;
const ERROR_EXTRAS = ["request_id", "capability", "reason", "required_plan"] as const;

export type BindingScope = "thread" | "execution";

export interface ExecutionBindingChild {
  release_id: string;
  genome_version: string | null;
  prompt_manifest_digest: string;
  source: "manifest" | "channel";
  channel: string | null;
  generation: number | null;
}

export interface ExecutionBinding {
  schema: "agenomic.execution_binding/v1";
  binding_id: string;
  workspace_id: string;
  agent_id: string;
  thread_key: string;
  scope: BindingScope;
  release_id: string;
  release_name: string;
  genome_version: string | null;
  prompt_manifest_digest: string;
  runtime: { bundle_id: string; bundle_hash: string };
  resolved_from: { channel: string; generation: number } | { release_id: string };
  children: Record<string, ExecutionBindingChild>;
  parent_binding_id: string | null;
  experiment: Record<string, unknown> | null;
  runtime_client: Record<string, string | null> | null;
  created_at: string;
  created_by: { user_id: string | null; api_key_id: string | null } | null;
}

export interface AgentSelectorInput {
  agentId: string;
  channel?: string;
  releaseId?: string;
}

export interface CreateExecutionBindingInput extends AgentSelectorInput {
  threadKey: string;
  scope: BindingScope;
  expectManifestDigest?: string;
}

export interface CreatedBinding {
  binding: ExecutionBinding;
  artifacts: PromptBundle;
  created: boolean;
}

export interface LoadedBinding {
  binding: ExecutionBinding;
  artifacts: PromptBundle;
}

const WORKSPACES = new WeakMap<AgenomicClient, Promise<string>>();

function keyHash(workspaceId: string, identifier: string): string {
  if (!isUuid(workspaceId)) throw new TypeError("workspaceId must be a lowercase uuid");
  if (typeof identifier !== "string") throw new TypeError("thread and execution identifiers must be strings");
  if (LONE_SURROGATE.test(identifier)) throw new TypeError("thread and execution identifiers must be well-formed Unicode");
  return createHash("sha256").update(`${THREAD_KEY_DOMAIN}\u0000${workspaceId}\u0000${identifier}`, "utf8").digest("hex");
}

export function threadKey(workspaceId: string, threadId: string): string {
  return `thread:sha256:${keyHash(workspaceId, threadId)}`;
}

export function executionKey(workspaceId: string, executionId: string): string {
  return `exec:sha256:${keyHash(workspaceId, executionId)}`;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function errorDetails(error: Record<string, unknown>): Record<string, unknown> {
  const details: Record<string, unknown> = isPlainRecord(error.details) ? { ...error.details } : {};
  for (const key of ERROR_EXTRAS) {
    if (Object.hasOwn(error, key) && !Object.hasOwn(details, key)) details[key] = error[key];
  }
  return details;
}

function acceptApiJson(method: JsonMethod, path: string, exchange: JsonExchange): Record<string, unknown> {
  const fallback = `${method} ${path} returned ${exchange.status}`;
  if (exchange.status < 200 || exchange.status >= 300) {
    const error = exchange.body?.error;
    if (!isPlainRecord(error) || typeof error.code !== "string" || error.code === "") {
      throw new ApiError("http_error", exchange.status, fallback);
    }
    const message = typeof error.message === "string" && error.message !== "" ? error.message : fallback;
    throw apiError(error.code, exchange.status, message, errorDetails(error));
  }
  if (exchange.body === undefined) {
    throw new ApiError("invalid_response", exchange.status, `${method} ${path} returned a non-JSON body`);
  }
  return exchange.body;
}

async function callApi(client: AgenomicClient, method: JsonMethod, path: string, body?: unknown): Promise<Record<string, unknown>> {
  let exchange: JsonExchange;
  try {
    exchange = await fetchJson(client, method, path, body);
  } catch (error) {
    if (error instanceof ToolExecutionError) throw new ApiError(error.code, error.status, error.message);
    throw error;
  }
  return acceptApiJson(method, path, exchange);
}

function invalidResponse(what: string): ApiError {
  return new ApiError("invalid_response", 0, `the registry answered an invalid ${what}`);
}

function workspaceOf(client: AgenomicClient): Promise<string> {
  const known = WORKSPACES.get(client);
  if (known) return known;
  const pending = callApi(client, "GET", "/v1/whoami").then((body) => {
    if (!isUuid(body.org_id)) throw invalidResponse("whoami answer");
    return body.org_id;
  });
  WORKSPACES.set(client, pending);
  pending.catch(() => {
    if (WORKSPACES.get(client) === pending) WORKSPACES.delete(client);
  });
  return pending;
}

function selector(input: AgentSelectorInput): { channel: string } | { release_id: string } {
  if ((input.channel === undefined) === (input.releaseId === undefined)) {
    throw new Error("name exactly one of channel and releaseId");
  }
  return input.channel !== undefined ? { channel: input.channel } : { release_id: input.releaseId as string };
}

function toExecutionRef(ref: string | PromptReference): PromptReference {
  return parseExecutionRef(typeof ref === "string" ? ref : formatPromptRef(ref));
}

function wireRecord(item: unknown, workspaceId: string): PromptVersionRecord {
  if (
    !isPlainRecord(item) ||
    typeof item.prompt_id !== "string" ||
    typeof item.version !== "number" ||
    !Number.isInteger(item.version) ||
    typeof item.content_digest !== "string" ||
    !isPlainRecord(item.content)
  ) {
    throw invalidResponse("prompt version");
  }
  const uri = item.canonical_uri;
  if (uri !== undefined && uri !== null) {
    let parsed: PromptReference | string | undefined;
    try {
      parsed = typeof uri === "string" ? parsePromptRef(uri) : undefined;
    } catch (error) {
      if (!(error instanceof PromptRefError)) throw error;
    }
    if (parsed === undefined || typeof parsed === "string" || parsed.form !== "uri") throw invalidResponse("canonical_uri");
    if (parsed.workspaceId !== workspaceId) {
      throw new PromptRefError("workspace_mismatch", 0, "the registry answered for another workspace than the client's");
    }
    if (parsed.promptId !== item.prompt_id || parsed.version !== item.version) throw invalidResponse("canonical_uri");
  }
  return {
    prompt_id: item.prompt_id,
    version: item.version,
    prompt_kind: null,
    content_digest: item.content_digest,
    content: item.content,
  };
}

function readBinding(value: unknown, workspaceId: string, agentId: string): ExecutionBinding {
  if (
    !isPlainRecord(value) ||
    typeof value.binding_id !== "string" ||
    typeof value.workspace_id !== "string" ||
    typeof value.agent_id !== "string" ||
    typeof value.thread_key !== "string" ||
    typeof value.scope !== "string" ||
    typeof value.release_id !== "string" ||
    typeof value.prompt_manifest_digest !== "string" ||
    !isPlainRecord(value.children) ||
    !Object.values(value.children).every((child) => isPlainRecord(child) && typeof child.prompt_manifest_digest === "string")
  ) {
    throw invalidResponse("execution binding");
  }
  if (value.workspace_id !== workspaceId || value.agent_id !== agentId) {
    throw bindingError("binding_mismatch", "the binding belongs to another workspace or agent", { binding_id: value.binding_id });
  }
  return value as unknown as ExecutionBinding;
}

function bindingBundle(binding: ExecutionBinding, artifacts: unknown): PromptBundle {
  if (!isPlainRecord(artifacts)) throw invalidResponse("binding: it carries no artifacts");
  const bundle = PromptBundle.fromOnlineResponse(artifacts, {
    expectedWorkspaceId: binding.workspace_id,
    expectedAgentId: binding.agent_id,
    expectedManifestDigest: binding.prompt_manifest_digest,
  });
  if (bundle.releaseId !== binding.release_id) {
    throw bindingError("binding_mismatch", "the artifacts belong to another release than the binding", { binding_id: binding.binding_id });
  }
  const digests = bundle.childManifestDigests;
  for (const childId of [...new Set([...Object.keys(binding.children), ...Object.keys(digests)])].sort()) {
    const pinned = Object.hasOwn(binding.children, childId) ? binding.children[childId]!.prompt_manifest_digest : undefined;
    const actual = Object.hasOwn(digests, childId) ? digests[childId] : undefined;
    if (actual !== pinned) {
      throw integrityError("manifest_digest_mismatch", "a child manifest differs from the binding pin", {
        child_agent_id: childId,
        expected: pinned ?? null,
        actual: actual ?? null,
      });
    }
  }
  return bundle;
}

export class PromptsResource {
  readonly #client: AgenomicClient;
  readonly #versions = new Map<string, ManagedPromptVersion>();

  constructor(client: AgenomicClient) {
    this.#client = client;
  }

  workspaceId(): Promise<string> {
    return workspaceOf(this.#client);
  }

  async get(ref: string | PromptReference): Promise<ManagedPromptVersion> {
    const parsed = toExecutionRef(ref);
    const workspaceId = await this.workspaceId();
    if (parsed.form === "alias") return this.#alias(workspaceId, parsed);
    return this.#version(workspaceId, parsed.form === "uri" ? versionRefOf(parsed, workspaceId) : parsed);
  }

  resolve(ref: string | PromptReference): Promise<ManagedPromptVersion> {
    return this.get(ref);
  }

  async resolveAgent(input: AgentSelectorInput): Promise<PromptBundle> {
    const query = new URLSearchParams(selector(input)).toString();
    const workspaceId = await this.workspaceId();
    const body = await callApi(this.#client, "GET", `/v1/agents/${segment(input.agentId)}/resolve?${query}`);
    if (body.agent_id !== input.agentId || !isPlainRecord(body.artifacts) || typeof body.prompt_manifest_digest !== "string") {
      throw invalidResponse(`resolution of agent ${input.agentId}`);
    }
    return PromptBundle.fromOnlineResponse(body.artifacts, {
      expectedWorkspaceId: workspaceId,
      expectedAgentId: input.agentId,
      expectedManifestDigest: body.prompt_manifest_digest,
    });
  }

  async #alias(workspaceId: string, ref: PromptAliasRef): Promise<ManagedPromptVersion> {
    const body = await callApi(this.#client, "POST", "/v1/prompts/resolve", { ref: formatPromptRef(ref) });
    const alias = body.alias;
    if (
      body.prompt_id !== ref.promptId ||
      !isPlainRecord(alias) ||
      alias.name !== ref.alias ||
      typeof alias.generation !== "number" ||
      !Number.isInteger(alias.generation) ||
      typeof body.version !== "number" ||
      !Number.isInteger(body.version) ||
      typeof body.content_digest !== "string"
    ) {
      throw invalidResponse(`resolution of ${formatPromptRef(ref)}`);
    }
    const version = await this.#version(workspaceId, { form: "version", promptId: ref.promptId, version: body.version });
    if (version.contentDigest !== body.content_digest) {
      throw integrityError("prompt_digest_mismatch", `${formatPromptRef(version.ref)} does not carry the digest the registry resolved`, {
        ref: formatPromptRef(version.ref),
        expected: body.content_digest,
        actual: version.contentDigest,
      });
    }
    return withResolvedFrom(version, { alias: ref.alias, generation: alias.generation });
  }

  async #version(workspaceId: string, ref: PromptVersionRef): Promise<ManagedPromptVersion> {
    const key = `${workspaceId}\u0000${formatPromptRef(ref)}`;
    const cached = this.#versions.get(key);
    if (cached) {
      this.#versions.delete(key);
      this.#versions.set(key, cached);
      return cached;
    }
    const body = await callApi(
      this.#client,
      "GET",
      `/v1/prompts/${segment(ref.promptId)}/versions/${ref.version}?include=fragments`,
    );
    const root = wireRecord(body.version, workspaceId);
    if (root.prompt_id !== ref.promptId || root.version !== ref.version) throw invalidResponse(`version ${formatPromptRef(ref)}`);
    const fragments = body.fragments ?? [];
    if (!Array.isArray(fragments)) throw invalidResponse("fragment closure");
    const records = new Map<string, PromptVersionRecord>([[`${root.prompt_id}:${root.version}`, root]]);
    for (const item of fragments) {
      const record = wireRecord(item, workspaceId);
      verifyRecord(record);
      records.set(`${record.prompt_id}:${record.version}`, record);
    }
    const version = buildPromptVersion(root, workspaceId, (promptId, number) => records.get(`${promptId}:${number}`));
    this.#versions.set(key, version);
    if (this.#versions.size > MAX_CACHED_VERSIONS) {
      const oldest = this.#versions.keys().next().value;
      if (oldest !== undefined) this.#versions.delete(oldest);
    }
    return version;
  }
}

export class BindingsResource {
  readonly #client: AgenomicClient;

  constructor(client: AgenomicClient) {
    this.#client = client;
  }

  async create(input: CreateExecutionBindingInput): Promise<CreatedBinding> {
    const chosen = selector(input);
    if (typeof input.threadKey !== "string" || input.threadKey === "") throw new Error("threadKey is required");
    if (input.scope !== "thread" && input.scope !== "execution") throw new Error("scope is thread or execution");
    const workspaceId = await workspaceOf(this.#client);
    const request: Record<string, unknown> = {
      thread_key: input.threadKey,
      scope: input.scope,
      selector: chosen,
      runtime_client: { sdk: SDK_METADATA.name, sdk_version: null, adapter: null, adapter_version: null },
      include: ["artifacts"],
    };
    if (input.expectManifestDigest !== undefined) request.expect = { prompt_manifest_digest: input.expectManifestDigest };
    const body = await callApi(this.#client, "POST", `/v1/agents/${segment(input.agentId)}/bindings`, request);
    if (typeof body.created !== "boolean") throw invalidResponse("binding: created flag");
    const binding = readBinding(body.binding, workspaceId, input.agentId);
    if (binding.thread_key !== input.threadKey || binding.scope !== input.scope) {
      throw bindingError("binding_mismatch", "the binding answers another thread key or scope", { binding_id: binding.binding_id });
    }
    return { binding, artifacts: bindingBundle(binding, body.artifacts), created: body.created };
  }

  async get(agentId: string, bindingId: string): Promise<LoadedBinding> {
    const workspaceId = await workspaceOf(this.#client);
    const body = await callApi(
      this.#client,
      "GET",
      `/v1/agents/${segment(agentId)}/bindings/${segment(bindingId)}?include=artifacts`,
    );
    const binding = readBinding(body.binding, workspaceId, agentId);
    if (binding.binding_id !== bindingId) throw bindingError("binding_mismatch", "the registry answered another binding");
    return { binding, artifacts: bindingBundle(binding, body.artifacts) };
  }
}
