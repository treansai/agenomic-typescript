import { ToolExecutionError } from "../tools";

export interface VaultErrorDetails {
  actionId?: string;
  requestId?: string;
  retryable?: boolean;
}

/**
 * Base class of every error raised by the Agents Vault surface. `code` is the
 * server error code (or an SDK code for client-side refusals); `retryable` is
 * true only when resending the same request with the same `actionId` is a safe
 * technical retry. No subclass carries a request body or a secret value.
 */
export class VaultError extends ToolExecutionError {
  readonly actionId?: string;
  readonly requestId?: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, status: number, details: VaultErrorDetails = {}) {
    super(code, message, status);
    this.name = "VaultError";
    this.actionId = details.actionId;
    this.requestId = details.requestId;
    this.retryable = details.retryable ?? false;
  }
}

export type VaultLockReason = "not_entitled" | "not_in_edition" | "disabled";

/**
 * The module is locked for this workspace: the Agents Vault add-on is not
 * entitled, the edition does not include it, or it is switched off. The SDK
 * only relays the server's answer; `reason` and `requiredPlan` let a UI show an
 * upgrade hint. Safety operations (revocation, kill switch, metadata and
 * evidence reads) are never locked.
 */
export class VaultNotEntitledError extends VaultError {
  readonly locked = true as const;
  readonly reason: VaultLockReason;
  readonly capability?: string;
  readonly requiredPlan?: string;

  constructor(
    code: string,
    message: string,
    details: VaultErrorDetails & { reason: VaultLockReason; capability?: string; requiredPlan?: string },
  ) {
    super(code, message, 403, details);
    this.name = "VaultNotEntitledError";
    this.reason = details.reason;
    this.capability = details.capability;
    this.requiredPlan = details.requiredPlan;
  }
}

export function isVaultLocked(error: unknown): error is VaultNotEntitledError {
  return error instanceof VaultNotEntitledError;
}

/** A policy requires a human decision (HTTP 202). Decide the approval, then resend the same `actionId`. */
export class VaultApprovalRequiredError extends VaultError {
  readonly pending = true as const;
  readonly approvalId: string;

  constructor(actionId: string, approvalId: string, details: VaultErrorDetails = {}) {
    super("approval_required", `action ${actionId} awaits approval ${approvalId}`, 202, { ...details, actionId });
    this.name = "VaultApprovalRequiredError";
    this.approvalId = approvalId;
  }
}

/** Policy refused the action (HTTP 403 `denied`, or a settled `refused` execution); nothing was sent. */
export class VaultPolicyDeniedError extends VaultError {
  readonly reasonCodes: string[];
  readonly explanation?: string;

  constructor(actionId: string, reasonCodes: string[], explanation?: string, details: VaultErrorDetails = {}) {
    const reasons = reasonCodes.join(",");
    super("policy_denied", explanation ?? `action ${actionId} denied by policy${reasons ? ` (${reasons})` : ""}`, 403, {
      ...details,
      actionId,
    });
    this.name = "VaultPolicyDeniedError";
    this.reasonCodes = reasonCodes;
    this.explanation = explanation;
  }
}

export type VaultGrantReason = "not_found" | "not_approved" | "expired" | "exhausted";

/** No usable grant: missing, not approved, expired or out of uses (`vault_grant_unusable`). */
export class VaultGrantUnusableError extends VaultError {
  readonly reason?: VaultGrantReason;

  constructor(message: string, reason: VaultGrantReason | undefined, details: VaultErrorDetails = {}) {
    super("vault_grant_unusable", message, 409, details);
    this.name = "VaultGrantUnusableError";
    this.reason = reason;
  }
}

/** The binding (revoked or suspended), its secret, its provider or the identity is revoked (`vault_revoked`). */
export class VaultRevokedError extends VaultError {
  constructor(message: string, details: VaultErrorDetails = {}) {
    super("vault_revoked", message, 409, details);
    this.name = "VaultRevokedError";
  }
}

export interface VaultOutcomeDetails extends VaultErrorDetails {
  receiptId?: string | null;
  statusCode?: number | null;
  limitations?: string[];
}

/**
 * The request may have reached the destination and its effect is unknown. The
 * SDK never retries it and neither should the caller blindly: reconcile with
 * the destination or an operator, then decide. `retryable` is always false.
 */
export class VaultOutcomeUnknownError extends VaultError {
  readonly receiptId?: string | null;
  readonly statusCode?: number | null;
  readonly limitations: string[];

