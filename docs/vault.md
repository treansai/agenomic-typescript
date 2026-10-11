# Agents Vault

Agents Vault is an **optional commercial module** of Agenomic Cloud and needs the
Agents Vault add-on on your workspace. The SDK surface is public and always
present; without the add-on the server answers business calls with a typed
"locked" error (see [Locked workspaces](#locked-workspaces)). The SDK never
decides entitlement itself.

An agent **uses** a credential in place; it never **receives** it. A trusted
executor holds the secret for the duration of one call, sends the request to a
destination that was fixed in advance, filters the response and hands back only
the business result.

```
agent runtime ──(runtime token, intent)──▶ Agenomic Cloud ──▶ policy, approval, grant
                                                │
                                                ▼
                                       secure executor ──(secret, one call)──▶ destination
                                                │
agent runtime ◀──(filtered result + receipt id)─┘
```

`client.tools.execute` is the Agents Vault entry point. It is unrelated to the
replay Tool Gateway methods on the same namespace (`createRun`, `invoke`,
`router`), which are unchanged.

Two clients, two credentials, never mixed:

| Namespace | Credential | Used for |
|---|---|---|
| `client.tools.execute(...)`, `client.vault.runtime` | runtime token `vrt_...` (`vault.runtimeToken`) | the agent: execute actions, read its executions, request and delegate grants |
| `client.vault.*` | the client `apiKey` | people and automation: providers, secrets, bindings, grants, identities, rotations, revocations, evidence |

The runtime token is sent only on `/v1/vault/runtime/*`; the API key only on the
other `/v1/vault/*` routes. Custom `headers` on the client cannot override
either.

## Concepts

- **Secret**: metadata plus versions. The value is write-only. It goes in once,
  wrapped in `Sensitive`, and no method of the SDK returns it.
- **Provider**: where the value actually lives (OpenBao is the reference
  backend). Managed providers accept values; customer-hosted and bring-your-own
  providers register references to values that stay in your vault.
- **Binding**: the fixed recipe for one tool: which secret, which destination
  host, where the credential is placed, what the request template and the
  response filter are. Destination, headers and auth placement are never chosen
  by the agent. A binding has versions; a version is proposed, submitted,
  approved by a human who is not the proposer, then activated.
- **Grant**: the right to use a binding version, bounded by a number of
  **logical actions** and an expiry. A grant is requested (by an agent or on its
  behalf) and approved by a human who is not the requester. A runtime identity
  can delegate a narrower slice of an approved grant to another agent of the
  same environment; delegation never widens scope.
- **Runtime identity**: an enrollment token scoped to one organization,
  environment and agent. It is shown once, short lived and revocable. It proves
  possession of the token, not which code is running.
- **Action and `actionId`**: one logical business action. The server is
  idempotent per `actionId`: a resend returns the stored outcome and never
  repeats an external effect.
- **Receipt**: the evidence of an action (`authorized`, `completed`,
  `outcome_unknown`, `refused`), recorded in two phases around the privileged
  step.
- **Revocation**: Agenomic's own block (`blocked_locally`) and the provider-side
  state (`confirmed_upstream`, `pending`, `failed`, `expires_only`, ...) are
  reported separately. Blocking locally never proves the upstream credential is
  gone.

## Quick start

### Administer (people and automation)

```ts
import { AgenomicClient, Sensitive } from "@treansai/agenomic-typescript";

const admin = new AgenomicClient({ apiKey: process.env.AGENOMIC_API_KEY, baseUrl: "https://api.agenomic.dev" });

const status = await admin.vault.status(); // usable even when locked

const provider = await admin.vault.providers.list().then((all) => all[0]!);

// Write-only: the value is wrapped, sent once, and nothing returns it.
const { secret } = await admin.vault.secrets.create({
  environment: "prod",
  name: "crm-api-key",
  secretType: "api_key",
  providerId: provider.id,
  value: new Sensitive(process.env.CRM_API_KEY!),
});

const { binding } = await admin.vault.bindings.create({
  environment: "prod",
  name: "binding-crm-sales",
  agentId: "sales-agent",
  toolName: "crm.contacts.create",
  content: {
    secret_id: secret.id,
    upstream_identity: "crm-service-account",
    tool_contract_ref: "crm.contacts.create@1",
    destination: { scheme: "https", host: "crm.example.com", port: 443 },
    auth: { kind: "bearer" },
    request: { method: "POST", path: "/v1/contacts", body: { mode: "arguments" } },
    effect: "write",
  },
});

await admin.vault.bindings.submit(binding.id, 1);
await admin.vault.bindings.approve(binding.id, 1); // a different person than the proposer
await admin.vault.bindings.activate(binding.id, 1);

const grant = await admin.vault.grants.request({ bindingId: binding.id, maxUses: 100, ttlSeconds: 86_400, reason: "weekly import" });
await admin.vault.grants.approve(grant.id); // a different person than the requester

// The token is returned once, masked everywhere, and handed out once.
const issued = await admin.vault.runtimeIdentities.issue({ environment: "prod", agentId: "sales-agent", label: "sales-agent prod" });
const token = issued.token.takeOnce(); // store it in the agent runtime's secret store
```

### Execute (the agent)

```ts
import { AgenomicClient, VaultApprovalRequiredError, VaultOutcomeUnknownError } from "@treansai/agenomic-typescript";

const agent = new AgenomicClient({ baseUrl: "https://api.agenomic.dev", vault: { runtimeToken: process.env.AGENOMIC_RUNTIME_TOKEN } });

const done = await agent.tools.execute<{ id: string }>({
  tool: "crm.contacts.create",
  binding: "binding-crm-sales",
  arguments: { email: "ada@example.com" },
});
// done.result      the business result, already filtered server side
// done.receiptId   the evidence record of this action
// done.actionId    generated when you did not pass one; keep it
```

`tools.execute` returns only on success. Every other outcome is a typed error
that carries the `actionId`, so the caller can decide what to do next. To look an
execution up later (any state is returned as data, including `outcome_unknown`):

```ts
const status = await agent.tools.executionStatus(done.actionId);
```

### Approvals

When a policy requires a human decision the call throws
`VaultApprovalRequiredError` with the `approvalId`. A reviewer decides it through
the Protect approvals API (`client.protect.approvals.decide`). Then **resend with
the same `actionId`**:

```ts
try {
  await agent.tools.execute({ tool, binding, arguments, actionId });
} catch (error) {
  if (error instanceof VaultApprovalRequiredError) {
    // wait for the reviewer, then:
    await agent.tools.execute({ tool, binding, arguments, actionId: error.actionId });
  }
}
```

### Unknown outcomes

If the request was sent and the result is unknown (a timeout or transport error
after sending, a destination 5xx on a write), the execution is
`outcome_unknown` and `tools.execute` throws `VaultOutcomeUnknownError`.

- The SDK **never retries it**, and a resend with the same `actionId` returns the
  stored state instead of sending again.
- Do not generate a new `actionId` to "try again": that is a second action and may
  repeat the effect.
- Reconcile at the destination (or with an operator), then a human with
  `execution.reconcile` settles it:

```ts
await admin.vault.executions.resolve(actionId, { resolution: "not_applied", note: "checked the CRM: no contact was created" });
```

`resolve` records what was established. It never re-sends the action.

### Locked workspaces

```ts
import { isVaultLocked } from "@treansai/agenomic-typescript";

try {
  await admin.vault.providers.create(input);
} catch (error) {
  if (isVaultLocked(error)) {
    // error.reason: "not_entitled" | "not_in_edition" | "disabled"
    // error.requiredPlan: the plan the server says would unlock it (when it says so)
  }
}
```

Business operations (execute, create a provider, secret, binding or grant, start
a rotation) need the add-on. Safety operations (revoke, kill switch, rollback,
lift, retry) and metadata and evidence reads do not, so a workspace whose add-on
ended can still shut things down and read its history. Nothing is deleted when
the add-on ends.

## Retries

`tools.execute` retries technical failures only, up to `vault.retry.maxAttempts`
(default 3), with exponential backoff, and **always with the same serialized
request, so the same `actionId`**:

| Retried | Not retried |
|---|---|
| no response received (network fault) | the SDK's own timeout (the server may still be executing) |
| HTTP 429 (honors `Retry-After` up to `maxDelayMs`) | any definitive answer: success, denial, approval, grant, revocation, validation |
| HTTP 502, 503, 504 | HTTP 500 |
| `vault_backend_unavailable`, `vault_destination_unavailable` | **`outcome_unknown`, in any form** |

Admin reads are retried the same way. Admin writes are never resent after a
network fault or a 5xx; they are retried only after a 429, which the server
returns before processing.

```ts
new AgenomicClient({ vault: { runtimeToken, retry: { maxAttempts: 1 } } }); // no retries
new AgenomicClient({ vault: { runtimeToken, timeoutMs: 20_000, logger: (event) => log.debug(event) } });
```

Log events carry the phase, method, path, attempt, status and `actionId`, never a
body, header or token.

## Errors

Every error extends `VaultError`, which extends `ToolExecutionError`, so existing
`catch (e) { if (e instanceof ToolExecutionError) ... }` code keeps working.
Fields on every error: `code`, `status` (0 when nothing was sent), `message`,
`requestId`, `retryable`, and `actionId` when the call had one.

| Class | `code` | HTTP | Meaning and what to do |
|---|---|---|---|
| `VaultNotEntitledError` | `capability_not_entitled`, `capability_not_in_edition`, `capability_disabled` | 403 | Locked. `locked` is `true`; `reason` and `requiredPlan` as the server reports them. Show an upgrade hint. |
| `VaultApprovalRequiredError` | `approval_required` | 202 | A human must decide `approvalId`; then resend the same `actionId`. |
| `VaultPolicyDeniedError` | `policy_denied` | 403 | Policy refused; nothing was sent. `reasonCodes`, `explanation`. A resend of a denied `actionId` also lands here. |
| `VaultGrantUnusableError` | `vault_grant_unusable` | 409 | No usable grant. `reason`: `not_found`, `not_approved`, `expired` or `exhausted`. Request a grant. |
| `VaultRevokedError` | `vault_revoked` | 409 | The binding is revoked or suspended, or its secret, provider or identity is revoked. |
| `VaultOutcomeUnknownError` | `vault_outcome_unknown` | 200 or 409 | Sent, effect unknown. Never retried. `receiptId`, `limitations`. Reconcile, then `executions.resolve`. |
| `VaultRateLimitedError` | `too_many_requests` | 429 | `retryAfterMs` when the server sent `Retry-After`. |
| `VaultExecutionFailedError` | `execution_failed` | 200 | The destination answered with an error. `statusCode`, `errorClass`, `result` (the server-filtered body). |
| `VaultValidationError` | `validation_error`, or a client-side `invalid_input`, `sensitive_required`, `sensitive_refused`, `sensitive_invalid`, `sensitive_disposed`, `body_not_serializable` | 400 or 0 | Bad request. Client-side codes mean nothing was sent. |
| `VaultAuthenticationError` | `unauthorized` | 401 | Missing or invalid credential for that surface. |
| `VaultPermissionError` | `vault_permission_denied`, `forbidden` | 403 | The caller lacks a vault permission. Not a lock. |
| `VaultNotFoundError` | `not_found` | 404 | Unknown or foreign id (also what a workspace without the module installed answers). |
| `VaultConflictError` | `conflict`, `execution_in_progress` | 409 | For example an `actionId` reused for a different request, or an execution still in flight: read its status instead of resending. |
| `VaultRefusedError` | `vault_backend_unavailable`, `vault_backend_rejected`, `vault_destination_denied`, `vault_destination_unavailable`, `vault_authorization_invalid`, `vault_result_blocked`, `vault_fail_closed`, `vault_unsupported`, or the `code` of a `refused` body | 409 | The vault refused and failed closed. `retryable` is true for the two `*_unavailable` codes. |
| `VaultTransportError` | `transport_error`, `timeout` | 0 | No complete response. `maybeSent`, `timedOut`. Read the execution by `actionId` or resend it. |
| `VaultConfigurationError` | `cloud_required`, `api_key_required`, `runtime_token_required`, `runtime_token_invalid`, `replay_with_credentials`, `replay_fixtures_invalid` | 0 | The client is not set up for the call. |
| `VaultReplayFixtureMissingError` | `replay_fixture_missing` | 0 | Replay mode has no fixture. See [Replay](#replay). |
| `VaultReplayUnavailableError` | `replay_unavailable` | 0 | Replay mode cannot answer this operation and never sends it live. |
| `VaultError` | `invalid_response`, `internal_error`, `http_error`, ... | any | A response the SDK refuses to treat as success, or a server error with no dedicated class. |

The SDK fails closed: a 2xx body that is not a recognized, consistent outcome is
`invalid_response`, never a success.

## Replay

Replay answers `client.tools.execute` from fixtures and never touches the
network. It is explicit: a client either is a live client or a replay client.

```ts
import { AgenomicClient, VaultOutcomeUnknownError } from "@treansai/agenomic-typescript";

const client = new AgenomicClient({
  vault: {
    replay: {
      fixtures: [
        { tool: "crm.contacts.create", binding: "binding-crm-sales", outcome: { kind: "succeeded", result: { id: "contact_1" }, receiptId: "..." } },
        { tool: "crm.contacts.merge", binding: "binding-crm-sales", outcomes: [{ kind: "approval_required", approvalId: "..." }, { kind: "succeeded", result: { merged: true } }] },
        { tool: "crm.contacts.delete", binding: "binding-crm-sales", outcome: { kind: "denied", reasonCodes: ["destructive_effect"] } },
      ],
    },
  },
});
```

- **A missing fixture is an error**, `VaultReplayFixtureMissingError`
  (`replay_fixture_missing`). There is no option to fall back to a live call, and
  a replay client holds no runtime token, so it could not go live anyway:
  combining `replay` with `runtimeToken` is refused when the client is built.
- A fixture matches on `tool` and `binding`. With `arguments` it matches only
  those exact arguments (key order does not matter) and wins over a fixture
  without. Matching never puts the arguments in an error message, only a short
  digest.
- Outcome kinds: `succeeded`, `failed`, `outcome_unknown`, `approval_required`,
  `denied`, `refused`, and `error` (a server error such as a lock). Each produces
  the same wire answer the server gives, so replay goes through the same error
  mapping as a live call.
- `outcomes` are consumed in order per `actionId`; only `approval_required`,
  `refused` and `error` advance, so a resend can succeed after an approval.
  Settled outcomes (`succeeded`, `failed`, `outcome_unknown`, `denied`) answer the
  same on resend, like the server. Reusing an `actionId` for a different request is
  a `VaultConflictError`.
- Admin and grant calls are not available in replay mode and throw
  `VaultReplayUnavailableError`; they are never sent live.
- Results carry `source: "replay"`. Load recorded fixtures from JSON with
  `parseVaultReplayFixtures(JSON.parse(text))`, which names the offending path
  and never echoes a value.

Replay with real destinations ("live replay") is a server-side business
operation and is not part of this SDK surface.

## Keeping secrets out

- **Values go in once.** `vault.secrets.create`, `addVersion` and `rotate` take a
  `Sensitive`; a plain string is refused with `sensitive_required` before
  anything is sent, and the message never contains the value.
- **`Sensitive` has one face.** `String(x)`, template literals, `JSON.stringify`,
  `util.inspect`, `console.*` and `structuredClone` all produce the same constant
  mask, whatever the length. It has no accessor. `dispose()` zeroes the bytes it
  holds (best effort: the string you built it from stays in your heap, and
  JavaScript cannot erase it).
- **Only secret writes carry a value.** A `Sensitive` anywhere else, including in
  tool `arguments`, is refused with `sensitive_refused` rather than sent as its
  mask.
- **Errors and logs are built from routing facts.** A request body is never part
  of an error, a log event or a `cause`. Server messages are scrubbed of the
  value the request carried (raw, JSON-escaped, URL-encoded, base64, base64url and
  hex), and so are the parsed success bodies of secret writes, as defence in depth
  against a misbehaving server.
- **The runtime token is masked too.** `issue()` returns a `RuntimeToken`; log it
  and you get the mask. `takeOnce()` returns the text once for the code that
  configures the agent runtime. This is an enrollment credential, not a vault
  secret value.
- **No read-back.** There is no method, property or option that returns a
  stored value, in any form, and a test fails the build if an exported name
  suggests one.

Use one copy of the package: a `Sensitive` built by another copy of it (for
example the CommonJS build loaded next to the ES module build) is not recognized
and is refused with `sensitive_required`.

What this does not protect against: a compromised process (it holds the
`Sensitive` before sending), a core dump or heap snapshot of that process, and a
caller that copies the original string somewhere else before wrapping it.

## Server version

The following operations need an Agenomic Cloud version that includes them. On a
server that predates them the call fails with an ordinary typed error (most
likely `VaultNotFoundError`) and nothing is executed:

- rotations: `vault.secrets.rotate`, `vault.rotations.list`, `get`, `activate`,
  `rollback`
- revocation follow-up: `vault.revocations.retry`, `vault.revocations.lift`
- settlement of an unknown outcome: `vault.executions.resolve`
- delegation: `vault.runtime.grants.delegate`

The new fields `parent_grant_id` and `depth` on a grant and `next_attempt_at`,
`last_error`, `lifted_at`, `lifted_by` and `lift_reason` on a revocation are
optional in the SDK types for the same reason.

## Not supported

- **Reading a secret value**, in any form. There is no such endpoint and no such
  method, by design.
- **Verifying a receipt's signature locally.** `vault.receipts.list` returns the
  receipt `body` as the server sent it; the contract defines no public key or
  verification procedure for the SDK to apply.
- **Deciding entitlement.** The SDK relays the server's lock state; plans and
  quotas come from your contract and the cloud.
- **Live replay, and replay of admin operations.**
- **Customer-hosted executors and licences.** Only the control-plane API is
  covered; the executor and its licence are run and configured on the server side.
- **Strong machine identity.** Runtime tokens are bearer enrollment tokens;
  mTLS and SPIFFE are not available.
- **Pagination.** The list routes do not paginate. `limit` is available on
  executions and receipts, and the SDK exposes the filters the server accepts on
  each list (they are not all spelled out in the OpenAPI document).
- **Streaming and cancellation of an execution.** `deadlineMs` bounds the
  server-side time; there is no abort signal, because aborting after sending
  would only produce an unknown outcome.
- **Anything outside the `/v1/vault/*` contract**, including the executor's
  internal redeem route.
