/**
 * Protect consumed recovery contract, exercised against a real gateway.
 *
 * Manual harness for closure criterion 3 of the Protect integration campaign
 * (agenomic-cloud `docs/protect/integration-test-report-2026-09-15.md`): the
 * `approved` / `consumed` resume contract was defined against an HTTP fixture
 * only, so this script replays it end to end against a running api-gateway, a
 * real Postgres and two distinct user owned API keys. It is the TypeScript
 * twin of `examples/11_protect_consumed_recovery.py` in agenomic-python and
 * asserts the same contract, so a divergence between the two SDKs against the
 * real gateway shows up as a failing assertion here.
 *
 * Environment:
 *
 *   AGENOMIC_BASE_URL            gateway base URL
 *   AGENOMIC_API_KEY             caller, a user owned key with the write role
 *   AGENOMIC_REVIEWER_KEY        reviewer, a user owned key of a DIFFERENT user
 *   AGENOMIC_ADMIN_KEY           owner key (policy release, policy binding)
 *   AGENOMIC_TOOL_URL            counting HTTP tool endpoint (serves /__count)
 *   AGENOMIC_ENV_PROFILE         tool-execution profile holding URL and allowing
 *                                the loopback destination
 *   AGENOMIC_APPROVAL_TTL_SECS   the gateway's protect.approval_ttl_secs
 *
 * The reviewer_distinct_from_principal obligation refuses a self approval and
 * refuses a credential with no user, so caller and reviewer must both be user
 * owned keys of two different users.
 *
 * Each pending call is issued by TWO routers over the same identity: the
 * gateway answers 202 twice with one approval, so the second router still
 * holds the pending call once the first has resumed. That is how the consumed
 * recovery path is reachable at all, since `resume` drops its pending entry
 * before re-issuing and a second `resume` on the same router never reaches
 * the gateway.
 *
 *   A gateway executed HTTP tool: pending, approve, resume, consumed resume
 *   B runtime local function:     pending, approve, resume, consumed resume
 *   C rejected approval:          denial, nothing ran
 *   D expired approval:           denial, nothing ran
 *
 * Run with the built bundle:
 *   node --experimental-strip-types examples/protect-consumed-recovery.ts
 */

import { writeFileSync } from "node:fs";
import {
  AgenomicClient,
  ToolApprovalPending,
  ToolCallDenied,
  ToolExecutionError,
  type ToolRouter,
} from "../dist/index.js";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const BASE = env("AGENOMIC_BASE_URL");
const TOOL_URL = env("AGENOMIC_TOOL_URL");
const PROFILE = process.env.AGENOMIC_ENV_PROFILE ?? "sdk-real";
const TTL = Number(process.env.AGENOMIC_APPROVAL_TTL_SECS ?? "45");
const AGENT = "agent://sdkreal/typescript";
const POLICY_ID = "sdk-real-typescript";
const VERSION = process.env.AGENOMIC_POLICY_VERSION ?? "1.0.0";

const caller = new AgenomicClient({ baseUrl: BASE, apiKey: env("AGENOMIC_API_KEY") });
const reviewer = new AgenomicClient({ baseUrl: BASE, apiKey: env("AGENOMIC_REVIEWER_KEY") });
const admin = new AgenomicClient({ baseUrl: BASE, apiKey: env("AGENOMIC_ADMIN_KEY") });

const POLICY = `
policy_id: ${POLICY_ID}
version: ${VERSION}
schema_version: agenomic.policy/v1
status: draft
scope:
  tools: [crm.update_customer, crm.set_flag]
  agent_id: ${AGENT}
  environment: production
default_decision: deny
rules:
  - rule_id: update-needs-review
    match:
      action_type: tool.call
      tool_id: crm.update_customer
      arguments: [{ field: fields.credit_limit, op: exists }]
    decision: require_approval
    obligations: [{ kind: reviewer_distinct_from_principal }]
    reason: credit limit changes need a human reviewer
  - rule_id: set-flag-needs-review
    match:
      action_type: tool.call
      tool_id: crm.set_flag
      arguments: [{ field: flag, op: exists }]
    decision: require_approval
    obligations: [{ kind: reviewer_distinct_from_principal }]
    reason: flag changes need a human reviewer
`;

const CONFIG = `
schema_version: agenomic.tool_execution/v1
mode: live
default_mode: mock
on_unmatched: error
environment_profile: ${PROFILE}
allowed_env: [URL]
limits: { max_live_calls: 20, max_concurrency: 2, timeout_ms: 15000 }
safety: { live_writes: allow, require_approved_bindings: true, allow_implicit_fallback: false }
recording: { enabled: false }
protect:
  agent_id: ${AGENT}
  environment: production
  mode: enforce
  policy_refs: [${POLICY_ID}@${VERSION}]
bindings:
  crm.update_customer:
    mode: live
    adapter: http
    transport: http
    endpoint: \${env:URL}/crm/update
    method: POST
    effect: reversible_write
    health_path: /health
  crm.set_flag:
    mode: live
    adapter: local
    transport: in_process
    function: crm.set_flag
    effect: reversible_write
`;

