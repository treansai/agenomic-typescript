// Wire mirrors of `docs/vault/openapi.yaml` (Agents Vault). Reads keep the
// server's snake_case; inputs elsewhere are camelCase. Fields the server sends
// as `null` are typed `| null` although the OpenAPI declares them non-nullable.
// No type here can carry a secret value: values only travel inbound, wrapped in
// `Sensitive`.

export type VaultUuid = string;
export type VaultTimestamp = string;

export type VaultProviderKind = "openbao" | "hashicorp_vault" | "aws_secrets_manager" | "azure_key_vault" | "gcp_secret_manager";
export type VaultProviderMode = "managed" | "customer_hosted" | "byov";
export type VaultProviderHealth = "unknown" | "healthy" | "degraded" | "unreachable";
export type VaultProviderState = "active" | "disabled" | "revoked";

export type VaultProviderAuth =
  | { method: "token"; env_var: string }
  | { method: "app_role"; role_id_env: string; secret_id_env: string; mount: string }
  | { method: "kubernetes"; role: string; mount: string; jwt_path: string };

export interface VaultProviderDescriptor {
  kind: VaultProviderKind;
  address: string;
  mount: string;
  namespace?: string;
  dynamic_mount?: string;
  auth: VaultProviderAuth;
}

export interface VaultProvider {
  id: VaultUuid;
  name: string;
  kind: VaultProviderKind;
  mode: VaultProviderMode;
  location: string;
  auth_method: string | null;
  capabilities: string[];
  health: VaultProviderHealth;
  health_checked_at: VaultTimestamp | null;
  state: VaultProviderState;
  created_at: VaultTimestamp;
}

export type VaultSecretType =
  | "api_key"
  | "database_credential"
  | "oauth_client_secret"
  | "certificate"
  | "ssh_key"
  | "hmac_secret"
  | "technical_account"
  | "web_session";
export type VaultSecretClassification = "internal" | "confidential" | "restricted";
export type VaultSecretState = "pending" | "active" | "revoked" | "destroyed";
export type VaultSecretVersionState = "pending" | "active" | "previous" | "revoked" | "destroyed";
export type VaultSecretProvenance = "import" | "rotation" | "dynamic" | "sync";

/** Secret metadata. There is no `value` field: values are write-only. */
export interface VaultSecret {
  id: VaultUuid;
  environment: string;
  name: string;
  secret_type: VaultSecretType;
  classification: VaultSecretClassification;
  owner_user_id: VaultUuid | null;
  provider_id: VaultUuid;
  provider_ref: string;
  state: VaultSecretState;
  current_version_id: VaultUuid | null;
  revision: number;
  created_at: VaultTimestamp;
  updated_at: VaultTimestamp;
}

export interface VaultSecretVersion {
  id: VaultUuid;
  provider_version: string;
  state: VaultSecretVersionState;
  provenance: VaultSecretProvenance;
  created_by: VaultUuid | null;
  created_at: VaultTimestamp;
  activated_at: VaultTimestamp | null;
  retired_at: VaultTimestamp | null;
}

export interface VaultSecretDetail {
  secret: VaultSecret;
  versions: VaultSecretVersion[];
}

export type VaultBindingAuth =
  | { kind: "bearer" }
  | { kind: "header"; name: string }
  | { kind: "basic"; username: string }
  | { kind: "query"; name: string };

export type VaultBindingBody = { mode: "none" } | { mode: "arguments" } | { mode: "fields"; names: string[] };

export interface VaultBindingContent {
  secret_id: VaultUuid;
  upstream_identity: string;
  tool_contract_ref: string;
  destination: { scheme: "https"; host: string; port: number; allow_private?: boolean };
  auth: VaultBindingAuth;
  request: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    path_params?: Array<{ name: string; pattern?: string; allowed?: string[] }>;
    query?: Record<string, string>;
    static_query?: Record<string, string>;
    body: VaultBindingBody;
    static_headers?: Record<string, string>;
    idempotency_header?: string;
  };
  effect: "read" | "write";
  response?: { max_bytes?: number; content_types?: string[]; fields?: string[] };
  usage_rules?: {
    read_only?: boolean;
    irreversible?: boolean;
    allowed_hours_utc?: [number, number];
    constraints?: Array<Record<string, unknown>>;
    sensitive_mandate?: string;
  };
}

export type VaultBindingState = "draft" | "active" | "suspended" | "revoked";
export type VaultBindingVersionState = "draft" | "in_review" | "approved" | "active" | "superseded" | "rejected" | "revoked";

export interface VaultBinding {
  id: VaultUuid;
  environment: string;
  name: string;
  agent_id: string;
  tool_name: string;
  state: VaultBindingState;
  active_version: number | null;
  created_by: VaultUuid | null;
  created_at: VaultTimestamp;
  updated_at: VaultTimestamp;
}

export interface VaultBindingVersion {
  version: number;
  state: VaultBindingVersionState;
  digest: string;
  content: VaultBindingContent;
  proposed_by: VaultUuid | null;
  approved_by: VaultUuid | null;
  approved_at: VaultTimestamp | null;
  created_at: VaultTimestamp;
}

export interface VaultBindingDetail {
  binding: VaultBinding;
  versions: VaultBindingVersion[];
}

export type VaultGrantState = "requested" | "approved" | "denied" | "revoked";

