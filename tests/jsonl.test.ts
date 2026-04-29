import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AgentLockClient } from "../src/client";

describe("JSONL export", () => {
  it("writes trace envelopes to disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentlock-"));
    const path = join(directory, "traces.jsonl");
    const client = new AgentLockClient();
    const trace = client.createTrace({
      agentId: "export-agent",
      input: { prompt: "Hello" },
    });

    trace.complete({
      output: { ok: true },
    });

    await client.exportJsonl(path, [trace.build()]);

    const contents = await readFile(path, "utf8");
    const lines = contents.trim().split("\n");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}").run.agentId).toBe("export-agent");
  });
});
