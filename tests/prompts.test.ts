import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgenomicClient,
  ApiError,
  PromptBindingError,
  PromptIntegrityError,
  PromptRefError,
  ToolExecutionError,
  executionKey,
  fetchJson,
  renderMessages,
  threadKey,
} from "../src/index";
import {
  AGENT,
  CHILD,
  CHILD_RELEASE,
  GENOME,
  OTHER_WORKSPACE,
  PLANNER,
  RELEASE,
  SAFETY,
  WORKSPACE,
  bundleDocument,
  clone,
  signedDocument,
  wireVersion,
} from "./prompt-fixtures";

type Json = Record<string, unknown>;

interface Call {
  url: string;
  method: string;
  body?: Json;
  headers: Record<string, string>;
}

interface Reply {
  status?: number;
  body?: unknown;
  raw?: string;
}

function stubFetch(respond: (call: Call) => Reply): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? (JSON.parse(init.body as string) as Json) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const reply = respond(call);
    const text = reply.raw ?? JSON.stringify(reply.body);
    return new Response(text, { status: reply.status ?? 200, headers: { etag: '"4"' } });
  });
  return calls;
}

function cloud(): AgenomicClient {
  return new AgenomicClient({ apiKey: "key_123", baseUrl: "https://api.agenomic.dev/" });
}

const WHOAMI = { org_id: WORKSPACE, api_key_scopes: ["read"] };
const PLANNER_VERSION = { version: wireVersion("prm_planner", 7, PLANNER), fragments: [wireVersion("prm_safety", 2, SAFETY)] };

function path(call: Call): string {
  return call.url.replace("https://api.agenomic.dev", "");
}

function registry(overrides: (call: Call) => Reply | undefined = () => undefined): (call: Call) => Reply {
  return (call) => {
    const override = overrides(call);
    if (override) return override;
    const target = path(call);
    if (target === "/v1/whoami") return { body: WHOAMI };
    if (target === "/v1/prompts/prm_planner/versions/7?include=fragments") return { body: PLANNER_VERSION };
    return { status: 404, body: { error: { code: "not_found", message: `no route ${target}` } } };
  };
}

