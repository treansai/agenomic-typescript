import { isRecord } from "../utils";
import {
  VaultApprovalRequiredError,
  VaultAuthenticationError,
  VaultConflictError,
  VaultError,
  VaultExecutionFailedError,
  VaultGrantUnusableError,
  VaultNotEntitledError,
  VaultNotFoundError,
  VaultOutcomeUnknownError,
  VaultPermissionError,
  VaultPolicyDeniedError,
  VaultRateLimitedError,
  VaultRefusedError,
  VaultRevokedError,
  VaultValidationError,
  type VaultErrorDetails,
  type VaultGrantReason,
  type VaultLockReason,
} from "./errors";
import type { VaultExchange } from "./transport";
import type { VaultExecutionState, VaultExecuteResult, VaultExecutionStatus } from "./types";

export interface CallContext {
  method: string;
  path: string;
  actionId?: string;
}

interface ErrorFields {
  code?: string;
  message?: string;
  request_id?: string;
  capability?: string;
  reason?: string;
  required_plan?: string;
}

const LOCK_REASONS: Record<string, VaultLockReason> = {
  capability_not_entitled: "not_entitled",
  capability_not_in_edition: "not_in_edition",
  capability_disabled: "disabled",
};

const TRANSIENT_REFUSALS = new Set(["vault_backend_unavailable", "vault_destination_unavailable"]);
const GRANT_REASONS = /(not_found|not_approved|expired|exhausted)\s*$/;
const KNOWN_STATES: readonly VaultExecutionState[] = ["reserved", "authorized", "sent", "succeeded", "failed", "refused", "outcome_unknown"];

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function errorFields(body: unknown): ErrorFields {
  const error = isRecord(body) ? body.error : undefined;
  if (!isRecord(error)) return {};
  return {
    code: text(error.code),
    message: text(error.message),
    request_id: text(error.request_id),
    capability: text(error.capability),
    reason: text(error.reason),
    required_plan: text(error.required_plan),
  };
}

function invalidResponse(ctx: CallContext, status: number, what: string): VaultError {
  return new VaultError("invalid_response", `${ctx.method} ${ctx.path} returned ${what}; refusing to treat it as success`, status, {
    actionId: ctx.actionId,
  });
}

function byStatus(status: number, code: string, message: string, details: VaultErrorDetails): VaultError {
  switch (status) {
    case 400:
      return new VaultValidationError(message, { ...details, code: code || "validation_error" });
    case 401:
      return new VaultAuthenticationError(message, details);
    case 403:
      return new VaultPermissionError(code || "forbidden", message, details);
    case 404:
      return new VaultNotFoundError(message, details);
    case 409:
      return new VaultConflictError(code || "conflict", message, details);
    case 429:
      return new VaultRateLimitedError(message, undefined, details);
    default:
      return new VaultError(code || "http_error", message, status, { ...details, retryable: status >= 502 && status <= 504 });
  }
}

function byCode(code: string, exchange: VaultExchange, message: string, details: VaultErrorDetails, fields: ErrorFields): VaultError | undefined {
  const lock = LOCK_REASONS[code];
  if (lock) {
    return new VaultNotEntitledError(code, message, { ...details, reason: lock, capability: fields.capability, requiredPlan: fields.required_plan });
  }
  switch (code) {
    case "too_many_requests":
      return new VaultRateLimitedError(message, exchange.retryAfterMs, details);
    case "vault_outcome_unknown":
      return new VaultOutcomeUnknownError(details.actionId ?? "unknown", details);
    case "vault_grant_unusable":
      return new VaultGrantUnusableError(message, GRANT_REASONS.exec(message)?.[1] as VaultGrantReason | undefined, details);
    case "vault_revoked":
      return new VaultRevokedError(message, details);
    case "vault_permission_denied":
      return new VaultPermissionError(code, message, details);
    default:
      return code.startsWith("vault_")
        ? new VaultRefusedError(code, message, exchange.status, { ...details, retryable: TRANSIENT_REFUSALS.has(code) })
        : undefined;
  }
}

/** Maps any non-success exchange to a typed error. The server message is scrubbed; the body itself is never retained. */
export function errorFromExchange(exchange: VaultExchange, ctx: CallContext): VaultError {
  const fields = errorFields(exchange.body);
  const code = fields.code ?? "";
  const message = exchange.scrub(fields.message ?? `${ctx.method} ${ctx.path} returned ${exchange.status}`);
  const details: VaultErrorDetails = { actionId: ctx.actionId, requestId: fields.request_id ?? exchange.requestId };
  return byCode(code, exchange, message, details, fields) ?? byStatus(exchange.status, code, message, details);
}

function isSuccess(exchange: VaultExchange): boolean {
  return exchange.status >= 200 && exchange.status < 300;
}

/** The JSON body of a 2xx admin response, or a typed error. An empty or non-JSON 2xx body is `invalid_response`. */
export function acceptBody(exchange: VaultExchange, ctx: CallContext): unknown {
  if (!isSuccess(exchange)) throw errorFromExchange(exchange, ctx);
  if (exchange.body === undefined || exchange.body === null) throw invalidResponse(ctx, exchange.status, "a non JSON body");
  return exchange.body;
}

export function acceptList<T>(exchange: VaultExchange, ctx: CallContext): T[] {
  const body = acceptBody(exchange, ctx);
  if (!Array.isArray(body)) throw invalidResponse(ctx, exchange.status, "a body that is not a list");
  return body as T[];
}

