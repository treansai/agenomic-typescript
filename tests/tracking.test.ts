import { afterEach, describe, expect, it, vi } from "vitest";

import { AgenomicClient } from "../src/client";

describe("client.tracking (local mode)", () => {
  it("buffers spec-shaped events without an endpoint", async () => {
    const client = new AgenomicClient();
    const session = await client.tracking.start({
      agent: "agent://treans/claims-agent",
      releaseId: "release_123",
      environment: "production",
    });

    await session.toolCall({ toolName: "claims_db.lookup", inputHash: "blake3:abc" });
    await session.intent("verify_claim_validity");

    const events = session.events;
    expect(events).toHaveLength(2);
    // wire shape is snake_case + spec_version, monotonic sequence numbers
    expect(events[0]).toMatchObject({
      spec_version: "agenomic/v0.3",
      type: "tool.call.completed",
      agent_id: "agent://treans/claims-agent",
      sequence_number: 0,
      tool: { name: "claims_db.lookup" },
      input_hash: "blake3:abc",
    });
    expect(events[1]).toMatchObject({
      type: "intent.detected",
      intent: "verify_claim_validity",
      sequence_number: 1,
    });
    expect(session.toJsonl().trim().split("\n")).toHaveLength(2);
  });

  it("wraps a step with started/completed events", async () => {
    const client = new AgenomicClient();
    const session = await client.tracking.start({ agent: "agent://acme/a" });
    const result = await session.step("classify", async () => {
      await session.modelCall({ provider: "openai", model: "gpt-4o" });
      return 42;
    });
    expect(result).toBe(42);
    const types = session.events.map((e) => e.type);
    expect(types).toEqual([
      "agent.step.started",
      "model.call.completed",
      "agent.step.completed",
    ]);
  });

  it("refuses events after stop", async () => {
    const client = new AgenomicClient();
    const session = await client.tracking.start({ agent: "agent://acme/a" });
    await session.stop();
    await expect(session.intent("x")).rejects.toThrow(/stopped/);
  });
});

describe("client.tracking (cloud mode)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs start/event/stop with bearer auth", async () => {
    const calls: Array<{ url: string; body: unknown; auth?: string }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(init.body as string),
        auth: (init.headers as Record<string, string>)?.authorization,
      });
      const payload = url.endsWith("/sessions")
        ? { session: { session_id: "sess_cloud_1" } }
        : {};
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AgenomicClient({
      apiKey: "key_123",
      endpoint: "https://api.agenomic.dev/",
    });
    const session = await client.tracking.start({
      agent: "agent://treans/claims-agent",
      releaseId: "release_123",
    });
    expect(session.sessionId).toBe("sess_cloud_1");

    await session.event({ type: "tool.call.completed", toolName: "claims_db.lookup" });
    await session.stop();

    // trailing slash on endpoint is normalized, paths are correct
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe("https://api.agenomic.dev/v1/tracking/sessions");
    expect(calls[1]!.url).toBe(
      "https://api.agenomic.dev/v1/tracking/sessions/sess_cloud_1/events",
    );
    expect(calls[2]!.url).toBe(
      "https://api.agenomic.dev/v1/tracking/sessions/sess_cloud_1/stop",
    );
    expect(calls.every((c) => c.auth === "Bearer key_123")).toBe(true);
    // events are not buffered in cloud mode
    expect(session.events).toHaveLength(0);
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500, statusText: "err" })),
    );
    const client = new AgenomicClient({ endpoint: "https://api.agenomic.dev" });
    await expect(client.tracking.start({ agent: "agent://a/b" })).rejects.toThrow(
      /failed with 500/,
    );
  });

  it("derives the API base from a trace-path endpoint", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ session: { session_id: "s1" } }), { status: 200 });
      }),
    );
    // endpoint configured for trace ingestion (per the README) must not leak
    // its /v1/traces path into tracking URLs.
    const client = new AgenomicClient({ endpoint: "https://api.agenomic.dev/v1/traces" });
    await client.tracking.start({ agent: "agent://a/b" });
    expect(urls[0]).toBe("https://api.agenomic.dev/v1/tracking/sessions");
  });

  it("honors an explicit baseUrl over endpoint", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ session: { session_id: "s1" } }), { status: 200 });
      }),
    );
    const client = new AgenomicClient({
      endpoint: "https://ingest.example/v1/traces",
      baseUrl: "https://api.example",
    });
    await client.tracking.start({ agent: "agent://a/b" });
    expect(urls[0]).toBe("https://api.example/v1/tracking/sessions");
  });

  it("rejects a start response without a session_id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ session: {} }), { status: 200 })),
    );
    const client = new AgenomicClient({ endpoint: "https://api.agenomic.dev" });
    await expect(client.tracking.start({ agent: "agent://a/b" })).rejects.toThrow(
      /did not include a session_id/,
    );
  });

  it("keeps stop retryable when the cloud POST fails", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls += 1;
        if (url.endsWith("/sessions")) {
          return new Response(JSON.stringify({ session: { session_id: "s1" } }), { status: 200 });
        }
        // first stop fails, second succeeds
        if (url.endsWith("/stop") && calls === 2) {
          return new Response("err", { status: 503, statusText: "unavailable" });
        }
        return new Response("{}", { status: 200 });
      }),
    );
    const client = new AgenomicClient({ endpoint: "https://api.agenomic.dev" });
    const session = await client.tracking.start({ agent: "agent://a/b" });
    await expect(session.stop()).rejects.toThrow();
    // not marked stopped → a retry actually issues another request and succeeds
    await expect(session.stop()).resolves.toBeUndefined();
  });
});
