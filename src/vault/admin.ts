import type { AgenomicClient } from "../client";
import { VaultConfigurationError, VaultError } from "./errors";
import {
  acceptExecutionStatus,
  acceptList,
  acceptRecord,
  type CallContext,
} from "./mapping";
import { ReplayVaultTransport } from "./replay";
import {
  VaultRuntimeResource,
  grantRequestBody,
  requireUuid,
  type VaultGrantFilter,
  type VaultRequestGrantInput,
} from "./runtime";
import { RuntimeToken, assertSensitive, type Sensitive } from "./sensitive";
import { LiveVaultTransport, segment, type VaultClientOptions, type VaultExchange, type VaultTransport } from "./transport";
import type {
  VaultBinding,
  VaultBindingContent,
  VaultBindingDetail,
  VaultBindingState,
  VaultBindingVersion,
  VaultExecutionState,
  VaultExecutionStatus,
  VaultExecutionSummary,
  VaultGrant,
  VaultProvider,
  VaultProviderDescriptor,
  VaultProviderMode,
  VaultProviderState,
  VaultReceipt,
  VaultRevocation,
  VaultRevocationTarget,
  VaultRotationJob,
  VaultRuntimeIdentity,
  VaultSecret,
  VaultSecretClassification,
  VaultSecretDetail,
  VaultSecretState,
  VaultSecretType,
  VaultStatus,
} from "./types";

type Query = Record<string, string | number | undefined>;

interface AdminCall {
  method: "GET" | "POST";
  path: string;
  query?: Query;
  body?: unknown;
  allowSensitive?: boolean;
}

/** Shared request plumbing of the admin resources. Every response is validated before it is typed. */
class AdminApi {
  constructor(private readonly transport: VaultTransport) {}

  private async run(call: AdminCall, actionId?: string): Promise<{ exchange: VaultExchange; ctx: CallContext }> {
    const ctx: CallContext = { method: call.method, path: call.path, ...(actionId ? { actionId } : {}) };
    const exchange = await this.transport.send({
      surface: "admin",
      method: call.method,
      path: call.path,
      query: call.query,
      body: call.body,
      allowSensitive: call.allowSensitive,
      idempotent: call.method === "GET",
      actionId,
    });
    return { exchange, ctx };
  }

  async list<T>(path: string, query?: Query): Promise<T[]> {
    const { exchange, ctx } = await this.run({ method: "GET", path, query });
    return acceptList<T>(exchange, ctx);
  }

  async record<T>(call: AdminCall, requiredKey: string): Promise<T> {
    const { exchange, ctx } = await this.run(call);
    return acceptRecord<T>(exchange, ctx, requiredKey);
  }

  async execution<T>(call: AdminCall, actionId: string): Promise<VaultExecutionStatus<T>> {
    const { exchange, ctx } = await this.run(call, actionId);
    return acceptExecutionStatus<T>(exchange, ctx);
  }
}

const post = (path: string, body?: unknown): AdminCall => ({ method: "POST", path, body });
const get = (path: string, query?: Query): AdminCall => ({ method: "GET", path, query });

export interface VaultCreateProviderInput {
  name: string;
  mode: VaultProviderMode;
  descriptor: VaultProviderDescriptor;
}

export interface VaultSetProviderStateInput {
  state: VaultProviderState;
  reason: string;
}

export class VaultProvidersResource {
  constructor(private readonly api: AdminApi) {}

  list(): Promise<VaultProvider[]> {
    return this.api.list("/v1/vault/providers");
  }

  get(providerId: string): Promise<VaultProvider> {
    return this.api.record(get(`/v1/vault/providers/${segment(providerId)}`), "id");
  }

  create(input: VaultCreateProviderInput): Promise<VaultProvider> {
    return this.api.record(post("/v1/vault/providers", { name: input.name, mode: input.mode, descriptor: input.descriptor }), "id");
  }

  /** Probes a managed provider and returns it with its refreshed health. */
  checkHealth(providerId: string): Promise<VaultProvider> {
    return this.api.record(post(`/v1/vault/providers/${segment(providerId)}/health`), "id");
  }

