# Agenomic TypeScript SDK

Lightweight TypeScript SDK for instrumenting Node.js and TypeScript AI agents and emitting Agenomic-compatible traces.

## Features

- Manual trace creation with a fluent `TraceBuilder`
- Function-level instrumentation with `traceAgentRun`
- JSONL export for local pipelines and offline inspection
- HTTP ingestion client with no required external dependencies
- PII redaction hooks with `remove`, `mask`, and `hash` modes
- OpenAI wrapper placeholder with optional lightweight proxy instrumentation
- Hugging Face connection: provider normalization, Hub metadata + credential validation, inference, model locking, and tracing
- MCP tool call helper types and recorders
- Next.js-friendly route handler wrapper

## Installation

```bash
pnpm add @treansai/agenomic-typescript
```

Node.js `18+` is required.

## Basic Usage

```ts
import { AgenomicClient, traceAgentRun } from "@treansai/agenomic-typescript";

const client = new AgenomicClient();

const runAgent = traceAgentRun(
  {
    client,
    agentId: "claims-agent",
    release: "dev",
    redact: ["customer.email", { path: "customer.ssn", mode: "hash" }],
  },
  async (payload, trace) => {
    trace.addPolicyCheck({
      type: "policy_check",
      policyName: "claims-input-check",
      outcome: "allow",
    });

    return {
      approved: true,
      claimId: payload.claimId,
    };
  },
);

await runAgent({
  claimId: "clm_123",
  customer: {
    email: "user@example.com",
    ssn: "123-45-6789",
  },
});
```

If no `endpoint` is configured, the SDK operates in local-only mode and will not attempt HTTP ingestion.

## Manual Trace Creation

```ts
import { AgenomicClient } from "@treansai/agenomic-typescript";

const client = new AgenomicClient();

const trace = client.createTrace({
  agentId: "manual-agent",
  input: { prompt: "Summarize the incident report" },
});

trace.addModelCall({
  type: "model_call",
  provider: "openai",
  model: "gpt-4o-mini",
  input: { prompt: "Summarize the incident report" },
  output: { text: "Summary ready" },
});

trace.complete({
  output: { done: true },
});

const envelope = trace.build();
```

## Node.js HTTP Ingestion

```ts
import { AgenomicClient } from "@treansai/agenomic-typescript";

const client = new AgenomicClient({
  apiKey: process.env.AGENOMIC_API_KEY,
  endpoint: "https://api.agenomic.example/v1/traces",
});
```

`emitTrace()` is a no-op when `endpoint` is omitted.

## Next.js Usage

The SDK does not depend on `next`, so it can live in shared packages and still typecheck in non-Next environments.

```ts
import { AgenomicClient, withTracedRoute } from "@treansai/agenomic-typescript";

const client = new AgenomicClient();

export const POST = withTracedRoute(
  {
    client,
    agentId: "support-route",
    release: "dev",
    mapRequest: async (request) => {
      const body = await request.clone().json();
      return {
        method: request.method,
        url: request.url,
        body,
      };
    },
  },
  async (request, _context, trace) => {
    const body = await request.json();

    trace.addToolCall({
      type: "tool_call",
      toolName: "ticket.lookup",
      input: { ticketId: body.ticketId },
      output: { found: true },
    });

    return Response.json({ ok: true });
  },
);
```

## JSONL Export

```ts
import { AgenomicClient } from "@treansai/agenomic-typescript";

const client = new AgenomicClient();
const trace = client.createTrace({
  agentId: "export-agent",
  input: { prompt: "Hello" },
});

trace.complete({ output: { message: "done" } });

await client.exportJsonl("./traces/agenomic.jsonl", [trace.build()]);
```

Each line is a standalone `TraceEnvelope`.

## Redaction

Redaction paths are dotted paths applied relative to captured payloads such as run input/output and event input/output.

```ts
import { applyRedaction } from "@treansai/agenomic-typescript";

const scrubbed = applyRedaction(
  {
    customer: {
      email: "user@example.com",
      token: "secret",
    },
  },
  [
    "customer.email",
    { path: "customer.token", mode: "remove" },
  ],
);
```

Supported modes:

- `mask`: replaces the value with `[REDACTED]`
- `remove`: deletes object keys or clears array slots
- `hash`: replaces the value with a deterministic SHA-256 hash

## MCP Tool Call Recording

```ts
import {
  AgenomicClient,
  recordMCPToolCall,
  traceAgentRun,
} from "@treansai/agenomic-typescript";

const client = new AgenomicClient();

const run = traceAgentRun(
  {
    client,
    agentId: "mcp-agent",
  },
  async (_payload) => {
    recordMCPToolCall({
      server: "filesystem",
      tool: "read_file",
      arguments: { path: "/tmp/input.txt" },
      result: { bytes: 128 },
    });

    return { ok: true };
  },
);
```

`recordMCPToolCall()` uses the active async trace context when called inside `traceAgentRun()` or `withTracedRoute()`.

## Tool Execution for Replays

`client.tools` routes each tool call of a replay through the Agenomic Tool
Gateway. The cloud answers with the real backend (secrets resolved server-side
from `${env:VAR_NAME}` references) or with the Tool Mock Engine, per tool and
by explicit configuration. There is no implicit fallback to a real call.

