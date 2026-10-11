import { z } from "zod";

import { hashValue, stableStringify } from "../utils";
import { VaultConfigurationError, VaultReplayFixtureMissingError, VaultReplayUnavailableError } from "./errors";
import type { VaultExchange, VaultRequest, VaultTransport } from "./transport";

const optionalText = z.string().min(1).optional();
const optionalStatus = z.number().int().optional();

const outcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("succeeded"), result: z.unknown().optional(), receiptId: optionalText, statusCode: optionalStatus }).strict(),
  z
    .object({ kind: z.literal("failed"), result: z.unknown().optional(), receiptId: optionalText, statusCode: optionalStatus, errorClass: optionalText })
    .strict(),
  z.object({ kind: z.literal("outcome_unknown"), receiptId: optionalText }).strict(),
  z.object({ kind: z.literal("approval_required"), approvalId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("denied"), reasonCodes: z.array(z.string()).default([]), explanation: optionalText }).strict(),
  z.object({ kind: z.literal("refused"), code: z.string().min(1), message: optionalText }).strict(),
  z
    .object({
      kind: z.literal("error"),
      status: z.number().int().min(400).max(599),
      code: z.string().min(1),
      message: optionalText,
      capability: optionalText,
      reason: optionalText,
      requiredPlan: optionalText,
    })
    .strict(),
]);

const fixtureSchema = z
  .object({
    tool: z.string().min(1),
    binding: z.string().min(1),
    arguments: z.record(z.unknown()).optional(),
    outcome: outcomeSchema.optional(),
    outcomes: z.array(outcomeSchema).min(1).optional(),
  })
  .strict()
  .refine((fixture) => (fixture.outcome === undefined) !== (fixture.outcomes === undefined), {
    message: "provide exactly one of outcome or outcomes",
  });

/**
 * What a replayed call answers. Each kind produces the same wire answer the
 * live server gives, so replay goes through the same error mapping as a live
 * call. `denied` settles into a `refused` execution on resend, like the server.
 */
export type VaultReplayOutcome = z.input<typeof outcomeSchema>;

type ParsedOutcome = z.infer<typeof outcomeSchema>;

export interface VaultReplayFixture {
  tool: string;
  binding: string;
  /** When set, the fixture matches only these exact arguments; otherwise any arguments. Exact matches win. */
  arguments?: Record<string, unknown>;
  outcome?: VaultReplayOutcome;
  /** Answers in order per `actionId`; only `approval_required` and `error` outcomes advance, so a later resend can succeed. */
  outcomes?: VaultReplayOutcome[];
}

export interface VaultReplayOptions {
  fixtures: VaultReplayFixture[];
}

interface NormalizedFixture {
  tool: string;
  binding: string;
  arguments?: Record<string, unknown>;
  outcomes: ParsedOutcome[];
}

/** Validates a fixture set (for example one read from JSON). Throws `VaultConfigurationError` naming the offending path, never a value. */
export function parseVaultReplayFixtures(input: unknown): NormalizedFixture[] {
  const parsed = z.array(fixtureSchema).safeParse(input);
  if (!parsed.success) {
    const where = parsed.error.issues.map((issue) => `${issue.path.join(".") || "fixtures"}: ${issue.message}`).join("; ");
    throw new VaultConfigurationError("replay_fixtures_invalid", `invalid replay fixtures (${where})`);
  }
  return parsed.data.map((fixture) => ({
    tool: fixture.tool,
    binding: fixture.binding,
    ...(fixture.arguments ? { arguments: fixture.arguments } : {}),
    outcomes: fixture.outcomes ?? (fixture.outcome ? [fixture.outcome] : []),
  }));
}

interface ReplayedAction {
  digest: string;
  outcomes: ParsedOutcome[];
  cursor: number;
  settled?: VaultExchange;
}

interface ExecuteBody {
  tool: string;
  binding: string;
  arguments?: Record<string, unknown>;
  action_id: string;
}

const EXECUTE_PATH = "/v1/vault/runtime/executions";
const NOT_SCRUBBED = (text: string): string => text;

function reply(status: number, body: unknown): VaultExchange {
  return { status, body, attempts: 1, source: "replay", scrub: NOT_SCRUBBED };
}

function finished(actionId: string, state: string, fields: Record<string, unknown> = {}): VaultExchange {
  return reply(200, {
    status: "finished",
    action_id: actionId,
    state,
    receipt_id: null,
    result: null,
    status_code: null,
    error_class: null,
    limitations: [],
    ...fields,
  });
}

function errorReply(outcome: Extract<ParsedOutcome, { kind: "error" }>): VaultExchange {
  return reply(outcome.status, {
    error: {
      code: outcome.code,
      message: outcome.message ?? outcome.code,
      ...(outcome.capability ? { capability: outcome.capability } : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.requiredPlan ? { required_plan: outcome.requiredPlan } : {}),
    },
  });
}

interface Step {
  answer: VaultExchange;
  settled?: VaultExchange;
}

