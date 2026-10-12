# Knowledge bases

A knowledge base (KB) is a governed workspace resource of Agenomic Cloud:
documents in a mutable working set, immutable content-addressed versions, a
published pointer, agent bindings and retrieval events. `client.knowledge`
reads knowledge bases, uploads documents, searches with citations and
publishes versions over HTTP, and `knowledgeTool` turns a knowledge base into
a plain tool definition that common agent frameworks accept.

Every call needs a `baseUrl` on the client: without one it rejects with
`ApiError("cloud_required")`. There is no local engine and no retry; the
first failure is raised.

## Quick start

```ts
import { AgenomicClient } from "@treansai/agenomic-typescript";

const client = new AgenomicClient({
  apiKey: process.env.AGENOMIC_API_KEY,
  baseUrl: "https://agenomic.example",
});

const kb = client.knowledge.knowledgeBase("kb_customer_support");
const found = await kb.search("How long is the refund window?", {
  version: "v3",
});
for (const result of found.results) {
  console.log(result.rank, result.path, result.citation.uri);
}

const document = await kb.getDocument("kdoc_01jb3m5q7s9v1x3z5b7d9f0001");
const section = await kb.getSection({
  documentId: "kdoc_01jb3m5q7s9v1x3z5b7d9f0001",
  section: "Refund Policy",
  version: "published",
});
console.log(section.content);
```

`knowledgeBase(kbId)` returns a handle without a request; `kb.get()` reads
the knowledge base with its statistics and health. `getSection` takes a
section id (`sec_` plus 16 hex digits) or a heading, heading path or anchor.
A heading goes through the structured query route (`get_section`
operation), which matches the document by id first, then by path, file
name or title. Pass `documentId` (the SDK then keeps only that document's
sections) or `document: "faq/refunds.md"`.
The handle's `search` asks for 5 results unless `topK` says otherwise.

## Versions

Every option that takes a version accepts `3`, `"3"`, `"v3"`,
`"published"` or `"draft"` (`normalizeVersion`); numbers are sent on the
wire. Leaving the version out lets the gateway use the published version.
Pin a number when the same question must find the same evidence tomorrow.
`getVersion`, `diffVersions`, `publish` and `rollback` take numbers only.

## Calls

| Call | Route |
| ---- | ----- |
| `list(options)` | `GET /v1/knowledge-bases` |
| `get(kbId)` | `GET /v1/knowledge-bases/:kb_id` |
| `listDocuments(kbId, options)` | `GET .../documents` (`tree: true` adds folders) |
| `getDocument(kbId, documentId)` | `GET .../documents/:document_id` |
| `createDocument(kbId, input)` | `POST .../documents` (inline text) |
| `uploadDocument(kbId, input)` | `POST .../documents/upload` (raw bytes) |
| `getSection(kbId, documentId, sectionId, options)` | `GET .../sections/:section_id` |
| `search(kbId, query, options)` | `POST .../search` |
| `query(kbId, { query } or { operation })` | `POST .../query` |
| `answer(kbId, query, options)` | `POST .../answer` |
| `listVersions`, `getVersion`, `diffVersions` | `.../versions` |
| `publish(kbId, { version, ifMatch })` | `POST .../publish` |
| `rollback(kbId, { ifMatch, reason })` | `POST .../rollback` |
| `getAgentKnowledge`, `putAgentKnowledge` | `/v1/agents/:agent_id/knowledge` |
| `agentSearch(agentId, query, options)` | `POST .../knowledge/search` |
| `getJob(jobId)`, `waitForJob(jobId)` | `GET /v1/knowledge-jobs/:job_id` |

Options are camelCase and responses are the snake_case wire types
(`SearchResponse`, `DocumentWrite`, `VersionView`, ...).

## Uploads

```ts
import { readFile } from "node:fs/promises";

const written = await client.knowledge.uploadDocument("kb_customer_support", {
  path: "policies/refunds.pdf",
  body: await readFile("refunds.pdf"),
  contentType: "application/pdf",
  collection: "faq",
});
await client.knowledge.waitForJob(written.job!.job_id, { timeoutMs: 120_000 });
```

The body (`Uint8Array`, `ArrayBuffer` or a string, encoded as UTF-8) is
sent as is, with the document path in `x-agenomic-document-path`. Without
`contentType` the SDK sends `application/octet-stream` and the gateway
infers the format from the path extension. Every `x-agenomic-*` header
value (path, collection, each tag, classification, change message) is
percent-encoded UTF-8, so `changeMessage: "Révision des remboursements"` is
fine; tags may not hold a comma. Identical bytes on the same path answer
`created: false`.

## Publication

`publish` and `rollback` send `If-Match` with the knowledge base
`publication_generation`. Both are session actions in Agenomic Cloud: an
API key gets `session_required` unless the KB lets CI keys publish.
`waitForJob` polls until the job succeeds, fails or is cancelled and
returns it, and rejects with `knowledge_job_timeout` after `timeoutMs`.

## Agent-scoped retrieval and execution identity

```ts
const found = await client.knowledge.agentSearch(agentId, "refund window", {
  includeContext: true,
  execution: { bindingId: binding.binding_id, runId },
});
console.log(found.execution.manifest_digest);
```

The gateway freezes the agent's knowledge manifest once per execution.
`execution.bindingId` names the prompt execution binding of the run
(`client.bindings.create` returns it); the gateway checks that it belongs to
the agent and uses the knowledge pinned by its release. `executionId` pins
by execution id instead; `runId`, `traceId`, `sessionId` and
`parentSpanId` attach the retrieval to the run ledger and live tracing.

## knowledgeTool

```ts
import { knowledgeTool } from "@treansai/agenomic-typescript";

const searchKb = knowledgeTool({
  client,
  knowledgeBase: "kb_customer_support",
  version: "v3",
  topK: 5,
});
const output = await searchKb.execute({ query: "refund window" });
```

The definition is `{ name, description, parameters, execute }`, with no
dependency on an agent framework: pass `parameters` as the JSON schema of a
function tool and call `execute(args)` with the arguments the model sent.
`client.knowledge.tool(options)` builds the same tool on that client.
`execute` returns the delimited evidence the gateway rendered (retrieved
text is untrusted data, and the preamble says so) followed by one citation
line per result. With `includeContext: false` it returns the citations only.
A gateway refusal returns `knowledge search failed: <code>` so the model
reads it; a client without `baseUrl` and invalid arguments reject.

With `agentId`, the tool calls agent-scoped retrieval; `version` is then
refused, because the execution pin decides the versions. Pass the execution
identity once in the options or per call:
`execute(args, { execution: { bindingId } })`.

## Tracking

`knowledge.retrieve` is a tracking event type. The gateway records every
retrieval itself; when you add your own event, record references and
digests, never retrieved text.

## Not in this package

Knowledge base creation and settings, collections, document edits and
deletion, version creation, approval and verification, sources and sync,
retrieval event reads, replays and evaluations are in the Python SDK, the
web app or the HTTP API.