```ts
import { AgenomicClient, ToolCallError } from "@agenomic/sdk";

const client = new AgenomicClient({ apiKey: "agm_...", baseUrl: "https://cloud.example" });
const configText = await fs.readFile("tool_execution.yaml", "utf8");
let run = await client.tools.createRun({ name: "hybrid", configText, repetitions: 3 });
if (run.status === "planned") run = await client.tools.approveRun(String(run.id), String(run.plan_hash));
await client.tools.startRun(String(run.id));

const router = client.tools.router(String(run.id), { repetition: 1 });
const customer = await router.call<{ tier: string }>("crm.get_customer", { id: "c_1" });
try {
  await router.call("email.send", { to: "ops@example.test" });
} catch (error) {
  if (error instanceof ToolCallError) console.log(error.code, error.envelope.agenomic.provenance);
}
console.log(router.summary()); // { calls, bySource, hasRealCalls, unreported }
```

Functions passed as `localFunctions` never run before the gateway allows
them: the router calls `local/authorize` first (budget reserved, pending
record), executes only on a `local` decision, routes the call through the
gateway when the run binds the tool to a mock, and settles the record with
`report-local`. If the report fails, the call stays in `router.calls` with
`reported: false` and `external_state: "indeterminate"`.

## Protect: Proactive Policy Enforcement

On a protect run (a tool execution config carrying a `protect` block) the
gateway admits every call against the released policies bound to the org,
environment, agent, tool contract or run before anything executes. The
router surfaces the three admission outcomes as typed errors; nothing runs
locally until the gateway says `local` and hands over a signed permit.

```ts
import { ToolApprovalPending, ToolCallDenied } from "@agenomic/sdk";

const router = client.tools.router(runId, {
  localFunctions: { "crm.update_customer": updateCustomer },
  beforeAction: (intent) => audit.log(intent), // may throw to abort locally, never approves
});

try {
  await router.call("crm.update_customer", { id: "c_42", fields: { credit_limit: 50000 } });
} catch (error) {
  if (error instanceof ToolApprovalPending) {
    // HTTP 202: a reviewer must decide. Poll and re-issue the same call once approved.
    await router.resume(error, { pollIntervalMs: 2000, timeoutMs: 900_000 });
  } else if (error instanceof ToolCallDenied) {
    // HTTP 403: error.code is policy_denied (or the approval status on resume),
    // error.decision carries reason_codes, error.transformation a redaction proposal.
  }
}
```

- `ToolCallResult.result` is `null` for pending and denied calls; both are
  appended to `router.calls` with `status: "pending" | "denied"`.
- Unknown decision strings from `local/authorize` are treated as denied.
- `resume` re-issues the identical call identity exactly once, with the
  original `Idempotency-Key`, when the approval is `approved` or `consumed`;
  a `consumed` approval already executed, so the replay recovers its stored
  result and a 409 answer throws `ToolExecutionError` with `code` `conflict`.
- `resume` throws `ToolCallDenied` with `code` `rejected`, `expired` or any
  other terminal status, and `ToolExecutionError("approval_timeout")` when
  the approval is still pending after `timeoutMs`.
- The permit returned by `local/authorize` is forwarded verbatim to
  `report-local`.

`client.protect` adds `overlay(runId)`, `catalog(runId)`, `approvals`,
`decisions`, `policies`, `bindings`, `restrictions`, `killSwitch`,
`simulate`, `coverage` and `metricsSummary` over `/v1/protect/*` and
`/v1/policies/*`; server refusals surface as `ToolExecutionError` with the
server `code`. The RMP alert methods keep working.

```ts
const overlay = await client.protect.overlay(runId);
const openai = instrumentOpenAI(new OpenAI(), { overlay });
```

With an `overlay` (string or `ProtectOverlay`) the wrapper prepends a system
message to `chat.completions.create` requests and sets or prefixes
`instructions` on `responses.create` requests, deterministically and
idempotently, before the call leaves the process; the recorded `model_call`
input is the injected request.

## OpenAI Wrapper Placeholder

`instrumentOpenAI()` does not require the OpenAI SDK as a dependency. Pass any client-like object exposing `responses.create()` or `chat.completions.create()` and the wrapper will record basic `model_call` events when a trace is active.

## Hugging Face Connection

Configure, pin, and call Hugging Face models. The API token is never logged,
returned, or embedded in any object, trace, or error.

```ts
import { AgenomicClient, HuggingFaceClient, lockModel } from "@treansai/agenomic-typescript";

const client = new AgenomicClient();
await client.models.configure({
  provider: "huggingface", // also accepts "hf", "hugging_face"
  model: "mistralai/Mistral-7B-Instruct-v0.3",
  task: "text-generation",
});

const hf = new HuggingFaceClient(); // reads HUGGINGFACE_API_TOKEN / HF_TOKEN
await hf.validateCredentials();
const meta = await hf.resolveModelMetadata("mistralai/Mistral-7B-Instruct-v0.3");
const lock = lockModel(meta); // credential-free, hash-pinned lock block
```

See [docs/providers/huggingface.md](docs/providers/huggingface.md) for the full
reference (env vars, `instrumentHuggingFace`, redaction, and locking).

## Trace Schema Compatibility

The SDK emits `TraceEnvelope` objects containing:

- `run`: top-level `AgentRun` metadata with hashes, timestamps, and status
- `events`: ordered `TraceEvent[]` entries for model calls, tool calls, memory access, policy checks, human feedback, and completion
- `redaction`: optional summary of applied redaction rules

All emitted traces are validated at runtime with `zod` through the exported schemas:

- `TraceEnvelopeSchema`
- `AgentRunSchema`
- `TraceEventSchema`

## Development

```bash
pnpm install
pnpm test
pnpm build
```

## Release

Tag a commit `vMAJOR.MINOR.PATCH` and GitHub Actions publishes the package to npm with
provenance. See [docs/release.md](docs/release.md).
