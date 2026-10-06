import { readFile } from "node:fs/promises";

import { bindingError, integrityError } from "./errors";
import {
  ARTIFACT_SET_SCHEMA,
  MANIFEST_SCHEMA,
  ajsViolation,
  contentDigest,
  deepFreeze,
  isPlainRecord,
  jsonCopy,
  manifestDigest,
  promptDigest,
  sortedKeys,
} from "./prompt-digest";
import { buildPromptVersion, type ManagedPromptVersion, type PromptKind, type PromptVersionRecord } from "./prompt-template";

const BUNDLE_SCHEMA = "agenomic.prompt_bundle/v1";

const TIMESTAMP = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/;
const REQUIRED_MEMBERS: ReadonlyArray<readonly [string, "string" | "object"]> = [
  ["workspace_id", "string"],
  ["agent_id", "string"],
  ["source", "object"],
  ["release", "object"],
  ["prompt_manifest_digest", "string"],
  ["manifest", "object"],
  ["children", "object"],
  ["prompts", "object"],
  ["prompt_bundle_digest", "string"],
];

export interface PromptBundleOptions {
  expectedBundleDigest: string;
  expectedWorkspaceId: string;
  expectedAgentId: string;
  expectedManifestDigest?: string;
  now?: Date;
}

export interface OnlineBundleOptions {
  expectedWorkspaceId: string;
  expectedAgentId: string;
  expectedManifestDigest?: string;
  now?: Date;
}

type Json = Record<string, unknown>;

interface Manifest extends Json {
  schema: string;
  agent_id: unknown;
  slots: Json;
  children: Json;
}

interface BundleDocument extends Json {
  workspace_id: string;
  agent_id: string;
  source: Json;
  release: Json;
  prompt_manifest_digest: string;
  manifest: Manifest;
  children: Record<string, Json & { manifest: Manifest; prompt_manifest_digest: string }>;
  prompts: Record<string, Json>;
  prompt_bundle_digest: string;
}

const hasOwn = (value: object, key: string): boolean => Object.hasOwn(value, key);

function incomplete(message: string, details: Record<string, unknown> = {}) {
  return integrityError("bundle_incomplete", message, details);
}

function shape(raw: unknown): BundleDocument {
  const found = ajsViolation(raw);
  if (found) throw incomplete("the bundle is outside the JSON subset", { reason: found.code, value_path: found.value_path });
  if (!isPlainRecord(raw)) throw incomplete("the bundle is not an object", { reason: "invalid_field_type" });
  if (raw.schema !== BUNDLE_SCHEMA) throw incomplete("unsupported bundle schema", { reason: "unsupported_schema" });
  for (const [member, kind] of REQUIRED_MEMBERS) {
    if (!hasOwn(raw, member)) throw incomplete(`missing member ${member}`, { reason: "missing_field", path: `/${member}` });
    const value = raw[member];
    const ok = kind === "string" ? typeof value === "string" : isPlainRecord(value);
    if (!ok) throw incomplete(`member ${member} has the wrong type`, { reason: "invalid_field_type", path: `/${member}` });
  }
  return deepFreeze(jsonCopy(raw)) as BundleDocument;
}

function parseTime(value: unknown): number {
  const match = typeof value === "string" ? TIMESTAMP.exec(value) : null;
  if (!match) throw incomplete("expires_at is not a timestamp", { reason: "invalid_field_type" });
  const [, year, month, day, hour, minute, second] = match.map(Number) as number[];
  const moment = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  if (Number.isNaN(moment) || `${new Date(moment).toISOString().slice(0, 19)}Z` !== value) {
    throw incomplete("expires_at is not a timestamp", { reason: "invalid_field_type" });
  }
  return moment;
}

function checkPrompts(document: BundleDocument): void {
  for (const ref of sortedKeys(document.prompts)) {
    const entry = document.prompts[ref];
    if (!isPlainRecord(entry) || !isPlainRecord(entry.content)) {
      throw incomplete(`prompt entry ${ref} is malformed`, { reason: "invalid_field_type" });
    }
    const actual = contentDigest(entry.content);
    if (actual !== entry.content_digest) {
      throw integrityError("prompt_digest_mismatch", `content digest of ${ref} does not match`, {
        ref,
        expected: entry.content_digest,
        actual,
      });
    }
  }
}

function checkArtifactSet(document: BundleDocument, expected: string | undefined): void {
  const actual = promptDigest({
    schema: ARTIFACT_SET_SCHEMA,
    prompt_manifest_digest: document.prompt_manifest_digest,
    manifest: document.manifest,
    children: document.children,
    prompts: document.prompts,
  });
  for (const pinned of [document.prompt_bundle_digest, expected]) {
    if (pinned !== undefined && actual !== pinned) {
      throw integrityError("prompt_digest_mismatch", "the prompt artifact set digest does not match", {
        document: "artifact_set",
        expected: pinned,
        actual,
      });
    }
  }
}

function manifestOk(manifest: unknown): manifest is Manifest {
  return (
    isPlainRecord(manifest) &&
    manifest.schema === MANIFEST_SCHEMA &&
    isPlainRecord(manifest.slots) &&
    isPlainRecord(manifest.children)
  );
}