const observed: Record<string, unknown>[] = [];
const localCalls: Record<string, unknown>[] = [];

function note(step: string, fields: Record<string, unknown> = {}): void {
  const entry = { step, ...fields };
  observed.push(entry);
  console.log(JSON.stringify(entry));
}

function check(label: string, ok: boolean, detail: unknown = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  if (!ok) {
    note("assertion_failed", { label, detail });
    process.exit(1);
  }
}

async function endpointCount(): Promise<number> {
  const response = await fetch(`${TOOL_URL}/__count`);
  const body = (await response.json()) as { count: number };
  return body.count;
}

async function settled(runId: string, logicalCallId: string): Promise<unknown[]> {
  const exported = (await caller.tools.exportRun(runId)) as { invocations?: Record<string, unknown>[] };
  return (exported.invocations ?? []).filter((invocation) => invocation.logical_call_id === logicalCallId);
}

/** Both routers issue the identical identity; the gateway answers 202 twice. */
async function pendingTwice(
  routerA: ToolRouter,
  routerB: ToolRouter,
  tool: string,
  args: Record<string, unknown>,
  callId: string,
): Promise<ToolApprovalPending> {
  const issue = async (router: ToolRouter): Promise<ToolApprovalPending | null> => {
    try {
      await router.call(tool, args, { logicalCallId: callId });
      return null;
    } catch (error) {
      return error instanceof ToolApprovalPending ? error : Promise.reject(error);
    }
  };
  const first = await issue(routerA);
  const second = await issue(routerB);
  check(`${callId}: router A threw ToolApprovalPending`, first !== null);
  check(`${callId}: router B threw ToolApprovalPending`, second !== null);
  check(`${callId}: one approval for both routers`, first!.approvalId === second!.approvalId, first!.approvalId);
  return first!;
}

type Outcome = { kind: "recovered"; result: unknown } | { kind: "error"; code: string; status: number; message: string };

async function resumeOutcome(router: ToolRouter, approvalId: string): Promise<Outcome> {
  try {
    return { kind: "recovered", result: await router.resume(approvalId, { pollIntervalMs: 200, timeoutMs: 30_000 }) };
  } catch (error) {
    if (error instanceof ToolExecutionError) {
      return { kind: "error", code: error.code, status: error.status, message: error.message };
    }
    throw error;
  }
}

