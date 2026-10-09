# Changelog

All notable changes to this package are documented in this file.

The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
