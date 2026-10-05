import { randomUUID } from "node:crypto";

import { VaultValidationError } from "./errors";
import { acceptExecutionStatus, acceptList, acceptRecord, interpretExecution, type CallContext } from "./mapping";
import { assertNoSensitive, segment, type VaultExchange, type VaultRequest, type VaultTransport } from "./transport";
import type { VaultExecuteInput, VaultExecuteResult, VaultExecutionStatus, VaultGrant, VaultGrantState } from "./types";

export const EXECUTE_PATH = "/v1/vault/runtime/executions";
const GRANTS_PATH = "/v1/vault/runtime/grants";
const DEFAULT_DEADLINE_MS = 30_000;
const DEADLINE_MARGIN_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(message: string): VaultValidationError {
  return new VaultValidationError(message, { code: "invalid_input", status: 0 });
}

export function requireUuid(value: unknown, field: string): string {
  if (typeof value === "string" && UUID.test(value)) return value;
  throw invalid(`${field} must be a UUID`);
}

function requireText(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw invalid(`${field} must be a non-empty string`);
}

function requireArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    assertNoSensitive(value);
    return value as Record<string, unknown>;
  }
  throw invalid("arguments must be a JSON object");
}

function requireDeadline(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw invalid("deadlineMs must be a positive integer");
}

function executeRequest(input: VaultExecuteInput, actionId: string): VaultRequest {
  const deadlineMs = requireDeadline(input.deadlineMs);
  return {
    surface: "runtime",
    method: "POST",
    path: EXECUTE_PATH,
    idempotent: true,
    actionId,
    timeoutMs: (deadlineMs ?? DEFAULT_DEADLINE_MS) + DEADLINE_MARGIN_MS,
    body: {
      tool: requireText(input.tool, "tool"),
      binding: requireText(input.binding, "binding"),
      arguments: requireArguments(input.arguments),
      action_id: actionId,
      ...(input.environment !== undefined ? { environment: requireText(input.environment, "environment") } : {}),
      ...(input.agentId !== undefined ? { agent_id: requireText(input.agentId, "agentId") } : {}),
      ...(deadlineMs !== undefined ? { deadline_ms: deadlineMs } : {}),
    },
  };
}

export interface VaultRequestGrantInput {
  bindingId: string;
  /** Binding version; the server defaults to the active one. */
  version?: number;
  maxUses: number;
  ttlSeconds: number;
  reason: string;
}

export interface VaultDelegateGrantInput {
  delegateAgentId: string;
  maxUses: number;
  ttlSeconds: number;
  reason: string;
}

export interface VaultGrantFilter {
  bindingId?: string;
  state?: VaultGrantState;
}

export function grantRequestBody(input: VaultRequestGrantInput): Record<string, unknown> {
  return {
    binding_id: input.bindingId,
    ...(input.version !== undefined ? { version: input.version } : {}),
    max_uses: input.maxUses,
    ttl_seconds: input.ttlSeconds,
    reason: input.reason,
  };
}

function delegationBody(input: VaultDelegateGrantInput): Record<string, unknown> {
  return {
    delegate_agent_id: input.delegateAgentId,
    max_uses: input.maxUses,
    ttl_seconds: input.ttlSeconds,
    reason: input.reason,
  };
}

async function call(transport: VaultTransport, request: VaultRequest): Promise<{ exchange: VaultExchange; ctx: CallContext }> {
  const ctx: CallContext = { method: request.method, path: request.path, ...(request.actionId ? { actionId: request.actionId } : {}) };
  return { exchange: await transport.send(request), ctx };
}

/** The runtime-token view of grants: list, request (a human must approve), and delegate a narrower slice. */
export class VaultRuntimeGrantsResource {
  constructor(private readonly transport: VaultTransport) {}

  async list(filter: VaultGrantFilter = {}): Promise<VaultGrant[]> {
    const { exchange, ctx } = await call(this.transport, {
      surface: "runtime",
      method: "GET",
      path: GRANTS_PATH,
      query: { binding_id: filter.bindingId, state: filter.state },
      idempotent: true,
    });
    return acceptList<VaultGrant>(exchange, ctx);
  }

  async request(input: VaultRequestGrantInput): Promise<VaultGrant> {
    const { exchange, ctx } = await call(this.transport, { surface: "runtime", method: "POST", path: GRANTS_PATH, body: grantRequestBody(input) });
    return acceptRecord<VaultGrant>(exchange, ctx, "id");
  }

  /** Delegation never widens scope: the server bounds uses, expiry and agent by the parent grant. */
  async delegate(grantId: string, input: VaultDelegateGrantInput): Promise<VaultGrant> {
    const { exchange, ctx } = await call(this.transport, {
      surface: "runtime",
      method: "POST",
      path: `${GRANTS_PATH}/${segment(grantId)}/delegations`,
      body: delegationBody(input),
    });
    return acceptRecord<VaultGrant>(exchange, ctx, "id");
  }
}

/**
 * Runtime surface: executes authorized business actions with a runtime-identity
 * token. `execute` returns the filtered business result and a receipt id; the
 * credential used at the destination never reaches this process. Every
 * non-success outcome is a typed error, and an unknown outcome is never retried.
 */
export class VaultRuntimeResource {
  readonly grants: VaultRuntimeGrantsResource;

  constructor(private readonly transport: VaultTransport) {
    this.grants = new VaultRuntimeGrantsResource(transport);
  }

  get mode(): "live" | "replay" {
    return this.transport.mode;
  }

  async execute<T = unknown>(input: VaultExecuteInput): Promise<VaultExecuteResult<T>> {
    const actionId = input.actionId === undefined ? randomUUID() : requireUuid(input.actionId, "actionId");
    const request = executeRequest(input, actionId);
    const { exchange, ctx } = await call(this.transport, request);
    return interpretExecution<T>(exchange, { ...ctx, actionId });
  }

  /** Reads one of this identity's executions. Any state, including `outcome_unknown`, is returned as data. */
  async getExecution<T = unknown>(actionId: string): Promise<VaultExecutionStatus<T>> {
    const id = requireUuid(actionId, "actionId");
    const { exchange, ctx } = await call(this.transport, {
      surface: "runtime",
      method: "GET",
      path: `${EXECUTE_PATH}/${segment(id)}`,
      idempotent: true,
      actionId: id,
    });
    return acceptExecutionStatus<T>(exchange, ctx);
  }
}