export interface VaultGrant {
  id: VaultUuid;
  binding_id: VaultUuid;
  binding_version: number;
  environment: string;
  agent_id: string;
  state: VaultGrantState;
  max_uses: number;
  uses: number;
  expires_at: VaultTimestamp;
  requested_by_user: VaultUuid | null;
  requested_by_identity: VaultUuid | null;
  requested_at: VaultTimestamp;
  decided_by: VaultUuid | null;
  decided_at: VaultTimestamp | null;
  reason: string;
  /** Present on a delegated grant; absent on servers that predate delegation. */
  parent_grant_id?: VaultUuid | null;
  /** 0 for a directly approved grant, parent depth + 1 for a delegated grant. */
  depth?: number;
}

/** A runtime identity. Never carries the token: it is returned once, on issue, wrapped in `RuntimeToken`. */
export interface VaultRuntimeIdentity {
  id: VaultUuid;
  environment: string;
  agent_id: string;
  label: string;
  declared_release: string | null;
  declared_genome_digest: string | null;
  assurance: string;
  expires_at: VaultTimestamp;
  revoked_at: VaultTimestamp | null;
  created_at: VaultTimestamp;
  last_used_at: VaultTimestamp | null;
}

export type VaultRevocationTarget = "binding" | "agent" | "session" | "workspace" | "provider" | "secret" | "grant";
export type VaultAgenomicRevocationState = "requested" | "blocked_locally" | "lifted";
export type VaultProviderRevocationState = "not_applicable" | "requested" | "pending" | "confirmed_upstream" | "failed" | "expires_only";

/** Agenomic's own block and the provider-side state are reported separately; neither implies the other. */
export interface VaultRevocation {
  id: VaultUuid;
  target_kind: VaultRevocationTarget | string;
  target_id: string;
  agenomic_state: VaultAgenomicRevocationState;
  provider_state: VaultProviderRevocationState;
  reason: string;
  requested_by: VaultUuid | null;
  requested_at: VaultTimestamp;
  provider_confirmed_at: VaultTimestamp | null;
  attempts: number;
  next_attempt_at?: VaultTimestamp | null;
  /** Machine-readable code of the last provider-side failure; never a provider message. */
  last_error?: string | null;
  lifted_at?: VaultTimestamp | null;
  lifted_by?: VaultUuid | null;
  lift_reason?: string | null;
}

export type VaultRotationState = "prepared" | "activated" | "retiring" | "completed" | "rolled_back" | "failed";
export type VaultRotationDirection = "forward" | "rollback";

export interface VaultRotationJob {
  id: VaultUuid;
  secret_id: VaultUuid;
  new_version_id: VaultUuid;
  old_version_id: VaultUuid | null;
  retire_version_id: VaultUuid | null;
  state: VaultRotationState;
  direction: VaultRotationDirection;
  overlap_seconds: number;
  retire_after: VaultTimestamp | null;
  attempts: number;
  next_attempt_at: VaultTimestamp | null;
  last_error: string | null;
  requested_by: VaultUuid | null;
  created_at: VaultTimestamp;
  updated_at: VaultTimestamp;
}

export type VaultExecutionState = "reserved" | "authorized" | "sent" | "succeeded" | "failed" | "refused" | "outcome_unknown";

export interface VaultExecutionSummary {
  action_id: VaultUuid;
  environment: string;
  agent_id: string;
  binding_id: VaultUuid;
  binding_version: number;
  secret_version_id: VaultUuid | null;
  grant_id: VaultUuid | null;
  tool: string;
  state: VaultExecutionState;
  run_id: VaultUuid | null;
  attempts: number;
  request_digest: string;
  result_digest: string | null;
  error_class: string | null;
  status_code: number | null;
  latency_ms: number | null;
  ledger_run_id: string;
  created_at: VaultTimestamp;
  completed_at: VaultTimestamp | null;
}

export type VaultReceiptPhase = "authorized" | "completed" | "outcome_unknown" | "refused";

/** A usage receipt. `body` is opaque: the SDK does not verify its signature (see docs/vault.md). */
export interface VaultReceipt {
  id: VaultUuid;
  action_id: VaultUuid;
  phase: VaultReceiptPhase;
  ledger_run_id: string;
  ledger_event_hash: string | null;
  body: Record<string, unknown>;
  created_at: VaultTimestamp;
}

export interface VaultStatus {
  installed: boolean;
  entitled: boolean;
  capability: { id: string; enabled: boolean; reason: string; required_plan?: string | null };
  permissions: string[];
  usage: { providers: number; secrets: number; bindings: number; runtime_identities: number };
  limitations: string[];
}

/** The `finished` shape of an execution read (runtime status, admin read, settlement). `result` is already filtered server side. */
export interface VaultExecutionStatus<T = unknown> {
  action_id: VaultUuid;
  state: VaultExecutionState;
  receipt_id: VaultUuid | null;
  result: T | null;
  status_code: number | null;
  error_class: string | null;
  limitations: string[];
}

export interface VaultExecuteInput {
  tool: string;
  /** Binding name, resolved server side in the identity's environment. */
  binding: string;
  /** Business parameters only. Anything wrapped in `Sensitive` is refused here. */
  arguments?: Record<string, unknown>;
  /** UUID. Generated when omitted and always returned; reuse it for every technical retry and to resume after an approval. */
  actionId?: string;
  deadlineMs?: number;
  /** Optional cross-check; must equal the authenticated identity. */
  environment?: string;
  /** Optional cross-check; must equal the authenticated identity. */
  agentId?: string;
}

export interface VaultExecuteResult<T = unknown> {
  actionId: string;
  status: "succeeded";
  /** The business result, already filtered server side. */
  result: T | null;
  receiptId: string | null;
  statusCode: number | null;
  limitations: string[];
  /** HTTP attempts the SDK made for this call, all with the same `actionId` (1 in replay). */
  attempts: number;
  source: "live" | "replay";
}
