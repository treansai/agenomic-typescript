# Managed prompts

The TypeScript SDK reads versioned prompts from the Agenomic prompt registry,
verifies them by digest and renders them locally. A prompt version never
changes once published, so a run can always say which prompt text it used.

The contract is RFC 0012 of `agenomic-spec`. Its conformance vectors are
vendored under `tests/fixtures/spec-vectors/` and run by the test suite, so
references, digests, rendering and bundle verification give the same answers
here as in the Python SDK, the `agm` CLI and Agenomic Cloud.

This package has the minimal surface: references, rendering, digests,
`client.prompts` (get, resolve, agent resolution), `client.bindings` and
offline bundle reading. Publishing, drafts, aliases, channels, experiments and
the LangGraph adapter live in the Python SDK.

## Concepts

- **Version.** One immutable content document, `prm_support_planner:7`,
  identified by its `sha256:` content digest.
- **Alias.** A mutable name for a version, `prm_support_planner@staging`,
  resolved to a version on every call.
- **Fragment.** Reusable template text included with `{>name}` and pinned by
  prompt id, version and digest.
- **Release manifest.** The prompt pins of one agent version: each slot path
  (`planner.instructions`) names one prompt version; child agents are pinned
  by release.
- **Execution binding.** The pin of one thread, or one execution, to one
  release. The first writer wins: a thread keeps its release even after the
  channel moves.
- **Bundle.** The exact prompt closure of one release as a JSON document,
  returned online with a binding or exported for offline use.

## References

```ts
import { formatPromptRef, parseExecutionRef, parsePromptRef } from "@treansai/agenomic-typescript";

parseExecutionRef("prm_support_planner:7");
parseExecutionRef("prm_support_planner@staging");
parseExecutionRef("agenomic://0b6c2f1e-7a44-4c8e-9f1d-2a3b4c5d6e7f/prompts/prm_support_planner/versions/7");
parsePromptRef("prm_support_planner", { allowBareId: true });
formatPromptRef({ form: "version", promptId: "prm_support_planner", version: 7 });
```

- A prompt id matches `^prm_[a-z0-9]+(?:[_-][a-z0-9]+)*$` (at most 64
  characters), a version is a decimal from 1 to 2147483647 without leading
  zeros, and an alias matches `^[a-z][a-z0-9_-]{0,31}$`.
- `parseExecutionRef` refuses a bare prompt id with `prompt_ref_unversioned`:
  there is no implicit latest version.
- A malformed reference raises `PromptRefError("prompt_ref_invalid")` and
  `error.reason` says which check failed first (`whitespace`, `uppercase`,
  `invalid_version`, `mixed_form` and so on).
- A URI naming another workspace raises `prompt_ref_cross_workspace` and is
  never sent to the registry.

## Rendering

Rendering is local and synchronous. It fails before any model call.

```ts
import { renderMessages, renderText, compose } from "@treansai/agenomic-typescript";

const messages = renderMessages(version, { customer: "Ada", question: "Where is my parcel?" });
const text = renderText(textVersion, { question: "Where is my parcel?" });
const withHistory = compose(versionWithoutPlaceholder, { question: "Next?" }, history);
```

- Templates use `agenomic-fstring/v1`: `{name}` substitutes a variable,
  `{{` and `}}` are literal braces, `{>name}` includes a pinned fragment.
  Format specs, conversions, attribute access and indexing are refused.
- Values are typed: `string` renders verbatim, `integer` in decimal,
  `boolean` as `true` or `false`, `json` as canonical JSON. Numbers must be
  integers within plus or minus 2^53 - 1 (`float_not_allowed`,
  `integer_out_of_range`).
- A caller value overrides a partial. In strict mode (the default) an
  undeclared variable is refused with `unknown_variable`; with
  `{ strict: false }` it is dropped with the warning `strict_disabled`.
- History reaches a chat prompt through its `messages` placeholder, or through
  `compose` when the prompt has none. Using both is refused
  (`history_conflict`). Placeholder and history items are passed through
  unchanged.
- `renderText` on a chat prompt and `renderMessages` on a text prompt raise
  `kind_mismatch`; neither flattens one kind into the other.