function checkManifests(document: BundleDocument, expected: string | undefined): void {
  const manifests: Array<[string | null, unknown, unknown]> = [[null, document.manifest, document.prompt_manifest_digest]];
  for (const childId of sortedKeys(document.children)) {
    const child = document.children[childId];
    if (!isPlainRecord(child)) throw incomplete(`child ${childId} is malformed`, { reason: "invalid_field_type" });
    manifests.push([childId, child.manifest, child.prompt_manifest_digest]);
  }
  for (const [owner, manifest, pinned] of manifests) {
    if (!manifestOk(manifest)) throw incomplete("a manifest is malformed", { reason: "invalid_field_type" });
    const actual = manifestDigest(manifest);
    if (actual !== pinned) {
      throw integrityError("manifest_digest_mismatch", "a manifest digest does not match", {
        child_agent_id: owner,
        expected: pinned,
        actual,
      });
    }
  }
  if (expected !== undefined && expected !== document.prompt_manifest_digest) {
    throw integrityError("manifest_digest_mismatch", "the manifest digest differs from the expected digest", {
      expected,
      actual: document.prompt_manifest_digest,
    });
  }
}

function pinRef(pin: Json): string {
  return `${String(pin.prompt_id)}:${String(pin.version)}`;
}

function closureGaps(manifest: Manifest, prompts: Record<string, Json>): { wanted: Set<string>; missing: Set<string> } {
  const wanted = new Set<string>();
  const missing = new Set<string>();
  const pending: Json[] = Object.values(manifest.slots).filter(isPlainRecord);
  while (pending.length > 0) {
    const pin = pending.pop()!;
    const ref = pinRef(pin);
    const seen = wanted.has(ref);
    wanted.add(ref);
    const entry = hasOwn(prompts, ref) ? prompts[ref] : undefined;
    if (!isPlainRecord(entry) || entry.content_digest !== pin.content_digest) {
      missing.add(ref);
      continue;
    }
    if (seen) continue;
    const content = entry.content;
    const fragments = isPlainRecord(content) ? content.fragments : undefined;
    if (isPlainRecord(fragments)) pending.push(...Object.values(fragments).filter(isPlainRecord));
  }
  return { wanted, missing };
}

function checkClosure(document: BundleDocument): void {
  const prompts = document.prompts;
  const children = document.children;
  const wanted = new Set<string>();
  const missing = new Set<string>();
  const reached = new Set<string>();
  const pending: Manifest[] = [document.manifest];
  while (pending.length > 0) {
    const manifest = pending.pop()!;
    const gaps = closureGaps(manifest, prompts);
    for (const ref of gaps.wanted) wanted.add(ref);
    for (const ref of gaps.missing) missing.add(ref);
    for (const childId of Object.keys(manifest.children)) {
      const seen = reached.has(childId);
      reached.add(childId);
      const pin = manifest.children[childId];
      const child = hasOwn(children, childId) ? children[childId] : undefined;
      if (
        !isPlainRecord(pin) ||
        child === undefined ||
        child.release_id !== pin.release_id ||
        child.genome_version !== pin.genome_version ||
        child.manifest.agent_id !== childId
      ) {
        missing.add(childId);
        continue;
      }
      if (!seen) pending.push(child.manifest);
    }
  }
  const extra = new Set<string>();
  for (const ref of Object.keys(prompts)) {
    const entry = prompts[ref]!;
    if (!wanted.has(ref) || ref !== pinRef(entry)) extra.add(ref);
  }
  for (const childId of Object.keys(children)) if (!reached.has(childId)) extra.add(childId);
  if (missing.size > 0 || extra.size > 0) {
    throw incomplete("the bundle closure is not exact", { missing: [...missing].sort(), extra: [...extra].sort() });
  }
}

function checkScope(document: BundleDocument, workspaceId: string, agentId: string): void {
  if (document.workspace_id !== workspaceId || document.agent_id !== agentId || document.manifest.agent_id !== agentId) {
    throw integrityError("bundle_scope_mismatch", "the bundle belongs to another workspace or agent");
  }
}

function verify(
  document: BundleDocument,
  workspaceId: string,
  agentId: string,
  expectedBundleDigest: string | undefined,
  expectedManifestDigest: string | undefined,
  now: Date | undefined,
): void {
  const expiresAt = document.expires_at;
  if (expiresAt !== undefined && expiresAt !== null) {
    if (parseTime(expiresAt) <= (now ?? new Date()).getTime()) {
      throw integrityError("bundle_expired", "the bundle has expired", { expires_at: expiresAt });
    }
  }
  checkPrompts(document);
  checkArtifactSet(document, expectedBundleDigest);
  checkManifests(document, expectedManifestDigest);
  checkClosure(document);
  checkScope(document, workspaceId, agentId);
}

export class PromptBundle {
  readonly signatureVerified = false as const;
  readonly #document: BundleDocument;
  readonly #signed: boolean;
  readonly #versions = new Map<string, ManagedPromptVersion>();