  constructor(actionId: string, details: VaultOutcomeDetails = {}) {
    super(
      "vault_outcome_unknown",
      `the outcome of action ${actionId} is unknown; it was not retried and must be reconciled before it is sent again`,
      409,
      { ...details, actionId, retryable: false },
    );
    this.name = "VaultOutcomeUnknownError";
    this.receiptId = details.receiptId;
    this.statusCode = details.statusCode;
    this.limitations = details.limitations ?? [];
  }
}

export class VaultRateLimitedError extends VaultError {
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs: number | undefined, details: VaultErrorDetails = {}) {
    super("too_many_requests", message, 429, { ...details, retryable: true });
    this.name = "VaultRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Invalid request (HTTP 400), or a client-side refusal before anything was sent (`status` 0). */
export class VaultValidationError extends VaultError {
  constructor(message: string, options: { code?: string; status?: number } & VaultErrorDetails = {}) {
    super(options.code ?? "validation_error", message, options.status ?? 400, options);
    this.name = "VaultValidationError";
  }
}

export class VaultAuthenticationError extends VaultError {
  constructor(message: string, details: VaultErrorDetails = {}) {
    super("unauthorized", message, 401, details);
    this.name = "VaultAuthenticationError";
  }
}

/** The caller lacks a vault permission (`vault_permission_denied` or `forbidden`). */
export class VaultPermissionError extends VaultError {
  constructor(code: string, message: string, details: VaultErrorDetails = {}) {
    super(code, message, 403, details);
    this.name = "VaultPermissionError";
  }
}

export class VaultNotFoundError extends VaultError {
  constructor(message: string, details: VaultErrorDetails = {}) {
    super("not_found", message, 404, details);
    this.name = "VaultNotFoundError";
  }
}

/** HTTP 409 `conflict`, for example an `actionId` reused for a different request or an execution still in flight. */
export class VaultConflictError extends VaultError {
  constructor(code: string, message: string, details: VaultErrorDetails = {}) {
    super(code, message, 409, details);
    this.name = "VaultConflictError";
  }
}

/** The vault refused with a `vault_*` code that has no dedicated class (backend, destination, authorization, filter, fail-closed). */
export class VaultRefusedError extends VaultError {
  constructor(code: string, message: string, status: number, details: VaultErrorDetails = {}) {
    super(code, message, status, details);
    this.name = "VaultRefusedError";
  }
}

export interface VaultFailureDetails extends VaultErrorDetails {
  receiptId?: string | null;
  statusCode?: number | null;
  errorClass?: string | null;
  result?: unknown;
}

/** The destination answered with an error (execution state `failed`). `result` is the server-filtered body. */
export class VaultExecutionFailedError extends VaultError {
  readonly receiptId?: string | null;
  readonly statusCode?: number | null;
  readonly errorClass?: string | null;
  readonly result?: unknown;

  constructor(actionId: string, details: VaultFailureDetails = {}) {
    const class_ = details.errorClass ? ` (${details.errorClass})` : "";
    super("execution_failed", `action ${actionId} failed at the destination${class_}`, 200, { ...details, actionId });
    this.name = "VaultExecutionFailedError";
    this.receiptId = details.receiptId;
    this.statusCode = details.statusCode;
    this.errorClass = details.errorClass;
    this.result = details.result;
  }
}

/**
 * No response was received. When `maybeSent` is true the server may still have
 * processed the request: read the execution with the same `actionId` or resend
 * it (the server answers idempotently per `actionId`).
 */
export class VaultTransportError extends VaultError {
  readonly timedOut: boolean;
  readonly maybeSent: boolean;

  constructor(message: string, options: { timedOut?: boolean; maybeSent?: boolean } & VaultErrorDetails = {}) {
    super(options.timedOut ? "timeout" : "transport_error", message, 0, options);
    this.name = "VaultTransportError";
    this.timedOut = options.timedOut ?? false;
    this.maybeSent = options.maybeSent ?? true;
  }
}

/** The client is not configured for the call (`cloud_required`, `api_key_required`, `runtime_token_required`, invalid replay set). */
export class VaultConfigurationError extends VaultError {
  constructor(code: string, message: string) {
    super(code, message, 0);
    this.name = "VaultConfigurationError";
  }
}

/** Replay mode has no fixture for this call. It is an error by design: replay never falls back to a live call. */
export class VaultReplayFixtureMissingError extends VaultError {
  constructor(message: string, details: VaultErrorDetails = {}) {
    super("replay_fixture_missing", message, 0, details);
    this.name = "VaultReplayFixtureMissingError";
  }
}

/** Replay mode cannot answer this operation at all (admin and grant calls); it is never sent live. */
export class VaultReplayUnavailableError extends VaultError {
  constructor(operation: string) {
    super("replay_unavailable", `${operation} is not available in replay mode and is never sent live`, 0);
    this.name = "VaultReplayUnavailableError";
  }
}