  /** Safety operation: disabling or revoking a provider is never locked by the entitlement. */
  setState(providerId: string, input: VaultSetProviderStateInput): Promise<VaultProvider> {
    return this.api.record(post(`/v1/vault/providers/${segment(providerId)}/state`, { state: input.state, reason: input.reason }), "id");
  }
}

export interface VaultSecretFilter {
  environment?: string;
  providerId?: string;
  state?: VaultSecretState;
}

export interface VaultCreateSecretInput {
  environment: string;
  name: string;
  secretType: VaultSecretType;
  classification?: VaultSecretClassification;
  providerId: string;
  providerRef?: string;
  /** Write-only. Managed providers only; other providers register references. */
  value: Sensitive;
}

export interface VaultRegisterSecretReferenceInput {
  environment: string;
  name: string;
  secretType: VaultSecretType;
  classification?: VaultSecretClassification;
  providerId: string;
  providerRef: string;
  providerVersion: string;
}

export interface VaultAddSecretVersionInput {
  value: Sensitive;
}

export interface VaultRotateSecretInput {
  value: Sensitive;
  /** Rollback window in seconds (server bounds 120 to 86400, default 3600). */
  overlapSeconds?: number;
}

function secretBody(input: VaultCreateSecretInput): Record<string, unknown> {
  assertSensitive(input.value);
  return {
    environment: input.environment,
    name: input.name,
    secret_type: input.secretType,
    ...(input.classification !== undefined ? { classification: input.classification } : {}),
    provider_id: input.providerId,
    ...(input.providerRef !== undefined ? { provider_ref: input.providerRef } : {}),
    value: input.value,
  };
}

function referenceBody(input: VaultRegisterSecretReferenceInput): Record<string, unknown> {
  return {
    environment: input.environment,
    name: input.name,
    secret_type: input.secretType,
    ...(input.classification !== undefined ? { classification: input.classification } : {}),
    provider_id: input.providerId,
    provider_ref: input.providerRef,
    provider_version: input.providerVersion,
  };
}

function rotationBody(input: VaultRotateSecretInput): Record<string, unknown> {
  assertSensitive(input.value);
  return { value: input.value, ...(input.overlapSeconds !== undefined ? { overlap_seconds: input.overlapSeconds } : {}) };
}

/**
 * Secrets are write-only: `create`, `addVersion` and `rotate` take a
 * `Sensitive`, and nothing here returns a value. Reads are metadata.
 */
export class VaultSecretsResource {
  constructor(private readonly api: AdminApi) {}

  list(filter: VaultSecretFilter = {}): Promise<VaultSecret[]> {
    return this.api.list("/v1/vault/secrets", { environment: filter.environment, provider_id: filter.providerId, state: filter.state });
  }

  get(secretId: string): Promise<VaultSecretDetail> {
    return this.api.record(get(`/v1/vault/secrets/${segment(secretId)}`), "secret");
  }

  async create(input: VaultCreateSecretInput): Promise<VaultSecretDetail> {
    return this.api.record({ ...post("/v1/vault/secrets", secretBody(input)), allowSensitive: true }, "secret");
  }

  registerReference(input: VaultRegisterSecretReferenceInput): Promise<VaultSecretDetail> {
    return this.api.record(post("/v1/vault/secrets/references", referenceBody(input)), "secret");
  }

  async addVersion(secretId: string, input: VaultAddSecretVersionInput): Promise<VaultSecretDetail> {
    assertSensitive(input.value);
    return this.api.record({ ...post(`/v1/vault/secrets/${segment(secretId)}/versions`, { value: input.value }), allowSensitive: true }, "secret");
  }

  /** Starts a rotation job: the new value is written and verified by read-back, then kept pending until `rotations.activate`. */
  async rotate(secretId: string, input: VaultRotateSecretInput): Promise<VaultRotationJob> {
    return this.api.record({ ...post(`/v1/vault/secrets/${segment(secretId)}/rotations`, rotationBody(input)), allowSensitive: true }, "id");
  }

  /** Safety operation. Agenomic's block and the provider-side state are reported separately in the result. */
  revoke(secretId: string, input: { reason: string }): Promise<VaultRevocation> {
    return this.api.record(post(`/v1/vault/secrets/${segment(secretId)}/revoke`, { reason: input.reason }), "id");
  }
}

