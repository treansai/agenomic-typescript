import { afterEach, describe, expect, it, vi } from "vitest";

import { AgenomicClient } from "../src/client";
import {
  HuggingFaceAuthError,
  HuggingFaceClient,
  HuggingFaceConfig,
  isHuggingFace,
  lockModel,
  normalizeProvider,
  redactToken,
} from "../src/providers/huggingface";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "ERR",
  });
}

describe("provider normalization", () => {
  it("normalizes every alias to huggingface", () => {
    for (const alias of [
      "huggingface",
      "HuggingFace",
      "hf",
      "HF",
      "hugging_face",
      "Hugging-Face",
      "hugging-face",
    ]) {
      expect(normalizeProvider(alias)).toBe("huggingface");
      expect(isHuggingFace(alias)).toBe(true);
    }
  });

  it("passes through other providers and rejects junk", () => {
    expect(normalizeProvider("openai")).toBe("openai");
    expect(isHuggingFace("openai")).toBe(false);
    expect(normalizeProvider("")).toBeNull();
    expect(normalizeProvider(undefined)).toBeNull();
  });
});

describe("HuggingFaceConfig.fromEnv", () => {
  it("prefers HUGGINGFACE_API_TOKEN", () => {
    const config = HuggingFaceConfig.fromEnv({
      HUGGINGFACE_API_TOKEN: "hf_primary_token",
      HF_TOKEN: "hf_fallback_token",
    } as NodeJS.ProcessEnv);
    expect(config.hasToken()).toBe(true);
    expect(config.getToken()).toBe("hf_primary_token");
  });

  it("falls back to HF_TOKEN", () => {
    const config = HuggingFaceConfig.fromEnv({
      HF_TOKEN: "hf_fallback_token",
    } as NodeJS.ProcessEnv);
    expect(config.getToken()).toBe("hf_fallback_token");
  });

  it("reads optional vars and defaults timeout to 30", () => {
    const a = HuggingFaceConfig.fromEnv({} as NodeJS.ProcessEnv);
    expect(a.timeoutSeconds).toBe(30);
    expect(a.hasToken()).toBe(false);

    const b = HuggingFaceConfig.fromEnv({
      HUGGINGFACE_ENDPOINT_URL: "https://my.endpoint.example",
      HUGGINGFACE_ORG: "treans",
      HUGGINGFACE_DEFAULT_MODEL: "mistralai/Mistral-7B-Instruct-v0.3",
      HUGGINGFACE_TIMEOUT_SECONDS: "10",
    } as NodeJS.ProcessEnv);
    expect(b.endpointUrl).toBe("https://my.endpoint.example");
    expect(b.org).toBe("treans");
    expect(b.defaultModel).toBe("mistralai/Mistral-7B-Instruct-v0.3");
    expect(b.timeoutSeconds).toBe(10);
  });

  it("rejects endpoint URLs with inline credentials", () => {
    expect(() =>
      HuggingFaceConfig.fromEnv({
        HUGGINGFACE_ENDPOINT_URL: "https://user:pass@my.endpoint.example",
      } as NodeJS.ProcessEnv),
    ).toThrow(/inline credentials/);
  });

  it("never serializes the token", () => {
    const config = HuggingFaceConfig.fromEnv({
      HUGGINGFACE_API_TOKEN: "hf_secret_value_123",
    } as NodeJS.ProcessEnv);
    expect(JSON.stringify(config)).not.toContain("hf_secret_value_123");
    expect(JSON.stringify(config)).toContain('"hasToken":true');
  });
});

describe("redactToken", () => {
  it("scrubs hf_-shaped tokens and the configured token", () => {
    const config = new HuggingFaceConfig({ token: "supersecrettoken" });
    const text =
      "auth failed with token hf_abcdEFGH1234 and supersecrettoken leaked";
    const redacted = config.redact(text);
    expect(redacted).not.toContain("hf_abcdEFGH1234");
    expect(redacted).not.toContain("supersecrettoken");
    expect(redacted).toContain("[REDACTED]");
  });

  it("works as a standalone helper", () => {
    expect(redactToken("hf_TOKENtoken123 here")).toBe("[REDACTED] here");
  });
});