- `renderMessages` and `compose` accept `secretPolicy: "error"`, which refuses
  a `string` value, or a string inside a `json` value, that matches a secret
  pattern (`secret_in_variables`).
- Variables may be a plain object or a `Map`. Names such as `__proto__` or
  `constructor` are ordinary names: pass them in a `Map`, or in an object
  built with `JSON.parse` or `Object.fromEntries`.

Every render failure is a `PromptRenderError` with `code`
`prompt_render_error`, `status` 0 and `details.reason` set to the first
failure (`missing_variable`, `type_mismatch`, `fragment_not_found` and so on).
Errors name variables and paths, never values.

`renderContent(content, variables, fragments, options)` renders a raw
`agenomic.prompt_content/v1` document with a fragment source, and
`validateContent` returns the full validation report of one.

## Agenomic Cloud

```ts
import { AgenomicClient } from "@treansai/agenomic-typescript";

const client = new AgenomicClient({ apiKey: process.env.AGENOMIC_API_KEY, baseUrl: "https://agenomic.example" });
const workspaceId = await client.prompts.workspaceId();
```

The first call reads `GET /v1/whoami` once per client to learn the workspace.
Run production agents with a `read` key: it reads, resolves and creates
execution bindings. An API key binds or resolves only a release that is
approved, in production, or the current target of one of the agent's
channels; any other release gets 403 `session_required`.

### Reading prompts

```ts
const version = await client.prompts.get("prm_support_planner:7");
const staged = await client.prompts.resolve("prm_support_planner@staging");
console.log(staged.resolvedFrom);
```

- `get` fetches the version with its fragment closure, verifies every content
  digest and validates the content before returning it. A mismatch raises
  `PromptIntegrityError("prompt_digest_mismatch")`; nothing is repaired.
- Verified versions are kept in memory per resource, keyed by workspace,
  prompt id and version.
- An alias is resolved again on every call and its target is never cached.
  The result carries `resolvedFrom: { alias, generation }`. Keep the returned
  version for the whole run rather than resolving the alias again.

### Agent resolution and execution bindings

```ts
import { threadKey } from "@treansai/agenomic-typescript";

const bundle = await client.prompts.resolveAgent({ agentId, channel: "production" });

const { binding, artifacts, created } = await client.bindings.create({
  agentId,
  threadKey: threadKey(workspaceId, conversationId),
  scope: "thread",
  channel: "production",
});
const system = renderMessages(artifacts.version("planner.instructions"), variables);

const again = await client.bindings.get(agentId, binding.binding_id);
```

- `threadKey(workspaceId, threadId)` and `executionKey(workspaceId, id)`
  hash application ids so that no raw id reaches the registry. They give the
  same keys as the Python SDK.
- `create` is create-or-get on the thread key: a retry returns the same
  binding with `created: false`. No idempotency header is sent.
- Name exactly one of `channel` and `releaseId`. `expectManifestDigest`
  makes the registry refuse a binding pinned to another manifest.
- The artifacts are checked against the binding: workspace, agent, release,
  manifest digest and every child manifest digest.

## Offline bundles

```ts
import { readPromptBundleFile, renderMessages } from "@treansai/agenomic-typescript";

const bundle = await readPromptBundleFile("prompt-bundle.json", {
  expectedBundleDigest: "sha256:...",
  expectedWorkspaceId: "0b6c2f1e-7a44-4c8e-9f1d-2a3b4c5d6e7f",
  expectedAgentId: "2b1e5c3a-8d4f-4e6a-9b0c-1d2e3f4a5b6c",
});
const messages = renderMessages(bundle.version("planner.instructions"), variables);
const child = bundle.version("writer.response", { agentId: childAgentId });
```

This SDK does not verify bundle signatures: `bundle.signatureVerified` is
always `false`. A bundle loads only when it is pinned by
`expectedBundleDigest`, the `prompt_bundle_digest` of the export. Verify the
signed export once with a tool that checks signatures (for example
`agenomic-py prompts bundle-verify`, which prints the digest), then deploy the
digest with the file. A document without a pin is refused with
`bundle_untrusted_key`; there is no way to load an unverified bundle.