export class VaultRotationsResource {
  constructor(private readonly api: AdminApi) {}

  list(): Promise<VaultRotationJob[]> {
    return this.api.list("/v1/vault/rotations");
  }

  get(rotationId: string): Promise<VaultRotationJob> {
    return this.api.record(get(`/v1/vault/rotations/${segment(rotationId)}`), "id");
  }

  /** Activates the prepared version; the previous one stays available for the rollback window. */
  activate(rotationId: string): Promise<VaultRotationJob> {
    return this.api.record(post(`/v1/vault/rotations/${segment(rotationId)}/activate`), "id");
  }

  /** Safety operation: back to the previous version, retiring the new one. */
  rollback(rotationId: string, input: { reason: string }): Promise<VaultRotationJob> {
    return this.api.record(post(`/v1/vault/rotations/${segment(rotationId)}/rollback`, { reason: input.reason }), "id");
  }
}

export interface VaultBindingFilter {
  environment?: string;
  agentId?: string;
  state?: VaultBindingState;
}

export interface VaultCreateBindingInput {
  environment: string;
  name: string;
  agentId: string;
  toolName: string;
  /** Wire shape of the OpenAPI `BindingContent`: destination, auth placement, request template and usage rules are fixed server side. */
  content: VaultBindingContent;
}

export class VaultBindingsResource {
  constructor(private readonly api: AdminApi) {}

  list(filter: VaultBindingFilter = {}): Promise<VaultBinding[]> {
    return this.api.list("/v1/vault/bindings", { environment: filter.environment, agent_id: filter.agentId, state: filter.state });
  }

  get(bindingId: string): Promise<VaultBindingDetail> {
    return this.api.record(get(`/v1/vault/bindings/${segment(bindingId)}`), "binding");
  }

  /** Creates the binding with its first draft version. */
  create(input: VaultCreateBindingInput): Promise<VaultBindingDetail> {
    const body = { environment: input.environment, name: input.name, agent_id: input.agentId, tool_name: input.toolName, content: input.content };
    return this.api.record(post("/v1/vault/bindings", body), "binding");
  }

  proposeVersion(bindingId: string, input: { content: VaultBindingContent }): Promise<VaultBindingVersion> {
    return this.api.record(post(`/v1/vault/bindings/${segment(bindingId)}/versions`, { content: input.content }), "version");
  }

  submit(bindingId: string, version: number): Promise<VaultBindingVersion> {
    return this.api.record(post(`/v1/vault/bindings/${segment(bindingId)}/versions/${version}/submit`), "version");
  }

  /** Approval is a human decision with `grant.approve` and never the proposer; the server enforces it. */
  approve(bindingId: string, version: number): Promise<VaultBindingVersion> {
    return this.decide(bindingId, version, true);
  }

  reject(bindingId: string, version: number): Promise<VaultBindingVersion> {
    return this.decide(bindingId, version, false);
  }

  activate(bindingId: string, version: number): Promise<VaultBindingDetail> {
    return this.api.record(post(`/v1/vault/bindings/${segment(bindingId)}/versions/${version}/activate`), "binding");
  }

  /** Safety operation. */
  revoke(bindingId: string, input: { reason: string }): Promise<VaultRevocation> {
    return this.api.record(post(`/v1/vault/bindings/${segment(bindingId)}/revoke`, { reason: input.reason }), "id");
  }

  private decide(bindingId: string, version: number, approve: boolean): Promise<VaultBindingVersion> {
    return this.api.record(post(`/v1/vault/bindings/${segment(bindingId)}/versions/${version}/decide`, { approve }), "version");
  }
}

export interface VaultAdminGrantFilter extends VaultGrantFilter {
  agentId?: string;
}

export class VaultGrantsResource {
  constructor(private readonly api: AdminApi) {}

  list(filter: VaultAdminGrantFilter = {}): Promise<VaultGrant[]> {
    return this.api.list("/v1/vault/grants", { binding_id: filter.bindingId, agent_id: filter.agentId, state: filter.state });
  }

