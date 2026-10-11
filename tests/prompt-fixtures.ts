import { promptDigest } from "../src/index";

export const WORKSPACE = "0b6c2f1e-7a44-4c8e-9f1d-2a3b4c5d6e7f";
export const OTHER_WORKSPACE = "5a5a5a5a-1111-4222-8333-444455556666";
export const AGENT = "2b1e5c3a-8d4f-4e6a-9b0c-1d2e3f4a5b6c";
export const CHILD = "7f3c9a1e-0b2d-4c5e-8f6a-9b0c1d2e3f4a";
export const RELEASE = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
export const CHILD_RELEASE = "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70";
export const GENOME = `sha256:${"3".repeat(64)}`;

type Json = Record<string, unknown>;

export function textContent(body: string, extra: Partial<Json> = {}): Json {
  return {
    schema: "agenomic.prompt_content/v1",
    template_format: "agenomic-fstring/v1",
    renderer_version: "1",
    kind: "text",
    body,
    variables: {},
    partials: {},
    output_contract: null,
    fragments: {},
    ...extra,
  };
}

export const SAFETY = textContent("Never share internal notes.");

export const PLANNER = {
  ...textContent(""),
  kind: "chat",
  body: [
    { role: "system", content: "You plan for {customer} in a {tone} tone. {>safety}" },
    { placeholder: "history", optional: true },
    { role: "user", content: "{question}" },
  ],
  variables: {
    customer: { type: "string", required: true },
    history: { type: "messages", required: false },
    question: { type: "string", required: true },
    tone: { type: "string", required: false },
  },
  partials: { tone: "formal" },
  fragments: { safety: { prompt_id: "prm_safety", version: 2, content_digest: promptDigest(SAFETY) } },
};

export const WRITER = textContent("Write the reply to {question}.", {
  variables: { question: { type: "string", required: true } },
});

export function entry(promptId: string, version: number, promptKind: string, content: Json): Json {
  return { prompt_id: promptId, version, prompt_kind: promptKind, content_digest: promptDigest(content), content };
}

export function pin(promptId: string, version: number, content: Json): Json {
  return { prompt_id: promptId, version, content_digest: promptDigest(content) };
}

export function wireVersion(promptId: string, version: number, content: Json, workspace = WORKSPACE): Json {
  return {
    prompt_id: promptId,
    version,
    ref: `${promptId}:${version}`,
    canonical_uri: `agenomic://${workspace}/prompts/${promptId}/versions/${version}`,
    content_digest: promptDigest(content),
    content,
    parent_version: version > 1 ? version - 1 : null,
    change_message: "fixture",
    author: { user_id: null, api_key_id: "5d0b0e7c-3c1a-4b0e-9d77-1f2e3a4b5c6e" },
    created_at: "2026-10-04T20:40:00Z",
    variable_descriptions: {},
    provenance: { source: "api", draft_revision: null, import_id: null, item_id: null, source_file: null, source_line: null },
    fragment_closure: [],
  };
}

export function seal(document: Json): Json {
  const artifactSet = {
    schema: "agenomic.prompt_artifact_set/v1",
    prompt_manifest_digest: document.prompt_manifest_digest,
    manifest: document.manifest,
    children: document.children,
    prompts: document.prompts,
  };
  return { ...document, prompt_bundle_digest: promptDigest(artifactSet) };
}

export function bundleDocument(options: { workspace?: string; agent?: string; withChild?: boolean } = {}): Json {
  const agent = options.agent ?? AGENT;
  const withChild = options.withChild ?? true;
  const childManifest = {
    schema: "agenomic.prompt_manifest/v1",
    agent_id: CHILD,
    slots: { "writer.response": pin("prm_writer", 3, WRITER) },
    children: {},
  };
  const manifest = {
    schema: "agenomic.prompt_manifest/v1",
    agent_id: agent,
    slots: { "planner.instructions": pin("prm_planner", 7, PLANNER) },
    children: withChild ? { [CHILD]: { release_id: CHILD_RELEASE, genome_version: GENOME } } : {},
  };
  const prompts: Json = {
    "prm_planner:7": entry("prm_planner", 7, "chat", PLANNER),
    "prm_safety:2": entry("prm_safety", 2, "fragment", SAFETY),
  };
  if (withChild) prompts["prm_writer:3"] = entry("prm_writer", 3, "text", WRITER);
  return seal({
    schema: "agenomic.prompt_bundle/v1",
    workspace_id: options.workspace ?? WORKSPACE,
    agent_id: agent,
    source: { channel: "production", channel_generation: 12 },
    release: {
      release_id: RELEASE,
      release_name: "av_0042",
      genome_version: GENOME,
      bundle_id: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b",
      bundle_hash: `blake3:${"0f".repeat(32)}`,
      legacy: false,
    },
    prompt_manifest_digest: promptDigest(manifest),
    manifest,
    children: withChild
      ? {
          [CHILD]: {
            release_id: CHILD_RELEASE,
            genome_version: GENOME,
            prompt_manifest_digest: promptDigest(childManifest),
            manifest: childManifest,
          },
        }
      : {},
    prompts,
    exported_at: "2026-10-04T21:10:00Z",
    expires_at: null,
  });
}

export function signedDocument(expiresAt: string | null = "2026-11-03T21:10:00Z"): Json {
  return {
    ...bundleDocument(),
    governance: { release_status: "production", channel: "production", channel_protected: true, approved: true },
    expires_at: expiresAt,
    issuer: { key_id: "orgkey_2026_09", algorithm: "ed25519" },
    signature: { algorithm: "ed25519", value: "c2lnbmF0dXJl", public_key_pem: "not trusted" },
  };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
