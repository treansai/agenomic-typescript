import { describe, expect, it } from "vitest";

import { AgenomicClient } from "../src/client";
import { applyOverlay, instrumentOpenAI } from "../src/integrations/openai";
import type { ModelCall } from "../src/models";

const OVERLAY = { version: "1", digest: "blake3:overlay", text: "You may read CRM records. Never delete customers.", policies: ["crm@1.0.0"], truncated: false };

function fakeClient() {
  const seen: Record<string, unknown>[] = [];
  const client = {
    chat: { completions: { create: async (req: Record<string, unknown>) => { seen.push(req); return { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }; } } },
    responses: { create: async (req: Record<string, unknown>) => { seen.push(req); return { output_text: "ok", usage: { input_tokens: 1, output_tokens: 1 } }; } },
  };
  return { client, seen };
}

describe("instrumentOpenAI overlay", () => {
  it("prepends a system message for chat.completions.create and records the injected request", async () => {
    const { client, seen } = fakeClient();
    const trace = new AgenomicClient().createTrace({ agentId: "a" });
    const wrapped = instrumentOpenAI(client, { overlay: OVERLAY, trace });
    const original = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
    await wrapped.chat.completions.create(original);
    expect(seen[0]!.messages).toEqual([{ role: "system", content: OVERLAY.text }, { role: "user", content: "hi" }]);
    expect(original.messages).toHaveLength(1);
    const event = trace.build().events.find((e) => e.type === "model_call") as ModelCall | undefined;
    expect(event?.input).toEqual(seen[0]!.messages);
  });

  it("sets or prefixes instructions for responses.create and records them", async () => {
    const { client, seen } = fakeClient();
    const trace = new AgenomicClient().createTrace({ agentId: "a" });
    const wrapped = instrumentOpenAI(client, { overlay: OVERLAY.text, trace });
    await wrapped.responses.create({ model: "gpt-4o", input: "hi" });
    await wrapped.responses.create({ model: "gpt-4o", input: "hi", instructions: "Be terse." });
    expect(seen[0]!.instructions).toBe(OVERLAY.text);
    expect(seen[1]!.instructions).toBe(`${OVERLAY.text}\n\nBe terse.`);
    const events = trace.build().events.filter((e) => e.type === "model_call") as ModelCall[];
    expect(events[0]!.input).toEqual({ instructions: OVERLAY.text, input: "hi" });
    expect(events[1]!.input).toEqual({ instructions: `${OVERLAY.text}\n\nBe terse.`, input: "hi" });
  });

  it("is deterministic and idempotent for both methods", async () => {
    const chat = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
    const responses = { model: "gpt-4o", input: "hi", instructions: "Be terse." };
    const once = applyOverlay("chat", chat, OVERLAY);
    expect(applyOverlay("chat", chat, OVERLAY)).toEqual(once);
    expect(applyOverlay("chat", once, OVERLAY)).toBe(once);
    const onceR = applyOverlay("responses", responses, OVERLAY);
    expect(applyOverlay("responses", responses, OVERLAY)).toEqual(onceR);
    expect(applyOverlay("responses", onceR, OVERLAY)).toBe(onceR);

    const { client, seen } = fakeClient();
    const twice = instrumentOpenAI(instrumentOpenAI(client, { overlay: OVERLAY }), { overlay: OVERLAY });
    await twice.chat.completions.create(chat);
    await twice.responses.create(responses);
    expect(seen[0]!.messages).toEqual(once.messages);
    expect(seen[1]!.instructions).toBe(onceR.instructions);
  });

  it("leaves the request untouched without an overlay or with an empty one", async () => {
    const request = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
    expect(applyOverlay("chat", request, undefined)).toBe(request);
    expect(applyOverlay("chat", request, "")).toBe(request);
    const { client, seen } = fakeClient();
    await instrumentOpenAI(client).chat.completions.create(request);
    expect(seen[0]).toBe(request);
  });
});
