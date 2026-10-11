import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  promptDigest,
  readPromptBundleFile,
  renderMessages,
  renderText,
  type PromptBundleOptions,
} from "../dist/index.js";

const DEMO_WORKSPACE = "0b6c2f1e-7a44-4c8e-9f1d-2a3b4c5d6e7f";
const DEMO_AGENT = "2b1e5c3a-8d4f-4e6a-9b0c-1d2e3f4a5b6c";

function content(kind: "text" | "chat", body: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "agenomic.prompt_content/v1",
    template_format: "agenomic-fstring/v1",
    renderer_version: "1",
    kind,
    body,
    variables: {},
    partials: {},
    output_contract: null,
    fragments: {},
    ...extra,
  };
}

function entry(promptId: string, version: number, promptKind: string, document: Record<string, unknown>): Record<string, unknown> {
  return { prompt_id: promptId, version, prompt_kind: promptKind, content_digest: promptDigest(document), content: document };
}

function demoBundle(): Record<string, unknown> {
  const safety = content("text", "Never share internal notes.");
  const planner = content(
    "chat",
    [
      { role: "system", content: "You plan support work for {customer}. {>safety}" },
      { placeholder: "history", optional: true },
      { role: "user", content: "{question}" },
    ],
    {
      variables: {
        customer: { type: "string", required: true },
        history: { type: "messages", required: false },
        question: { type: "string", required: true },
      },
      fragments: { safety: { prompt_id: "prm_safety", version: 2, content_digest: promptDigest(safety) } },
    },
  );
  const manifest = {
    schema: "agenomic.prompt_manifest/v1",
    agent_id: DEMO_AGENT,
    slots: { "planner.instructions": { prompt_id: "prm_planner", version: 7, content_digest: promptDigest(planner) } },
    children: {},
  };
  const prompts = {
    "prm_planner:7": entry("prm_planner", 7, "chat", planner),
    "prm_safety:2": entry("prm_safety", 2, "fragment", safety),
  };
  const promptManifestDigest = promptDigest(manifest);
  return {
    schema: "agenomic.prompt_bundle/v1",
    workspace_id: DEMO_WORKSPACE,
    agent_id: DEMO_AGENT,
    source: { channel: "production", channel_generation: 1 },
    release: {
      release_id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      release_name: "av_0001",
      genome_version: null,
      bundle_id: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b",
      bundle_hash: `blake3:${"0".repeat(64)}`,
      legacy: false,
    },
    prompt_manifest_digest: promptManifestDigest,
    manifest,
    children: {},
    prompts,
    prompt_bundle_digest: promptDigest({
      schema: "agenomic.prompt_artifact_set/v1",
      prompt_manifest_digest: promptManifestDigest,
      manifest,
      children: {},
      prompts,
    }),
    exported_at: "2026-10-05T00:00:00Z",
    expires_at: null,
  };
}

async function main(): Promise<void> {
  const [file, digest, workspaceId, agentId, slot, variablesJson] = process.argv.slice(2);
  let path: string;
  let options: PromptBundleOptions;
  if (file === undefined) {
    const document = demoBundle();
    path = join(mkdtempSync(join(tmpdir(), "agenomic-prompts-")), "bundle.json");
    writeFileSync(path, JSON.stringify(document, null, 2));
    options = {
      expectedBundleDigest: document.prompt_bundle_digest as string,
      expectedWorkspaceId: DEMO_WORKSPACE,
      expectedAgentId: DEMO_AGENT,
    };
    console.log(`demo bundle written to ${path}`);
  } else {
    if (digest === undefined || workspaceId === undefined || agentId === undefined) {
      console.error("usage: prompts-render.ts [bundle.json prompt_bundle_digest workspace_id agent_id [slot_path [variables_json]]]");
      process.exitCode = 2;
      return;
    }
    path = file;
    options = { expectedBundleDigest: digest, expectedWorkspaceId: workspaceId, expectedAgentId: agentId };
  }
  const bundle = await readPromptBundleFile(path, options);
  const slotPath = slot ?? "planner.instructions";
  const version = bundle.version(slotPath);
  const variables = variablesJson
    ? (JSON.parse(variablesJson) as Record<string, unknown>)
    : { customer: "Ada", question: "Where is my parcel?" };
  console.log(`bundle ${bundle.promptBundleDigest}`);
  console.log(`slot ${slotPath} -> ${version.ref.promptId}:${version.ref.version} (${version.contentDigest})`);
  if (version.kind === "chat") {
    console.log(JSON.stringify(renderMessages(version, variables), null, 2));
  } else {
    console.log(renderText(version, variables));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