export function acceptRecord<T>(exchange: VaultExchange, ctx: CallContext, requiredKey: string): T {
  const body = acceptBody(exchange, ctx);
  if (!isRecord(body) || !(requiredKey in body)) {
    throw invalidResponse(ctx, exchange.status, `a body without \`${requiredKey}\``);
  }
  return body as T;
}

function knownState(value: unknown): VaultExecutionState | undefined {
  return KNOWN_STATES.find((state) => state === value);
}

function finishedBody(exchange: VaultExchange, ctx: CallContext): Record<string, unknown> | undefined {
  const body = exchange.body;
  const sameAction = isRecord(body) && (ctx.actionId === undefined || body.action_id === ctx.actionId);
  return isSuccess(exchange) && isRecord(body) && body.status === "finished" && sameAction ? body : undefined;
}

/** A status read: every state is data, none is an error. */
export function acceptExecutionStatus<T>(exchange: VaultExchange, ctx: CallContext): VaultExecutionStatus<T> {
  if (!isSuccess(exchange)) throw errorFromExchange(exchange, ctx);
  const body = finishedBody(exchange, ctx);
  const state = knownState(body?.state);
  if (!body || !state || typeof body.action_id !== "string") throw invalidResponse(ctx, exchange.status, "an unrecognized execution body");
  return {
    action_id: body.action_id,
    state,
    receipt_id: textOrNull(body.receipt_id),
    result: (body.result ?? null) as T | null,
    status_code: numberOrNull(body.status_code),
    error_class: textOrNull(body.error_class),
    limitations: textList(body.limitations),
  };
}

function reasonCodes(errorClass: string | null): string[] {
  return errorClass ? errorClass.split(",").filter((code) => code.length > 0) : [];
}

function settledFailure(status: VaultExecutionStatus, actionId: string, requestId: string | undefined): VaultError {
  const base = { actionId, requestId };
  const detail = { ...base, receiptId: status.receipt_id, statusCode: status.status_code, errorClass: status.error_class };
  switch (status.state) {
    case "outcome_unknown":
      return new VaultOutcomeUnknownError(actionId, { ...base, receiptId: status.receipt_id, statusCode: status.status_code, limitations: status.limitations });
    case "failed":
      return new VaultExecutionFailedError(actionId, { ...detail, result: status.result });
    case "refused":
      return new VaultPolicyDeniedError(actionId, reasonCodes(status.error_class), undefined, base);
    default:
      return new VaultConflictError("execution_in_progress", `action ${actionId} is ${status.state}; read its status instead of resending`, base);
  }
}

function approvalRequired(exchange: VaultExchange, body: Record<string, unknown>, actionId: string): VaultError | undefined {
  const approvalId = text(body.approval_id);
  return exchange.status === 202 && approvalId ? new VaultApprovalRequiredError(actionId, approvalId, { requestId: exchange.requestId }) : undefined;
}

function denied(exchange: VaultExchange, body: Record<string, unknown>, actionId: string): VaultError | undefined {
  if (exchange.status !== 403) return undefined;
  const explanation = text(body.explanation);
  return new VaultPolicyDeniedError(actionId, textList(body.reason_codes), explanation && exchange.scrub(explanation), {
    requestId: exchange.requestId,
  });
}

function refused(exchange: VaultExchange, body: Record<string, unknown>, actionId: string): VaultError | undefined {
  const code = text(body.code);
  if (exchange.status !== 409 || !code) return undefined;
  const message = exchange.scrub(text(body.message) ?? `action ${actionId} was refused (${code})`);
  return new VaultRefusedError(code, message, 409, { actionId, requestId: exchange.requestId, retryable: TRANSIENT_REFUSALS.has(code) });
}

function outcomeError(exchange: VaultExchange, body: Record<string, unknown>, actionId: string): VaultError | undefined {
  switch (body.status) {
    case "approval_required":
      return approvalRequired(exchange, body, actionId);
    case "denied":
      return denied(exchange, body, actionId);
    case "refused":
      return refused(exchange, body, actionId);
    default:
      return undefined;
  }
}

/**
 * Interprets the answer to an execute call. Only a consistent `finished` /
 * `succeeded` body is a success; every other outcome throws a typed error, and
 * anything unrecognized, including a contradictory 2xx, fails closed.
 */
export function interpretExecution<T>(exchange: VaultExchange, ctx: CallContext & { actionId: string }): VaultExecuteResult<T> {
  const { actionId } = ctx;
  const finished = finishedBody(exchange, ctx);
  if (finished) return finishedResult<T>(exchange, ctx, actionId);
  const body = exchange.body;
  const outcome = isRecord(body) && body.action_id === actionId ? outcomeError(exchange, body, actionId) : undefined;
  if (outcome) throw outcome;
  if (isSuccess(exchange)) throw invalidResponse(ctx, exchange.status, "an unrecognized execution body");
  throw errorFromExchange(exchange, ctx);
}

function finishedResult<T>(exchange: VaultExchange, ctx: CallContext, actionId: string): VaultExecuteResult<T> {
  const status = acceptExecutionStatus<T>(exchange, ctx);
  if (status.state !== "succeeded") throw settledFailure(status, actionId, exchange.requestId);
  return {
    actionId,
    status: "succeeded",
    result: status.result,
    receiptId: status.receipt_id,
    statusCode: status.status_code,
    limitations: status.limitations,
    attempts: exchange.attempts,
    source: exchange.source,
  };
}