  private constructor(document: BundleDocument, signed: boolean) {
    this.#document = document;
    this.#signed = signed;
  }

  static fromDocument(document: unknown, options: PromptBundleOptions): PromptBundle {
    const shaped = shape(document);
    const signed = hasOwn(shaped, "signature");
    if (signed && (shaped.expires_at === undefined || shaped.expires_at === null)) {
      throw incomplete("a signed bundle carries no expires_at", { reason: "missing_field", path: "/expires_at" });
    }
    const expectedBundleDigest = options?.expectedBundleDigest;
    if (typeof expectedBundleDigest !== "string") {
      throw integrityError(
        "bundle_untrusted_key",
        "the bundle is not pinned by expectedBundleDigest; this SDK does not verify bundle signatures",
      );
    }
    verify(shaped, options.expectedWorkspaceId, options.expectedAgentId, expectedBundleDigest, options.expectedManifestDigest, options.now);
    return new PromptBundle(shaped, signed);
  }

  static fromOnlineResponse(document: unknown, options: OnlineBundleOptions): PromptBundle {
    const shaped = shape(document);
    if (hasOwn(shaped, "signature")) {
      throw integrityError("bundle_scope_mismatch", "a signed bundle is an offline artifact; load it with PromptBundle.fromDocument");
    }
    verify(shaped, options.expectedWorkspaceId, options.expectedAgentId, undefined, options.expectedManifestDigest, options.now);
    return new PromptBundle(shaped, false);
  }

  get document(): Readonly<Record<string, unknown>> {
    return this.#document;
  }

  get signed(): boolean {
    return this.#signed;
  }

  get workspaceId(): string {
    return this.#document.workspace_id;
  }

  get agentId(): string {
    return this.#document.agent_id;
  }

  get release(): Readonly<Record<string, unknown>> {
    return this.#document.release;
  }

  get releaseId(): string {
    return String(this.#document.release.release_id);
  }

  get source(): Readonly<Record<string, unknown>> {
    return this.#document.source;
  }

  get governance(): Readonly<Record<string, unknown>> | null {
    const governance = this.#document.governance;
    return isPlainRecord(governance) ? governance : null;
  }

  get promptManifestDigest(): string {
    return this.#document.prompt_manifest_digest;
  }

  get promptBundleDigest(): string {
    return this.#document.prompt_bundle_digest;
  }

  get promptRefs(): string[] {
    return sortedKeys(this.#document.prompts);
  }

  get childAgentIds(): string[] {
    return sortedKeys(this.#document.children);
  }

  get childManifestDigests(): Readonly<Record<string, string>> {
    const digests = Object.create(null) as Record<string, string>;
    for (const childId of Object.keys(this.#document.children)) {
      digests[childId] = this.#document.children[childId]!.prompt_manifest_digest;
    }
    return digests;
  }

  manifest(agentId?: string): Readonly<Record<string, unknown>> {
    if (agentId === undefined || agentId === this.agentId) return this.#document.manifest;
    const children = this.#document.children;
    if (!hasOwn(children, agentId)) {
      throw bindingError("child_agent_not_pinned", "the agent is not pinned by this bundle", { child_agent_id: agentId });
    }
    return children[agentId]!.manifest;
  }

  slots(agentId?: string): string[] {
    return sortedKeys((this.manifest(agentId) as Manifest).slots);
  }

  version(slotPath: string, options: { agentId?: string } = {}): ManagedPromptVersion {
    const manifest = this.manifest(options.agentId) as Manifest;
    const owner = String(manifest.agent_id);
    const key = `${owner}\u0000${slotPath}`;
    const cached = this.#versions.get(key);
    if (cached) return cached;
    const pin = hasOwn(manifest.slots, slotPath) ? manifest.slots[slotPath] : undefined;
    const record = isPlainRecord(pin) ? this.#record(String(pin.prompt_id), Number(pin.version)) : undefined;
    if (!record) {
      throw bindingError("slot_not_in_manifest", `slot ${slotPath} is not in the pinned manifest`, { slot_path: slotPath, agent_id: owner });
    }
    const version = buildPromptVersion(record, this.workspaceId, (promptId, number) => this.#record(promptId, number));
    this.#versions.set(key, version);
    return version;
  }

  #record(promptId: string, version: number): PromptVersionRecord | undefined {
    const ref = `${promptId}:${version}`;
    const prompts = this.#document.prompts;
    if (!hasOwn(prompts, ref)) return undefined;
    const entry = prompts[ref]!;
    return {
      prompt_id: entry.prompt_id as string,
      version: entry.version as number,
      prompt_kind: (entry.prompt_kind ?? null) as PromptKind | null,
      content_digest: entry.content_digest as string,
      content: entry.content,
    };
  }
}

export async function readPromptBundleFile(path: string, options: PromptBundleOptions): Promise<PromptBundle> {
  const text = await readFile(path, "utf8");
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw incomplete("the bundle file is not JSON", { reason: "invalid_json" });
  }
  return PromptBundle.fromDocument(document, options);
}