  /** Requests a grant on behalf of an agent. A grant is bounded to one binding version, a use count and an expiry. */
  request(input: VaultRequestGrantInput): Promise<VaultGrant> {
    return this.api.record(post("/v1/vault/grants", grantRequestBody(input)), "id");
  }

  /** `grant.approve` with a session; the requester can never approve their own request. */
  approve(grantId: string): Promise<VaultGrant> {
    return this.decide(grantId, true);
  }

  deny(grantId: string): Promise<VaultGrant> {
    return this.decide(grantId, false);
  }

  /** Safety operation. */
  revoke(grantId: string, input: { reason: string }): Promise<VaultRevocation> {
    return this.api.record(post(`/v1/vault/grants/${segment(grantId)}/revoke`, { reason: input.reason }), "id");
  }

  private decide(grantId: string, approve: boolean): Promise<VaultGrant> {
    return this.api.record(post(`/v1/vault/grants/${segment(grantId)}/decide`, { approve }), "id");
  }
}

export interface VaultIssueIdentityInput {
  environment: string;
  agentId: string;
  label: string;
  /** Token lifetime; the server defaults to one hour and bounds it. */
  ttlSeconds?: number;
  declaredRelease?: string;
  declaredGenomeDigest?: string;
}

/** The identity and its token. The token is returned once and is masked everywhere; see `RuntimeToken`. */
export interface VaultIssuedIdentity {
  identity: VaultRuntimeIdentity;
  token: RuntimeToken;
}

function issueBody(input: VaultIssueIdentityInput): Record<string, unknown> {
  return {
    environment: input.environment,
    agent_id: input.agentId,
    label: input.label,
    ...(input.ttlSeconds !== undefined ? { ttl_seconds: input.ttlSeconds } : {}),
    ...(input.declaredRelease !== undefined ? { declared_release: input.declaredRelease } : {}),
    ...(input.declaredGenomeDigest !== undefined ? { declared_genome_digest: input.declaredGenomeDigest } : {}),
  };
}

function wrapIssued(body: { identity: VaultRuntimeIdentity; token: unknown }): VaultIssuedIdentity {
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new VaultError("invalid_response", "the issue response carried no runtime token", 0);
  }
  const token = new RuntimeToken(body.token);
  body.token = undefined;
  return { identity: body.identity, token };
}

export class VaultRuntimeIdentitiesResource {
  constructor(private readonly api: AdminApi) {}

  list(): Promise<VaultRuntimeIdentity[]> {
    return this.api.list("/v1/vault/runtime-identities");
  }

  /** `binding.manage`. The token is shown once; keep it only in the secret store of the agent runtime. */
  async issue(input: VaultIssueIdentityInput): Promise<VaultIssuedIdentity> {
    const body = await this.api.record<{ identity: VaultRuntimeIdentity; token: unknown }>(post("/v1/vault/runtime-identities", issueBody(input)), "identity");
    return wrapIssued(body);
  }

  /** Safety operation. */
  revoke(identityId: string, input: { reason: string }): Promise<VaultRuntimeIdentity> {
    return this.api.record(post(`/v1/vault/runtime-identities/${segment(identityId)}/revoke`, { reason: input.reason }), "id");
  }
}

export class VaultRevocationsResource {
  constructor(private readonly api: AdminApi) {}

  list(): Promise<VaultRevocation[]> {
    return this.api.list("/v1/vault/revocations");
  }

  /** Re-runs the provider-side step of a revocation now. Safety operation. */
  retry(revocationId: string): Promise<VaultRevocation> {
    return this.api.record(post(`/v1/vault/revocations/${segment(revocationId)}/retry`), "id");
  }

  /** Lifts a kill switch on a workspace, agent, provider or binding. Revoked grants, sessions and secrets cannot be lifted. */
  lift(revocationId: string, input: { reason: string }): Promise<VaultRevocation> {
    return this.api.record(post(`/v1/vault/revocations/${segment(revocationId)}/lift`, { reason: input.reason }), "id");
  }
}

export interface VaultExecutionFilter {
  state?: VaultExecutionState;
  limit?: number;
}

export interface VaultResolveExecutionInput {
  /** What the operator established at the destination. */
  resolution: "applied" | "not_applied";
  note: string;
}

export class VaultExecutionsResource {
  constructor(private readonly api: AdminApi) {}