function stepFor(actionId: string, outcome: ParsedOutcome): Step {
  switch (outcome.kind) {
    case "succeeded": {
      const answer = finished(actionId, "succeeded", { receipt_id: outcome.receiptId ?? null, result: outcome.result ?? null, status_code: outcome.statusCode ?? null });
      return { answer, settled: answer };
    }
    case "failed": {
      const errorClass = outcome.errorClass ?? (outcome.statusCode ? `http_${outcome.statusCode}` : "failed");
      const answer = finished(actionId, "failed", { receipt_id: outcome.receiptId ?? null, result: outcome.result ?? null, status_code: outcome.statusCode ?? null, error_class: errorClass });
      return { answer, settled: answer };
    }
    case "outcome_unknown": {
      const limitations = ["The request was sent and its effect is unknown. It will not be repeated automatically; reconcile it before retrying."];
      const answer = finished(actionId, "outcome_unknown", { receipt_id: outcome.receiptId ?? null, error_class: "outcome_unknown", limitations });
      return { answer, settled: answer };
    }
    case "approval_required":
      return { answer: reply(202, { status: "approval_required", action_id: actionId, approval_id: outcome.approvalId }) };
    case "denied":
      return {
        answer: reply(403, { status: "denied", action_id: actionId, reason_codes: outcome.reasonCodes, ...(outcome.explanation ? { explanation: outcome.explanation } : {}) }),
        settled: finished(actionId, "refused", { error_class: outcome.reasonCodes.join(",") || null }),
      };
    case "refused":
      return { answer: reply(409, { status: "refused", action_id: actionId, code: outcome.code, message: outcome.message ?? outcome.code }) };
    case "error":
      return { answer: errorReply(outcome) };
  }
}

function matchFixture(fixtures: NormalizedFixture[], body: ExecuteBody): NormalizedFixture | undefined {
  const candidates = fixtures.filter((fixture) => fixture.tool === body.tool && fixture.binding === body.binding);
  const key = stableStringify(body.arguments ?? {});
  return candidates.find((fixture) => fixture.arguments !== undefined && stableStringify(fixture.arguments) === key) ?? candidates.find((fixture) => fixture.arguments === undefined);
}

function digestOf(body: ExecuteBody): string {
  return hashValue({ tool: body.tool, binding: body.binding, arguments: body.arguments ?? {} });
}

/**
 * Answers vault runtime calls from fixtures and nothing else: it holds no
 * credential, has no `fetch`, and a call without a fixture is a
 * `VaultReplayFixtureMissingError`. It mirrors the server's idempotency per
 * `actionId`: a settled action answers the same on resend, and reusing an
 * `actionId` for a different request is a conflict.
 */
export class ReplayVaultTransport implements VaultTransport {
  readonly mode = "replay" as const;
  readonly #fixtures: NormalizedFixture[];
  readonly #actions = new Map<string, ReplayedAction>();

  constructor(options: VaultReplayOptions) {
    this.#fixtures = parseVaultReplayFixtures(options.fixtures);
  }

  async send(request: VaultRequest): Promise<VaultExchange> {
    if (request.surface === "runtime" && request.method === "POST" && request.path === EXECUTE_PATH) {
      return this.execute(request.body as ExecuteBody);
    }
    if (request.surface === "runtime" && request.method === "GET" && request.path.startsWith(`${EXECUTE_PATH}/`)) {
      return this.status(decodeURIComponent(request.path.slice(EXECUTE_PATH.length + 1)));
    }
    throw new VaultReplayUnavailableError(`${request.method} ${request.path}`);
  }

  private execute(body: ExecuteBody): VaultExchange {
    const known = this.#actions.get(body.action_id);
    if (known && known.digest !== digestOf(body)) {
      return reply(409, { error: { code: "conflict", message: "action_id was already used for a different request" } });
    }
    if (known?.settled) return known.settled;
    return this.advance(body.action_id, known ?? this.start(body));
  }

  private start(body: ExecuteBody): ReplayedAction {
    const fixture = matchFixture(this.#fixtures, body);
    if (!fixture) {
      throw new VaultReplayFixtureMissingError(
        `no replay fixture for tool "${body.tool}" on binding "${body.binding}" (arguments digest ${digestOf(body).slice(0, 12)}); replay never falls back to a live call`,
        { actionId: body.action_id },
      );
    }
    const action: ReplayedAction = { digest: digestOf(body), outcomes: fixture.outcomes, cursor: 0 };
    this.#actions.set(body.action_id, action);
    return action;
  }

  private advance(actionId: string, action: ReplayedAction): VaultExchange {
    const outcome = action.outcomes[Math.min(action.cursor, action.outcomes.length - 1)];
    if (!outcome) throw new VaultReplayFixtureMissingError(`the replay fixture for action ${actionId} has no outcomes`, { actionId });
    const step = stepFor(actionId, outcome);
    action.settled = step.settled;
    action.cursor += 1;
    return step.answer;
  }

  private status(actionId: string): VaultExchange {
    const action = this.#actions.get(actionId);
    if (!action) {
      throw new VaultReplayFixtureMissingError(`no replayed execution exists for action ${actionId}; replay never reads a live execution`, { actionId });
    }
    return action.settled ?? finished(actionId, "reserved");
  }
}
