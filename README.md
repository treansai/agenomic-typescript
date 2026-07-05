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
pnpm add agenomic-typescript
```

Node.js `18+` is required.

## Basic Usage

```ts
import { AgenomicClient, traceAgentRun } from "agenomic-typescript";

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
import { AgenomicClient } from "agenomic-typescript";

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
import { AgenomicClient } from "agenomic-typescript";

const client = new AgenomicClient({
  apiKey: process.env.AGENOMIC_API_KEY,
  endpoint: "https://api.agenomic.example/v1/traces",
});
```

`emitTrace()` is a no-op when `endpoint` is omitted.

## Next.js Usage

The SDK does not depend on `next`, so it can live in shared packages and still typecheck in non-Next environments.

```ts
import { AgenomicClient, withTracedRoute } from "agenomic-typescript";

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
import { AgenomicClient } from "agenomic-typescript";

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
import { applyRedaction } from "agenomic-typescript";

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
} from "agenomic-typescript";

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

## OpenAI Wrapper Placeholder

`instrumentOpenAI()` does not require the OpenAI SDK as a dependency. Pass any client-like object exposing `responses.create()` or `chat.completions.create()` and the wrapper will record basic `model_call` events when a trace is active.

## Hugging Face Connection

Configure, pin, and call Hugging Face models. The API token is never logged,
returned, or embedded in any object, trace, or error.

```ts
import { AgenomicClient, HuggingFaceClient, lockModel } from "agenomic-typescript";

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
