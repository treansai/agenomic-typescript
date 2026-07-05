import { describe, expect, it } from "vitest";

import { AgenomicClient } from "../src/client";
import { instrumentHuggingFace } from "../src/integrations/huggingface";

describe("instrumentHuggingFace", () => {
  it("records a model_call with provider huggingface on success", async () => {
    const client = new AgenomicClient();
    const trace = client.createTrace({ agentId: "hf-agent" });

    const hf = {
      async generateText(
        model: string,
        prompt: string,
        _params?: Record<string, unknown>,
      ) {
        return [{ generated_text: `${prompt} world` }];
      },
    };

    const instrumented = instrumentHuggingFace(hf, { trace, provider: "hf" });
    const out = await instrumented.generateText("gpt2", "hello", {
      max_new_tokens: 4,
    });
    expect(out).toEqual([{ generated_text: "hello world" }]);

    const envelope = trace.build();
    const modelCalls = envelope.events.filter((e) => e.type === "model_call");
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]).toMatchObject({
      type: "model_call",
      provider: "huggingface",
      model: "gpt2",
    });
  });

  it("records an error model_call and rethrows", async () => {
    const client = new AgenomicClient();
    const trace = client.createTrace({ agentId: "hf-agent" });

    const hf = {
      async embeddings(_model: string, _inputs: string) {
        throw new Error("boom");
      },
    };
    const instrumented = instrumentHuggingFace(hf, { trace });
    await expect(instrumented.embeddings("gpt2", "x")).rejects.toThrow("boom");

    const envelope = trace.build();
    const modelCalls = envelope.events.filter((e) => e.type === "model_call");
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]).toMatchObject({
      provider: "huggingface",
      model: "gpt2",
    });
    expect((modelCalls[0] as { error?: unknown }).error).toBeDefined();
  });
});