describe("HuggingFaceClient.validateCredentials", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns whoami on success with bearer auth", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://huggingface.co/api/whoami-v2");
      expect((init.headers as Record<string, string>).authorization).toBe(
        "Bearer hf_valid_token",
      );
      return jsonResponse({ name: "alice", type: "user" });
    });
    const client = new HuggingFaceClient({
      config: new HuggingFaceConfig({ token: "hf_valid_token" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const who = await client.validateCredentials();
    expect(who).toMatchObject({ name: "alice" });
  });

  it("maps 401 to an auth error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
    const client = new HuggingFaceClient({
      config: new HuggingFaceConfig({ token: "hf_bad_token" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.validateCredentials()).rejects.toBeInstanceOf(
      HuggingFaceAuthError,
    );
  });

  it("throws an auth error when no token is configured", async () => {
    const client = new HuggingFaceClient({
      config: new HuggingFaceConfig({}),
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    await expect(client.validateCredentials()).rejects.toBeInstanceOf(
      HuggingFaceAuthError,
    );
  });
});

describe("HuggingFaceClient.resolveModelMetadata", () => {
  it("extracts sha, pipeline_tag, and private", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://huggingface.co/api/models/mistralai%2FMistral-7B-Instruct-v0.3/revision/main",
      );
      return jsonResponse({
        id: "mistralai/Mistral-7B-Instruct-v0.3",
        sha: "abc123def456",
        pipeline_tag: "text-generation",
        private: false,
      });
    });
    const client = new HuggingFaceClient({
      config: new HuggingFaceConfig({ token: "hf_t" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const meta = await client.resolveModelMetadata(
      "mistralai/Mistral-7B-Instruct-v0.3",
    );
    expect(meta).toEqual({
      modelId: "mistralai/Mistral-7B-Instruct-v0.3",
      revision: "main",
      resolvedCommit: "abc123def456",
      task: "text-generation",
      private: false,
    });
  });
});

describe("HuggingFaceClient.generateText", () => {
  it("POSTs inputs/parameters and returns the body", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(
        "https://api-inference.huggingface.co/models/gpt2",
      );
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        inputs: "Hello",
        parameters: { max_new_tokens: 8 },
      });
      return jsonResponse([{ generated_text: "Hello world" }]);
    });
    const client = new HuggingFaceClient({
      config: new HuggingFaceConfig({ token: "hf_t" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await client.generateText("gpt2", "Hello", {
      max_new_tokens: 8,
    });
    expect(out).toEqual([{ generated_text: "Hello world" }]);
  });

  it("uses a custom endpoint URL when configured", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://my.endpoint.example/models/gpt2");
      return jsonResponse([{ generated_text: "x" }]);
    });
    const client = new HuggingFaceClient({
      config: new HuggingFaceConfig({
        token: "hf_t",
        endpointUrl: "https://my.endpoint.example",
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.generateText("gpt2", "Hi");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("token redaction in errors", () => {
  it("redacts the configured token from a failure message", async () => {
    const token = "hf_supersecret_abc123";
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: `bad token hf_supersecret_abc123` }, 500),
    );
    const client = new HuggingFaceClient({
      config: new HuggingFaceConfig({ token }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.generateText("gpt2", "hi")).rejects.toMatchObject({
      message: expect.not.stringContaining(token),
    });
  });
});

describe("lockModel", () => {
  it("builds a credential-free, hashed lock block", () => {
    const lock = lockModel(
      {
        modelId: "mistralai/Mistral-7B-Instruct-v0.3",
        revision: "main",
        resolvedCommit: "abc123",
        task: "text-generation",
        private: false,
      },
      "https://user:pass@my.endpoint.example/v1/",
      { temperature: 0.2 },
    );

    expect(lock.provider).toBe("huggingface");
    expect(lock.modelId).toBe("mistralai/Mistral-7B-Instruct-v0.3");
    expect(lock.model_id).toBe(lock.modelId);
    expect(lock.revision).toBe("main");
    expect(lock.resolvedCommit).toBe("abc123");
    expect(lock.task).toBe("text-generation");
    // endpoint reference is redacted (no inline credentials, no trailing slash)
    expect(lock.endpointRef).toBe("https://my.endpoint.example/v1");
    expect(lock.endpointHash).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.metadataHash).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.parameterHash).toMatch(/^[0-9a-f]{64}$/);
    // no secret leaked anywhere
    expect(JSON.stringify(lock)).not.toContain("pass");
  });

  it("is deterministic and parameter-sensitive", () => {
    const meta = {
      modelId: "gpt2",
      revision: "main",
      resolvedCommit: "deadbeef",
      task: "text-generation",
    };
    const a = lockModel(meta, undefined, { temperature: 0.2 });
    const b = lockModel(meta, undefined, { temperature: 0.2 });
    const c = lockModel(meta, undefined, { temperature: 0.9 });
    expect(a.parameterHash).toBe(b.parameterHash);
    expect(a.metadataHash).toBe(b.metadataHash);
    expect(a.parameterHash).not.toBe(c.parameterHash);
    expect(a.endpointHash).toBeUndefined();
  });
});

describe("client.models.configure", () => {
  it("normalizes a huggingface alias and defaults revision", async () => {
    const client = new AgenomicClient();
    const config = await client.models.configure({
      provider: "hf",
      model: "mistralai/Mistral-7B-Instruct-v0.3",
      task: "text-generation",
    });
    expect(config).toMatchObject({
      provider: "huggingface",
      model: "mistralai/Mistral-7B-Instruct-v0.3",
      task: "text-generation",
      revision: "main",
    });
  });

  it("rejects unknown providers and invalid hf model ids", async () => {
    const client = new AgenomicClient();
    await expect(
      client.models.configure({ provider: "", model: "x" }),
    ).rejects.toThrow();
    await expect(
      client.models.configure({
        provider: "huggingface",
        model: "https://not-a-model",
      }),
    ).rejects.toThrow(/invalid huggingface model id/);
  });

  it("persists to a local genome.yaml when a path is given", async () => {
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "genome-"));
    const path = join(dir, "genome.yaml");

    const client = new AgenomicClient();
    await client.models.configure({
      provider: "huggingface",
      model: "gpt2",
      task: "text-generation",
      path,
    });
    // re-configure same model id → merge (not duplicate)
    await client.models.configure({
      provider: "huggingface",
      model: "gpt2",
      task: "text-generation",
      revision: "v2",
      path,
    });
    // a second, different model
    await client.models.configure({
      provider: "openai",
      model: "gpt-4o",
      path,
    });

    const yaml = await readFile(path, "utf8");
    expect(yaml).toContain("models:");
    expect(yaml).toContain("provider: huggingface");
    expect(yaml).toContain("model: gpt2");
    expect(yaml).toContain("revision: v2");
    expect(yaml).toContain("provider: openai");
    // gpt2 should appear once (merged), not twice
    expect(yaml.match(/model: gpt2/g)).toHaveLength(1);
  });
});