  list(filter: VaultExecutionFilter = {}): Promise<VaultExecutionSummary[]> {
    return this.api.list("/v1/vault/executions", { state: filter.state, limit: filter.limit });
  }

  /** One execution, with its filtered business result. Any state is returned as data. */
  async get<T = unknown>(actionId: string): Promise<VaultExecutionStatus<T>> {
    const id = requireUuid(actionId, "actionId");
    return this.api.execution<T>(get(`/v1/vault/executions/${segment(id)}`), id);
  }

  /**
   * Settles an `outcome_unknown` execution after a human verified the
   * destination (`execution.reconcile`). It records what was established and
   * never re-sends the action.
   */
  async resolve<T = unknown>(actionId: string, input: VaultResolveExecutionInput): Promise<VaultExecutionStatus<T>> {
    const id = requireUuid(actionId, "actionId");
    return this.api.execution<T>(post(`/v1/vault/executions/${segment(id)}/resolve`, { resolution: input.resolution, note: input.note }), id);
  }
}

export class VaultReceiptsResource {
  constructor(private readonly api: AdminApi) {}

  list(filter: { actionId?: string; limit?: number } = {}): Promise<VaultReceipt[]> {
    return this.api.list("/v1/vault/receipts", { action_id: filter.actionId, limit: filter.limit });
  }
}

export interface VaultKillSwitchInput {
  targetKind: VaultRevocationTarget;
  targetId: string;
  reason: string;
}

function createTransport(client: AgenomicClient, options: VaultClientOptions): VaultTransport {
  if (!options.replay) return new LiveVaultTransport(client, options);
  if (options.runtimeToken !== undefined) {
    throw new VaultConfigurationError("replay_with_credentials", "replay mode cannot be combined with a runtimeToken: a replay client holds no credential to go live with");
  }
  return new ReplayVaultTransport(options.replay);
}

/**
 * The `client.vault` namespace: Agents Vault metadata and administration with
 * the client API key, plus `runtime` for the runtime-token surface. Business
 * operations need the Agents Vault add-on; the server decides and answers
 * `VaultNotEntitledError`. Safety operations, metadata and evidence reads
 * stay available when locked. Nothing here can return a secret value.
 */
export class VaultResource {
  readonly providers: VaultProvidersResource;
  readonly secrets: VaultSecretsResource;
  readonly rotations: VaultRotationsResource;
  readonly bindings: VaultBindingsResource;
  readonly grants: VaultGrantsResource;
  readonly runtimeIdentities: VaultRuntimeIdentitiesResource;
  readonly revocations: VaultRevocationsResource;
  readonly executions: VaultExecutionsResource;
  readonly receipts: VaultReceiptsResource;
  readonly runtime: VaultRuntimeResource;
  private readonly api: AdminApi;

  constructor(client: AgenomicClient, options: VaultClientOptions = {}) {
    const transport = createTransport(client, options);
    this.api = new AdminApi(transport);
    this.providers = new VaultProvidersResource(this.api);
    this.secrets = new VaultSecretsResource(this.api);
    this.rotations = new VaultRotationsResource(this.api);
    this.bindings = new VaultBindingsResource(this.api);
    this.grants = new VaultGrantsResource(this.api);
    this.runtimeIdentities = new VaultRuntimeIdentitiesResource(this.api);
    this.revocations = new VaultRevocationsResource(this.api);
    this.executions = new VaultExecutionsResource(this.api);
    this.receipts = new VaultReceiptsResource(this.api);
    this.runtime = new VaultRuntimeResource(transport);
  }

  get mode(): "live" | "replay" {
    return this.runtime.mode;
  }

  /** Installation and entitlement as the server reports them. Usable when locked; the SDK never derives entitlement itself. */
  status(): Promise<VaultStatus> {
    return this.api.record(get("/v1/vault/status"), "installed");
  }

  /** Safety operation: blocks a binding, agent, session, workspace, provider, secret or grant at once. */
  killSwitch(input: VaultKillSwitchInput): Promise<VaultRevocation> {
    return this.api.record(post("/v1/vault/kill-switch", { target_kind: input.targetKind, target_id: input.targetId, reason: input.reason }), "id");
  }
}

