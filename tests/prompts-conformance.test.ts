import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ApiError,
  PromptBundle,
  assertValidContent,
  canonicalJsonV1,
  isSecretShapedKey,
  parseExecutionRef,
  parsePromptRef,
  promptDigest,
  renderContent,
  scanSecrets,
  scrubSecrets,
  scrubSecretsJson,
  templateSource,
  tokenizeTemplate,
  validateContent,
  type FragmentSource,
  type PromptReference,
} from "../src/index";
import { ajsViolation } from "../src/prompt-digest";

const VECTORS = join(__dirname, "fixtures", "spec-vectors");
const CONSUMER = "typescript";
const SUITES = ["render", "template", "digest", "ref", "secrets", "prompts-file-yaml"];
const LOCAL_FILES = new Set(["MANIFEST.json", "SPEC_VECTORS.lock"]);
const EXPECTED_COUNTS = { render: 66, template: 69, digest: 28, ref: 54, secrets: 14, "prompts-file-yaml": 0 };

type Json = Record<string, unknown>;

interface Vector {
  schema: string;
  suite: string;
  id: string;
  consumers: string[];
  input: Json;
  expected: Json;
}

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function load(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function vectorFiles(): string[] {
  return walk(VECTORS)
    .filter((path) => path.endsWith(".json") && relative(VECTORS, path).includes("/"))
    .sort();
}

function typescriptVectors(): Vector[] {
  return vectorFiles()
    .map((path) => load(path) as Vector)
    .filter((vector) => vector.consumers.includes(CONSUMER));
}

function own(value: Json, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function subset(expected: unknown, actual: unknown): boolean {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.keys(expected).every(
      (key) => Object.hasOwn(actual, key) && subset((expected as Json)[key], (actual as Json)[key]),
    );
  }
  try {
    expect(actual).toStrictEqual(expected);
    return true;
  } catch {
    return false;
  }
}

function assertMatches(id: string, expected: Json, actual: Json): void {
  expect(actual.ok, id).toBe(expected.ok);
  if (!expected.ok) {
    const want = expected.error as Json;
    const got = actual.error as Json;
    for (const key of Object.keys(want)) {
      if (key === "item" || key === "details") {
        expect(subset(want[key], got[key]), `${id} ${key} ${JSON.stringify(got[key])}`).toBe(true);
      } else {
        expect(got[key], `${id} ${key}`).toStrictEqual(want[key]);
      }
    }
    return;
  }
  for (const key of Object.keys(expected)) {
    if (key === "ok" || key === "langchain_parity") continue;
    if (key === "warnings") {
      const want = expected.warnings as unknown[];
      const got = actual.warnings as unknown[];
      expect(got.length, `${id} warnings ${JSON.stringify(got)}`).toBe(want.length);
      want.forEach((item, index) => expect(subset(item, got[index]), `${id} warning ${index}`).toBe(true));
      continue;
    }
    expect(actual[key], `${id} ${key}`).toStrictEqual(expected[key]);
  }
}

function fragmentSource(fragments: Json): FragmentSource {
  return (promptId, version) => {
    const entry = own(fragments, `${promptId}:${version}`);
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const record = entry as Json;
    return { promptKind: own(record, "prompt_kind") as "fragment" | undefined, content: own(record, "content") };
  };
}

function failure(error: unknown, member: "item" | "details"): Json {
  if (!(error instanceof ApiError)) throw error;
  const errors = error.details.errors as unknown[] | undefined;
  return { ok: false, error: { code: error.code, [member]: member === "item" ? errors?.[0] : error.details } };
}

function runRender(input: Json): Json {
  const options = input.options as Json;
  const method = input.method as string;
  try {
    const result = renderContent(input.content, input.variables as Json, fragmentSource(input.fragments as Json), {
      strict: options.strict as boolean,
      history: options.history as unknown[] | null,
      allowDuplicateSystem: options.allow_duplicate_system as boolean,
      secretPolicy: options.secret_policy as "off" | "error",
      expectKind: method === "text" ? "text" : method === "messages" ? "chat" : undefined,
    });
    return {
      ok: true,
      kind: result.kind,
      text: result.text,
      messages: result.messages,
      expanded_template: result.expandedTemplate,
      rendered_document: result.renderedDocument,
      rendered_hash: result.renderedHash,
      warnings: result.warnings,
    };
  } catch (error) {
    return failure(error, "item");
  }
}

function runTemplate(input: Json): Json {
  if (Object.hasOwn(input, "template")) {
    try {
      const tokens = tokenizeTemplate(input.template as string);
      return { ok: true, tokens, source: templateSource(tokens) };
    } catch (error) {
      return failure(error, "item");
    }
  }
  const report = validateContent(input.content, fragmentSource(input.fragments as Json));
  try {
    assertValidContent(report);
  } catch (error) {
    return failure(error, "item");
  }
  return {
    ok: true,
    validation: { variables: report.variables, warnings: report.warnings, content_digest: report.contentDigest },
  };
}

function runDigest(input: Json): Json {
  if (input.operation === "bundle_load") {
    try {
      const bundle = PromptBundle.fromDocument(input.bundle, {
        expectedBundleDigest: input.expected_bundle_digest as string,
        expectedWorkspaceId: input.expected_workspace_id as string,
        expectedAgentId: input.expected_agent_id as string,
        now: new Date(Date.UTC(2026, 9, 5)),
      });
      return {
        ok: true,
        prompt_bundle_digest: bundle.promptBundleDigest,
        prompt_manifest_digest: bundle.promptManifestDigest,
        prompt_refs: bundle.promptRefs,
        managed_slots: bundle.slots(),
      };
    } catch (error) {
      return failure(error, "details");
    }
  }
  const document = input.document;
  const violation = ajsViolation(document);
  if (violation) {
    expect(() => canonicalJsonV1(document)).toThrow(ApiError);
    return { ok: false, error: { item: { code: violation.code, value_path: violation.value_path } } };
  }
  const canonical = canonicalJsonV1(document);
  const digest = promptDigest(document);
  const projection = input.projection as Json | undefined;
  if (projection !== undefined) {
    const origin = projection.from as Json;
    if (projection.rule === "content") {
      expect(origin.content).toStrictEqual(document);
      expect(origin.content_digest).toBe(digest);
    } else {
      const { plan_digest: planDigest, ...rest } = origin;
      expect(rest).toStrictEqual(document);
      expect(planDigest).toBe(digest);
    }
  }
  return { ok: true, document_type: (document as Json).schema, canonical, digest };
}

function refResult(ref: PromptReference | string, workspaceId: string | null): Json {
  if (typeof ref === "string") {
    return { ok: true, form: "prompt_id", prompt_id: ref, version: null, alias: null, workspace_id: null, canonical: ref, version_ref: null };
  }
  if (ref.form === "uri") {
    return {
      ok: true,
      form: "uri",
      prompt_id: ref.promptId,
      version: ref.version,
      alias: null,
      workspace_id: ref.workspaceId,
      canonical: `agenomic://${ref.workspaceId}/prompts/${ref.promptId}/versions/${ref.version}`,
      version_ref: workspaceId === ref.workspaceId ? `${ref.promptId}:${ref.version}` : null,
    };
  }
  if (ref.form === "version") {
    const canonical = `${ref.promptId}:${ref.version}`;
    return { ok: true, form: "version", prompt_id: ref.promptId, version: ref.version, alias: null, workspace_id: null, canonical, version_ref: canonical };
  }
  return {
    ok: true,
    form: "alias",
    prompt_id: ref.promptId,
    version: null,
    alias: ref.alias,
    workspace_id: null,
    canonical: `${ref.promptId}@${ref.alias}`,
    version_ref: null,
  };
}

function runRef(input: Json): Json {
  const workspaceId = input.workspace_id as string | null;
  try {
    const ref =
      input.context === "management"
        ? parsePromptRef(input.ref as string, { workspaceId, allowBareId: true })
        : parseExecutionRef(input.ref as string, { workspaceId });
    return refResult(ref, workspaceId);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { ok: false, error: { code: error.code, ...(error.reason !== undefined ? { reason: error.reason } : {}) } };
  }
}

function runSecrets(input: Json): Json {
  if (input.operation === "scan") {
    const text = input.text as string;
    return { ok: true, findings: scanSecrets(text), scrubbed: scrubSecrets(text) };
  }
  if (input.operation === "secret_shaped") {
    return { ok: true, secret_shaped: (input.keys as string[]).map((key) => isSecretShapedKey(key)) };
  }
  return { ok: true, scrubbed: scrubSecretsJson(input.value) };
}

const RUNNERS: Record<string, (input: Json) => Json> = {
  render: runRender,
  template: runTemplate,
  digest: runDigest,
  ref: runRef,
  secrets: runSecrets,
};

describe("vendored SPEC vectors", () => {
  it("the lock pins the manifest bytes", () => {
    const lock = load(join(VECTORS, "SPEC_VECTORS.lock")) as Json;
    expect(Object.keys(lock).sort()).toEqual(["manifest_sha256", "spec_commit"]);
    expect(lock.spec_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(lock.manifest_sha256).toBe(sha256(join(VECTORS, "MANIFEST.json")));
  });

  it("the vendored file set and hashes equal the manifest", () => {
    const manifest = load(join(VECTORS, "MANIFEST.json")) as Json;
    expect(manifest.renderer_version).toBe("1");
    expect(manifest.secret_patterns).toBe("agenomic-secrets/1");
    const vendored: Json = {};
    for (const path of walk(VECTORS)) {
      const name = relative(VECTORS, path).split("\\").join("/");
      if (!LOCAL_FILES.has(name)) vendored[name] = sha256(path);
    }
    expect(vendored).toEqual(manifest.files);
  });

  it("every directory is a known suite and every file matches its id and suite", () => {
    const directories = readdirSync(VECTORS).filter((name) => statSync(join(VECTORS, name)).isDirectory());
    for (const directory of directories) expect(SUITES).toContain(directory);
    for (const path of vectorFiles()) {
      const vector = load(path) as Vector;
      expect(vector.schema).toBe("agenomic.conformance_vector/v1");
      expect(SUITES).toContain(vector.suite);
      expect(relative(VECTORS, path).split("/")[0]).toBe(vector.suite);
      expect(path.split("/").pop()!.startsWith(`${vector.id}-`)).toBe(true);
    }
  });

  it("runs every vector whose consumers include typescript", () => {
    const counts: Record<string, number> = Object.fromEntries(SUITES.map((suite) => [suite, 0]));
    for (const vector of typescriptVectors()) counts[vector.suite]! += 1;
    expect(counts).toEqual(EXPECTED_COUNTS);
  });
});

describe.each(typescriptVectors().map((vector) => [vector.id, vector] as const))("vector %s", (_id, vector) => {
  it("matches the expected result", () => {
    const runner = RUNNERS[vector.suite];
    if (!runner) throw new Error(`no runner for suite ${vector.suite}`);
    assertMatches(vector.id, vector.expected, runner(vector.input));
  });
});
