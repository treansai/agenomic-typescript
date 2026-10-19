# Changelog

All notable changes to this package are documented in this file.

The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Protect P0 mirror: `client.protect.getSettings` and `updateSettings`
  (`protect_mandatory`), `client.protect.exemptions` (`list`, `create`,
  `lift`), the `organization` block on `coverage()`, `EffectiveProtection`
  on run reads (`protection`), and the invocation `phase` on invoke and
  `authorizeLocal` results.
- `ToolCallConflict`: a 409 on an unresolved attempt now raises a typed error
  with `reason` (`in_flight`, `ambiguous_outcome`, `already_recorded`) and the
  stored `invocation` status. It extends `ToolExecutionError` (code `conflict`).
- Model call admission (cooperative, protect runs only): `tools.authorizeModelCall`
  and `reportModelCall` with a typed `allow` / `pending` / `denied` decision, and
  `tools.guardModelCall` / `guardModelCall` which calls the provider only on
  allow and reports usage with the permit. The runtime declares tokens, cost,
  classification and host; the gateway neither sees the prompt nor observes the
  call, and the request type has no prompt field. `ModelCallDenied` and
  `ModelCallPending` are raised by the wrapper.
- Invocation reads and reconciliation: `tools.getInvocation` and
  `tools.resolveInvocation` (`succeeded`, `failed`, `not_executed`, with evidence).
- Action families and delegation: `ActionFamily`, `RiskTier`, `SimulateIntent`
  (families, family tiers, delegation chain), `ProtectRunConfig.delegation_id`,
  and `protect.delegations.issue` / `get`. A run is attenuated only when it
  declares `delegation_id`.
- Correction loop client `client.correction` (`incidents`, `candidates`,
  `getSettings`, `updateSettings`, `sweep`) over `/v1/correction`.

### Changed

- `ToolCallConflict` now covers the second 409 form: another attempt of the same
  logical call is unresolved (`error.code` `attempt_in_flight` or
  `ambiguous_outcome`, no reason, no `agenomic` block). `invocation` is optional,
  `reason` may be `attempt_in_flight`, `code` equals the reason for that form,
  and `otherAttempt` tells the two forms apart. This raised a plain
  `ToolExecutionError` before.
- `SimulateRequest.intents` is typed as `SimulateIntent[]` (still open to other keys).

## [0.1.4] - 2026-10-06

### Added

- Knowledge bases (Agenomic Cloud only, guide in `docs/knowledge.md`):
  `client.knowledge` (`KnowledgeClient`) with `list`, `get`,
  `listDocuments`, `getDocument`, `createDocument`, `uploadDocument` (raw
  bytes from a `Uint8Array`, an `ArrayBuffer` or a string), `getSection`,
  `search`, `query` (text form or operation), `answer`, `listVersions`,
  `getVersion`, `diffVersions`, `publish` and `rollback` with `ifMatch`,
  `getAgentKnowledge`, `putAgentKnowledge`, `agentSearch` with an execution
  context, `getJob` and `waitForJob`. Wire types are the snake_case
  contract types; versions are given as `3`, `"3"`, `"v3"`, `"published"`
  or `"draft"` (`normalizeVersion`).
- `client.knowledge.knowledgeBase(kbId)` returns a handle with `search`,
  `getDocument` and `getSection`, which resolves a heading through the
  structured query route and keeps only sections of the requested document.
- `knowledgeTool({ client, knowledgeBase, version, topK })` returns a plain
  tool definition (`name`, `description`, JSON schema `parameters`,
  `execute`) that returns the delimited evidence rendered by the gateway and
  a citation list, with agent-scoped retrieval when `agentId` is given.
- `knowledge.retrieve` joins `TrackingEventType`.
- `fetchRaw` sends a raw request body through the same transport as
  `fetchJson`.

## [0.1.4] - 2026-10-06

### Added

- Managed prompts, the minimal TypeScript surface of RFC 0012 of
  agenomic-spec. Its conformance vectors are vendored under
  `tests/fixtures/spec-vectors/` and every vector whose consumers include
  `typescript` runs in the test suite. The guide is `docs/prompts.md`.
- Prompt references: `parsePromptRef`, `parseExecutionRef` and
  `formatPromptRef` for `prm_x:7`, `prm_x@alias` and
  `agenomic://<workspace>/prompts/prm_x/versions/7`. An execution
  reference to a bare prompt id is refused with `prompt_ref_unversioned`:
  there is no implicit latest version.
- Local rendering of `agenomic.prompt_content/v1` documents with the strict
  `agenomic-fstring/v1` templates: `renderText`, `renderMessages`, `compose`,
  `renderContent` and `validateContent`. A missing variable, a type mismatch
  or an invalid template fails before any model call, and variables may be
  passed as a `Map`.
- Canonical JSON and digests (`canonicalJsonV1`, `promptDigest`,
  `contentDigest`, `manifestDigest`, `ensureAjs`) and the
  `agenomic-secrets/1` helpers (`scanSecrets`, `scrubSecrets`,
  `scrubSecretsJson`, `isSecretShapedKey`).
- `client.prompts` with `get`, `resolve`, `resolveAgent` and `workspaceId`.
  Every downloaded prompt and fragment is verified by digest before it is
  returned, verified versions are cached in memory, and an alias is
  resolved again on every call.
- `client.bindings` with `create` and `get`, which pin a thread or an
  execution to one agent release, and `threadKey` and `executionKey`,
  which hash application ids into the same keys as the Python SDK.
  `create` is create-or-get on the thread key and sends no
  `Idempotency-Key`. An API key binds only a release that is approved, in
  production, or the current target of one of the agent's channels.
- `PromptBundle` and `readPromptBundleFile` for offline prompt bundles. A
  bundle loads only when pinned by `expectedBundleDigest`,
  `expectedWorkspaceId` and `expectedAgentId`; an unpinned document is
  refused with `bundle_untrusted_key`. This SDK does not verify bundle
  signatures, so `signatureVerified` is always `false`.
- `ApiError` and its subclasses `PromptRefError`, `PromptTemplateError`,
  `PromptRenderError`, `PromptIntegrityError` and `PromptBindingError`,
  carrying the server `code`, `status` and `details`.
- `examples/prompts-render.ts`, which loads a pinned bundle and renders a
  slot without network access.

### Changed

- `JsonExchange`, returned by `fetchJson`, gains an optional `headers`
  member holding the response headers. Code that builds a `JsonExchange`
  itself keeps compiling.