function bindingDocument(extra: Json = {}): Json {
  const artifacts = bundleDocument();
  const childManifest = ((artifacts.children as Record<string, Json>)[CHILD] as Json).prompt_manifest_digest;
  return {
    schema: "agenomic.execution_binding/v1",
    binding_id: "bnd_01j9x4w6k2m8n0p3q5r7s9t1v3",
    workspace_id: WORKSPACE,
    agent_id: AGENT,
    thread_key: threadKey(WORKSPACE, "support-thread-42"),
    scope: "thread",
    release_id: RELEASE,
    release_name: "av_0042",
    genome_version: GENOME,
    prompt_manifest_digest: artifacts.prompt_manifest_digest,
    runtime: { bundle_id: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b", bundle_hash: `blake3:${"0f".repeat(32)}` },
    resolved_from: { channel: "production", generation: 12 },
    children: {
      [CHILD]: {
        release_id: CHILD_RELEASE,
        genome_version: GENOME,
        prompt_manifest_digest: childManifest,
        source: "manifest",
        channel: null,
        generation: null,
      },
    },
    parent_binding_id: null,
    experiment: null,
    runtime_client: { sdk: "agenomic-typescript", sdk_version: null, adapter: null, adapter_version: null },
    created_at: "2026-10-04T20:02:00Z",
    created_by: { user_id: null, api_key_id: "5d0b0e7c-3c1a-4b0e-9d77-1f2e3a4b5c6e" },
    ...extra,
  };
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("thread keys", () => {
  it("match the Python SDK output", () => {
    expect(threadKey(WORKSPACE, "support-thread-42")).toBe("thread:sha256:873ef6553585e3640d2fd27c05341f5990112c982884370e64ba1a245cdd58e6");
    expect(executionKey(WORKSPACE, "job-7")).toBe("exec:sha256:01772f434b0d9d5ef9c9428636e3300b3a5c5e555c78eb991913d51eb703d2d7");
    expect(threadKey(WORKSPACE, "fil é 😀")).toBe("thread:sha256:756e097c049aaa5d8874567db8eb14149f6590cbf5f42166d0667a0bd48d0e8d");
  });

  it("refuse a workspace id that is not a lowercase uuid", () => {
    expect(() => threadKey(WORKSPACE.toUpperCase(), "t")).toThrow(TypeError);
  });

  it("refuse an id with a lone surrogate instead of folding it into another id's key", () => {
    for (const id of ["a\uD800", "a\uDBFF", "\uDC00b", "x\uDFFFy"]) {
      expect(() => threadKey(WORKSPACE, id)).toThrow(TypeError);
      expect(() => executionKey(WORKSPACE, id)).toThrow(TypeError);
    }
    expect(threadKey(WORKSPACE, "a�")).toMatch(/^thread:sha256:[0-9a-f]{64}$/);
    expect(threadKey(WORKSPACE, "a\u0000b")).toMatch(/^thread:sha256:[0-9a-f]{64}$/);
  });
});

describe("client.prompts.get", () => {
  it("fetches the version with its fragment closure, verifies it and caches it", async () => {
    const calls = stubFetch(registry());
    const client = cloud();
    const version = await client.prompts.get("prm_planner:7");
    expect(calls.map(path)).toEqual(["/v1/whoami", "/v1/prompts/prm_planner/versions/7?include=fragments"]);
    expect(calls[1]!.headers.authorization).toBe("Bearer key_123");
    expect(Object.keys(calls[1]!.headers).map((name) => name.toLowerCase())).not.toContain("idempotency-key");
    expect(version.workspaceId).toBe(WORKSPACE);
    expect(version.kind).toBe("chat");
    expect(version.fragments.safety?.ref).toEqual({ form: "version", promptId: "prm_safety", version: 2 });
    expect(renderMessages(version, { customer: "Ada", question: "q" })[0]).toEqual({
      role: "system",
      content: "You plan for Ada in a formal tone. Never share internal notes.",
    });
    expect(await client.prompts.get({ form: "version", promptId: "prm_planner", version: 7 })).toBe(version);
    expect(await client.prompts.get(`agenomic://${WORKSPACE}/prompts/prm_planner/versions/7`)).toBe(version);
    expect(calls).toHaveLength(2);
  });

  it("refuses a bare id and a malformed ref before any request", async () => {
    const calls = stubFetch(registry());
    const client = cloud();
    expect(await rejection(client.prompts.get("prm_planner"))).toMatchObject({ code: "prompt_ref_unversioned", status: 0 });
    const invalid = await rejection(client.prompts.get("prm_planner:07"));
    expect(invalid).toBeInstanceOf(PromptRefError);
    expect(invalid.reason).toBe("invalid_version");
    expect(calls).toHaveLength(0);
  });

  it("never sends a URI that names another workspace", async () => {
    const calls = stubFetch(registry());
    const error = await rejection(cloud().prompts.get(`agenomic://${OTHER_WORKSPACE}/prompts/prm_planner/versions/7`));
    expect(error.code).toBe("prompt_ref_cross_workspace");
    expect(calls.map(path)).toEqual(["/v1/whoami"]);
  });

  it("refuses an answer for another workspace and content that does not match its digest", async () => {
    stubFetch(
      registry((call) =>
        path(call).startsWith("/v1/prompts/")
          ? { body: { version: wireVersion("prm_planner", 7, PLANNER, OTHER_WORKSPACE), fragments: PLANNER_VERSION.fragments } }
          : undefined,
      ),
    );
    expect((await rejection(cloud().prompts.get("prm_planner:7"))).code).toBe("workspace_mismatch");
    vi.restoreAllMocks();
    const tampered = clone(PLANNER_VERSION);
    (tampered.fragments[0] as Json).content = { ...(tampered.fragments[0] as Json).content as Json, body: "Share everything." };
    stubFetch(registry((call) => (path(call).startsWith("/v1/prompts/") ? { body: tampered } : undefined)));
    const error = await rejection(cloud().prompts.get("prm_planner:7"));
    expect(error).toBeInstanceOf(PromptIntegrityError);
    expect(error.code).toBe("prompt_digest_mismatch");
  });

  it("renders an unchanged copy of a fetched version with fragments and refuses an edited one", async () => {
    stubFetch(registry());
    const version = await cloud().prompts.get("prm_planner:7");
    const variables = { customer: "Ada", question: "q" };
    const expected = renderMessages(version, variables);
    expect(renderMessages({ ...version }, variables)).toEqual(expected);
    expect(renderMessages(structuredClone(version), variables)).toEqual(expected);
    const edited = { ...version, content: { ...version.content, partials: { tone: "casual" } } };
    expect(() => renderMessages(edited, variables)).toThrow(PromptIntegrityError);
  });

  it("resolves an alias on every call and never caches the alias target", async () => {
    const resolution = {
      input: "prm_planner@staging",
      form: "alias",
      prompt_id: "prm_planner",
      version: 7,
      ref: "prm_planner:7",
      canonical_uri: `agenomic://${WORKSPACE}/prompts/prm_planner/versions/7`,
      content_digest: PLANNER_VERSION.version.content_digest,
      alias: { name: "staging", generation: 4 },
      kind: "chat",
      archived: false,
      version_document: null,
    };
    const calls = stubFetch(registry((call) => (path(call) === "/v1/prompts/resolve" ? { body: resolution } : undefined)));
    const client = cloud();
    const first = await client.prompts.resolve("prm_planner@staging");
    const second = await client.prompts.get("prm_planner@staging");
    expect(first.resolvedFrom).toEqual({ alias: "staging", generation: 4 });
    expect(second.resolvedFrom).toEqual({ alias: "staging", generation: 4 });
    const resolves = calls.filter((call) => path(call) === "/v1/prompts/resolve");
    expect(resolves).toHaveLength(2);
    expect(resolves[0]!.method).toBe("POST");
    expect(resolves[0]!.body).toEqual({ ref: "prm_planner@staging" });
    expect(calls.filter((call) => path(call).startsWith("/v1/prompts/prm_planner/"))).toHaveLength(1);
    expect(renderMessages(first, { customer: "Ada", question: "q" })).toHaveLength(2);
  });

  it("refuses an alias resolution whose digest differs from the fetched version", async () => {
    const resolution = {
      prompt_id: "prm_planner",
      version: 7,
      content_digest: `sha256:${"4".repeat(64)}`,
      alias: { name: "staging", generation: 4 },
    };
    stubFetch(registry((call) => (path(call) === "/v1/prompts/resolve" ? { body: resolution } : undefined)));
    expect((await rejection(cloud().prompts.get("prm_planner@staging"))).code).toBe("prompt_digest_mismatch");
  });
});

describe("error mapping", () => {
  it("maps the error envelope to typed ApiError subclasses with details", async () => {
    stubFetch(
      registry((call) => {
        const target = path(call);
        if (target.includes("/versions/9")) {
          return {
            status: 404,
            body: { error: { code: "prompt_version_not_found", message: "no version 9", request_id: "req-1" } },
          };
        }
        if (target === "/v1/prompts/resolve") {
          return {
            status: 400,
            body: { error: { code: "prompt_ref_invalid", message: "bad", request_id: "req-2", details: { reason: "invalid_alias" } } },
          };
        }
        return undefined;
      }),
    );
    const client = cloud();
    const missing = await rejection(client.prompts.get("prm_planner:9"));
    expect(missing.constructor).toBe(ApiError);
    expect(missing).toMatchObject({ code: "prompt_version_not_found", status: 404, message: "no version 9" });
    expect(missing.requestId).toBe("req-1");
    const invalid = await rejection(client.prompts.get("prm_planner@staging"));
    expect(invalid).toBeInstanceOf(PromptRefError);
    expect(invalid).toMatchObject({ status: 400, reason: "invalid_alias" });
    expect(invalid.requestId).toBe("req-2");
  });

  it("maps a non-JSON error body to http_error and a non-JSON success to invalid_response", async () => {
    stubFetch(registry((call) => (path(call).startsWith("/v1/prompts/") ? { status: 502, raw: "bad gateway" } : undefined)));
    expect(await rejection(cloud().prompts.get("prm_planner:7"))).toMatchObject({ code: "http_error", status: 502 });
    vi.restoreAllMocks();
    stubFetch(registry((call) => (path(call).startsWith("/v1/prompts/") ? { raw: "<html>" } : undefined)));
    expect(await rejection(cloud().prompts.get("prm_planner:7"))).toMatchObject({ code: "invalid_response", status: 200 });
  });

  it("raises ApiError, not ToolExecutionError, for transport faults and a missing baseUrl", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
    const transport = await rejection(cloud().prompts.get("prm_planner:7"));
    expect(transport).not.toBeInstanceOf(ToolExecutionError);
    expect(transport).toMatchObject({ code: "transport_error", status: 0 });
    const local = await rejection(new AgenomicClient().prompts.get("prm_planner:7"));
    expect(local).toMatchObject({ code: "cloud_required", status: 0 });
  });

  it("asks whoami again after a failed whoami", async () => {
    let failures = 1;
    const calls = stubFetch(
      registry((call) => {
        if (path(call) === "/v1/whoami" && failures > 0) {
          failures -= 1;
          return { status: 503, body: { error: { code: "unavailable", message: "later" } } };
        }
        return undefined;
      }),
    );
    const client = cloud();
    expect((await rejection(client.prompts.workspaceId())).status).toBe(503);
    expect(await client.prompts.workspaceId()).toBe(WORKSPACE);
    expect(await client.prompts.workspaceId()).toBe(WORKSPACE);
    expect(calls.filter((call) => path(call) === "/v1/whoami")).toHaveLength(2);
  });
});

describe("client.prompts.resolveAgent", () => {
  it("loads the unsigned artifacts against the workspace, agent and manifest digest", async () => {
    const artifacts = bundleDocument();
    const calls = stubFetch(
      registry((call) =>
        path(call).startsWith(`/v1/agents/${AGENT}/resolve`)
          ? { body: { agent_id: AGENT, prompt_manifest_digest: artifacts.prompt_manifest_digest, artifacts } }
          : undefined,
      ),
    );
    const bundle = await cloud().prompts.resolveAgent({ agentId: AGENT, channel: "production" });
    expect(path(calls[1]!)).toBe(`/v1/agents/${AGENT}/resolve?channel=production`);
    expect(bundle.slots()).toEqual(["planner.instructions"]);
    expect(bundle.signed).toBe(false);
  });

  it("refuses a signed document, a digest disagreement and an ambiguous selector", async () => {
    const artifacts = bundleDocument();
    stubFetch(
      registry((call) =>
        path(call).startsWith(`/v1/agents/${AGENT}/resolve`)
          ? { body: { agent_id: AGENT, prompt_manifest_digest: `sha256:${"9".repeat(64)}`, artifacts } }
          : undefined,
      ),
    );
    const client = cloud();
    expect((await rejection(client.prompts.resolveAgent({ agentId: AGENT, releaseId: RELEASE }))).code).toBe("manifest_digest_mismatch");
    vi.restoreAllMocks();
    stubFetch(
      registry((call) =>
        path(call).startsWith(`/v1/agents/${AGENT}/resolve`)
          ? { body: { agent_id: AGENT, prompt_manifest_digest: artifacts.prompt_manifest_digest, artifacts: signedDocument() } }
          : undefined,
      ),
    );
    expect((await rejection(cloud().prompts.resolveAgent({ agentId: AGENT, channel: "production" }))).code).toBe("bundle_scope_mismatch");
    await expect(cloud().prompts.resolveAgent({ agentId: AGENT, channel: "production", releaseId: RELEASE })).rejects.toThrow(
      "name exactly one of channel and releaseId",
    );
  });
});

describe("client.bindings", () => {
  const key = threadKey(WORKSPACE, "support-thread-42");

  function bindingRoutes(binding: Json, artifacts: Json, created = true) {
    return registry((call) => {
      const target = path(call);
      if (target === `/v1/agents/${AGENT}/bindings` && call.method === "POST") {
        return { status: created ? 201 : 200, body: { created, binding, artifacts } };
      }
      if (target.startsWith(`/v1/agents/${AGENT}/bindings/`)) return { body: { binding, artifacts } };
      return undefined;
    });
  }

  it("creates or gets a binding with the exact body and no idempotency header", async () => {
    const calls = stubFetch(bindingRoutes(bindingDocument(), bundleDocument()));
    const result = await cloud().bindings.create({ agentId: AGENT, threadKey: key, scope: "thread", channel: "production" });
    const request = calls[1]!;
    expect(request.method).toBe("POST");
    expect(path(request)).toBe(`/v1/agents/${AGENT}/bindings`);
    expect(request.body).toEqual({
      thread_key: key,
      scope: "thread",
      selector: { channel: "production" },
      runtime_client: { sdk: "agenomic-typescript", sdk_version: null, adapter: null, adapter_version: null },
      include: ["artifacts"],
    });
    expect(Object.keys(request.headers).map((name) => name.toLowerCase())).not.toContain("idempotency-key");
    expect(result.created).toBe(true);
    expect(result.binding.binding_id).toBe("bnd_01j9x4w6k2m8n0p3q5r7s9t1v3");
    expect(result.artifacts.version("writer.response", { agentId: CHILD }).kind).toBe("text");
  });

  it("sends expect only when a manifest digest is expected and a release selector when asked", async () => {
    const binding = bindingDocument({ resolved_from: { release_id: RELEASE } });
    const calls = stubFetch(bindingRoutes(binding, bundleDocument(), false));
    const digest = binding.prompt_manifest_digest as string;
    const result = await cloud().bindings.create({
      agentId: AGENT,
      threadKey: key,
      scope: "thread",
      releaseId: RELEASE,
      expectManifestDigest: digest,
    });
    expect(result.created).toBe(false);
    expect(calls[1]!.body).toMatchObject({ selector: { release_id: RELEASE }, expect: { prompt_manifest_digest: digest } });
  });

  it("validates the selector before any request", async () => {
    const calls = stubFetch(registry());
    await expect(cloud().bindings.create({ agentId: AGENT, threadKey: key, scope: "thread" })).rejects.toThrow(
      "name exactly one of channel and releaseId",
    );
    expect(calls).toHaveLength(0);
  });

  it("maps a binding conflict to PromptBindingError with its details", async () => {
    stubFetch(
      registry((call) =>
        call.method === "POST"
          ? {
              status: 409,
              body: {
                error: {
                  code: "execution_binding_conflict",
                  message: "thread already bound",
                  details: { binding_id: "bnd_01j9x4w6k2m8n0p3q5r7s9t1v3", release_id: RELEASE },
                },
              },
            }
          : undefined,
      ),
    );
    const error = await rejection(cloud().bindings.create({ agentId: AGENT, threadKey: key, scope: "thread", channel: "staging" }));
    expect(error).toBeInstanceOf(PromptBindingError);
    expect(error).toMatchObject({ status: 409, details: { release_id: RELEASE } });
  });

  it("refuses a binding of another agent, another release or another child pin", async () => {
    stubFetch(bindingRoutes(bindingDocument({ agent_id: CHILD }), bundleDocument()));
    expect((await rejection(cloud().bindings.create({ agentId: AGENT, threadKey: key, scope: "thread", channel: "production" }))).code).toBe(
      "binding_mismatch",
    );
    vi.restoreAllMocks();
    stubFetch(bindingRoutes(bindingDocument({ release_id: CHILD_RELEASE }), bundleDocument()));
    expect((await rejection(cloud().bindings.create({ agentId: AGENT, threadKey: key, scope: "thread", channel: "production" }))).code).toBe(
      "binding_mismatch",
    );
    vi.restoreAllMocks();
    const binding = bindingDocument();
    ((binding.children as Record<string, Json>)[CHILD] as Json).prompt_manifest_digest = `sha256:${"2".repeat(64)}`;
    stubFetch(bindingRoutes(binding, bundleDocument()));
    expect((await rejection(cloud().bindings.create({ agentId: AGENT, threadKey: key, scope: "thread", channel: "production" }))).code).toBe(
      "manifest_digest_mismatch",
    );
    vi.restoreAllMocks();
    stubFetch(bindingRoutes(bindingDocument({ prompt_manifest_digest: `sha256:${"5".repeat(64)}` }), bundleDocument()));
    expect((await rejection(cloud().bindings.create({ agentId: AGENT, threadKey: key, scope: "thread", channel: "production" }))).code).toBe(
      "manifest_digest_mismatch",
    );
  });

  it("refuses artifacts that carry a child the binding does not pin", async () => {
    const artifacts = bundleDocument();
    const actual = ((artifacts.children as Record<string, Json>)[CHILD] as Json).prompt_manifest_digest;
    const unpinned = bindingDocument({ children: {} });
    stubFetch(bindingRoutes(unpinned, artifacts));
    const created = await rejection(cloud().bindings.create({ agentId: AGENT, threadKey: key, scope: "thread", channel: "production" }));
    expect(created).toBeInstanceOf(PromptIntegrityError);
    expect(created).toMatchObject({ code: "manifest_digest_mismatch", details: { child_agent_id: CHILD, expected: null, actual } });
    vi.restoreAllMocks();
    stubFetch(bindingRoutes(unpinned, artifacts));
    const loaded = await rejection(cloud().bindings.get(AGENT, "bnd_01j9x4w6k2m8n0p3q5r7s9t1v3"));
    expect(loaded).toMatchObject({ code: "manifest_digest_mismatch", details: { child_agent_id: CHILD, expected: null, actual } });
  });

  it("answers invalid_response, not a TypeError, for a malformed child pin", async () => {
    for (const child of [null, "pinned", { release_id: CHILD_RELEASE }]) {
      vi.restoreAllMocks();
      stubFetch(bindingRoutes(bindingDocument({ children: { [CHILD]: child } }), bundleDocument()));
      const error = await rejection(cloud().bindings.create({ agentId: AGENT, threadKey: key, scope: "thread", channel: "production" }));
      expect(error.constructor).toBe(ApiError);
      expect(error).toMatchObject({ code: "invalid_response", status: 0 });
    }
  });

  it("reads a binding with its artifacts", async () => {
    const calls = stubFetch(bindingRoutes(bindingDocument(), bundleDocument()));
    const { binding, artifacts } = await cloud().bindings.get(AGENT, "bnd_01j9x4w6k2m8n0p3q5r7s9t1v3");
    expect(path(calls[1]!)).toBe(`/v1/agents/${AGENT}/bindings/bnd_01j9x4w6k2m8n0p3q5r7s9t1v3?include=artifacts`);
    expect(binding.thread_key).toBe(key);
    expect(artifacts.promptManifestDigest).toBe(binding.prompt_manifest_digest);
    expect((await rejection(cloud().bindings.get(AGENT, "bnd_01j9x4w6k2m8n0p3q5r7s9t1v4"))).code).toBe("binding_mismatch");
  });
});

describe("fetchJson", () => {
  it("exposes the response headers on the exchange", async () => {
    stubFetch(() => ({ body: { ok: true } }));
    const exchange = await fetchJson(cloud(), "GET", "/v1/anything");
    expect(exchange.headers?.get("etag")).toBe('"4"');
    expect(exchange.body).toEqual({ ok: true });
  });
});