async function main(): Promise<void> {
  await admin.protect.policies.register(POLICY);
  await admin.protect.policies.release(POLICY_ID, VERSION);
  const binding = await admin.protect.bindings.create({
    policyId: POLICY_ID,
    version: VERSION,
    scopeKind: "agent",
    scopeRef: AGENT,
    mode: "enforce",
  });
  note("binding", { id: binding.id, status: binding.status });

  const run = (await caller.tools.createRun({
    name: `protect-consumed-ts-${crypto.randomUUID().slice(0, 8)}`,
    configText: CONFIG,
  })) as { id: string; plan_hash: string };
  await caller.tools.approveRun(run.id, run.plan_hash);
  await caller.tools.startRun(run.id);
  note("run", { id: run.id });

  const localFunctions = {
    "crm.set_flag": (args: Record<string, unknown>) => {
      localCalls.push(args);
      return { flag_set: true, call_number: localCalls.length };
    },
  };
  const routerA = caller.tools.router(run.id, { localFunctions });
  const routerB = caller.tools.router(run.id, { localFunctions });

  let before = await endpointCount();
  const args = { customer_id: "c-1", fields: { credit_limit: 5000 } };
  let pending = await pendingTwice(routerA, routerB, "crm.update_customer", args, "gw-1");
  check("A: the tool endpoint was not called", (await endpointCount()) === before);
  note("A.pending", { approval_id: pending.approvalId, endpoint_calls: await endpointCount() });

  try {
    await caller.protect.approvals.decide(pending.approvalId, { decision: "approve", comment: "self approval" });
    check("A: self approval refused", false, "the caller approved its own call");
  } catch (error) {
    note("A.self_approve", { refused: (error as Error).name, message: String((error as Error).message).slice(0, 120) });
  }

  const decided = await reviewer.protect.approvals.decide(pending.approvalId, { decision: "approve", comment: "reviewed" });
  check("A: reviewer approved", decided.status === "approved", decided.status);

  const result = (await routerA.resume(pending, { pollIntervalMs: 200, timeoutMs: 30_000 })) as Record<string, unknown>;
  note("A.resume", { result, endpoint_calls: await endpointCount() });
  check("A: recovered result", result.updated === true, result);
  check("A: exactly one endpoint call", (await endpointCount()) === before + 1, await endpointCount());
  check("A: exactly one settled invocation", (await settled(run.id, "gw-1")).length === 1);

  const consumedStatus = (await caller.protect.approvals.get(pending.approvalId)).status;
  check("A: approval is consumed", consumedStatus === "consumed", consumedStatus);

  let outcome = await resumeOutcome(routerB, pending.approvalId);
  note("A.consumed_resume", { ...outcome, endpoint_calls: await endpointCount() });
  check(
    "A: consumed resume either recovers the stored result or raises conflict",
    outcome.kind === "recovered" || outcome.code === "conflict",
    outcome,
  );
  if (outcome.kind === "recovered") {
    check("A: the replayed result is the stored one", JSON.stringify(outcome.result) === JSON.stringify(result), outcome.result);
  }
  check("A: the consumed resume ran no second effect", (await endpointCount()) === before + 1);
  check("A: still exactly one settled invocation", (await settled(run.id, "gw-1")).length === 1);

  const routerC = caller.tools.router(run.id, { localFunctions });
  const routerD = caller.tools.router(run.id, { localFunctions });
  pending = await pendingTwice(routerC, routerD, "crm.set_flag", { flag: "vip" }, "loc-1");
  check("B: the local function did not run", localCalls.length === 0, localCalls);
  note("B.pending", { approval_id: pending.approvalId, local_calls: localCalls.length });

  await reviewer.protect.approvals.decide(pending.approvalId, { decision: "approve", comment: "reviewed" });
  const localResult = (await routerC.resume(pending, { pollIntervalMs: 200, timeoutMs: 30_000 })) as Record<string, unknown>;
  note("B.resume", { result: localResult, local_calls: localCalls.length });
  check("B: recovered result", localResult.flag_set === true, localResult);
  check("B: the local function ran exactly once", localCalls.length === 1, localCalls);
  check("B: exactly one settled invocation", (await settled(run.id, "loc-1")).length === 1);

  outcome = await resumeOutcome(routerD, pending.approvalId);
  note("B.consumed_resume", { ...outcome, local_calls: localCalls.length });
  check(
    "B: consumed resume either recovers the stored result or raises conflict",
    outcome.kind === "recovered" || outcome.code === "conflict",
    outcome,
  );
  check("B: the local function still ran once", localCalls.length === 1, localCalls);

  before = await endpointCount();
  const routerE = caller.tools.router(run.id, { localFunctions });
  try {
    await routerE.call("crm.update_customer", { customer_id: "c-2", fields: { credit_limit: 9000 } }, { logicalCallId: "gw-2" });
    check("C: pending thrown", false);
  } catch (error) {
    if (!(error instanceof ToolApprovalPending)) throw error;
    pending = error;
  }
  const rejected = await reviewer.protect.approvals.decide(pending.approvalId, { decision: "reject", comment: "too high" });
  note("C.rejected", { status: rejected.status });
  try {
    await routerE.resume(pending, { pollIntervalMs: 200, timeoutMs: 30_000 });
    check("C: rejected raises a denial", false);
  } catch (error) {
    if (!(error instanceof ToolCallDenied)) throw error;
    note("C.resume", { code: error.code, endpoint_calls: await endpointCount() });
    check("C: denial carries the rejected status", error.code === "rejected", error.code);
  }
  check("C: nothing ran", (await endpointCount()) === before, await endpointCount());

  const routerF = caller.tools.router(run.id, { localFunctions });
  try {
    await routerF.call("crm.update_customer", { customer_id: "c-3", fields: { credit_limit: 1000 } }, { logicalCallId: "gw-3" });
    check("D: pending thrown", false);
  } catch (error) {
    if (!(error instanceof ToolApprovalPending)) throw error;
    pending = error;
  }
  note("D.pending", { approval_id: pending.approvalId, ttl_secs: TTL });
  const started = Date.now();
  try {
    await routerF.resume(pending, { pollIntervalMs: 1000, timeoutMs: (TTL + 60) * 1000 });
    check("D: expired raises a denial", false);
  } catch (error) {
    if (!(error instanceof ToolCallDenied)) throw error;
    note("D.resume", { code: error.code, waited_secs: Math.round((Date.now() - started) / 100) / 10 });
    check("D: denial carries the expired status", error.code === "expired", error.code);
  }
  check("D: nothing ran", (await endpointCount()) === before, await endpointCount());

  await caller.tools.completeRun(run.id);
  const out = process.env.AGENOMIC_OBSERVED_OUT;
  if (out) writeFileSync(out, JSON.stringify(observed, null, 2));
  console.log(`\nprotect consumed recovery: typescript SDK, run ${run.id}, ${observed.length} observations`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