`PromptBundle.fromDocument` (and `readPromptBundleFile`) refuse the bundle at
the first failed step:

1. the document is in the Agenomic JSON subset and has the bundle schema
   (`bundle_incomplete`);
2. it is pinned by `expectedBundleDigest` (`bundle_untrusted_key`);
3. a signed export carries an `expires_at` that has not passed
   (`bundle_incomplete`, `bundle_expired`);
4. every prompt matches its content digest, and the whole artifact set
   matches the embedded digest and the pin (`prompt_digest_mismatch`);
5. every manifest matches its digest, and `expectedManifestDigest` when given
   (`manifest_digest_mismatch`);
6. the closure is exact: every slot, fragment and child is present, and
   nothing else (`bundle_incomplete` with `details.missing` and
   `details.extra`);
7. the bundle belongs to `expectedWorkspaceId` and `expectedAgentId`
   (`bundle_scope_mismatch`).

Pin the bundle digest rather than the manifest digest alone: only the bundle
digest covers child agents and their prompts. A slot that is not in the
manifest raises `slot_not_in_manifest`; the SDK never falls back to the
network or to an inline string. Online answers go through
`PromptBundle.fromOnlineResponse`, which refuses a signed document.

Offline limits: a disconnected process cannot learn that a release or a
channel was revoked, and a bundle stays usable until its `expires_at` or
until the operator removes it.

`examples/prompts-render.ts` writes a demo bundle, loads it with its pin and
renders a slot. Run it after `pnpm build`:

```bash
node --experimental-strip-types examples/prompts-render.ts
node --experimental-strip-types examples/prompts-render.ts bundle.json sha256:... <workspace_id> <agent_id> planner.instructions '{"customer":"Ada","question":"Hi"}'
```

## Digests and secrets

- `canonicalJsonV1` writes canonical JSON (keys sorted by UTF-16 code units,
  no whitespace, integers only) and `promptDigest` is `sha256:` plus the hex
  sha256 of it. `contentDigest` and `manifestDigest` apply it to content and
  manifest documents. `ensureAjs` raises on a value outside the JSON subset.
- `scanSecrets`, `scrubSecrets`, `scrubSecretsJson` and `isSecretShapedKey`
  implement the `agenomic-secrets/1` patterns. Findings carry the pattern id,
  offset and length, never the matched text.

## Errors

Every error of `client.prompts` and `client.bindings` is an `ApiError` with
`code`, `status` (0 when raised locally) and `details`. Registry errors keep
their code, status and `details`, plus `request_id` (`error.requestId`).

| Class | Codes |
|---|---|
| `PromptRefError` | `prompt_ref_invalid`, `prompt_ref_unversioned`, `prompt_ref_cross_workspace`, `workspace_mismatch` |
| `PromptTemplateError` | `prompt_template_invalid`, `prompt_secret_detected`, `prompt_content_too_large`, `prompt_kind_mismatch`, `prompt_fragment_cycle`, `prompt_fragment_depth_exceeded` |
| `PromptRenderError` | `prompt_render_error` |
| `PromptIntegrityError` | `prompt_digest_mismatch`, `manifest_digest_mismatch`, `bundle_untrusted_key`, `bundle_incomplete`, `bundle_expired`, `bundle_scope_mismatch`, `artifact_integrity_error` |
| `PromptBindingError` | `binding_mismatch`, `slot_not_in_manifest`, `child_agent_not_pinned`, `execution_binding_conflict`, `child_agent_conflict`, `release_not_bindable`, `session_required` |
| `ApiError` | every other code, `http_error` for a non-JSON error body, `invalid_response`, `transport_error`, `cloud_required` |

## Conformance vectors

`scripts/sync-spec-vectors.sh <spec-commit> [<agenomic-spec checkout>]`
copies `conformance/vectors/prompts/` from `agenomic-spec` and rewrites
`tests/fixtures/spec-vectors/SPEC_VECTORS.lock`. The test
`tests/prompts-conformance.test.ts` checks the lock and the manifest, then runs
every vector whose consumers include `typescript`.
