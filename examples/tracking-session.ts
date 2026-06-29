/**
 * Online tracking: instrument a production agent run.
 *
 * With no `endpoint` the session buffers spec-shaped events locally; point the
 * client at Agenomic Cloud to stream them for real-time drift/loop/intent
 * detection. Either way the wire format is the v0.3 `tracking-event` shape.
 */

import { AgenomicClient } from "../src/index";

async function main(): Promise<void> {
  const client = new AgenomicClient({
    apiKey: process.env.AGENOMIC_API_KEY,
    endpoint: process.env.AGENOMIC_API_BASE_URL, // omit for local mode
  });

  const session = await client.tracking.start({
    agent: "agent://treans/claims-agent",
    releaseId: "release_123",
    environment: "production",
  });

  await session.step("classify_claim", async () => {
    await session.modelCall({
      provider: "openai",
      model: "gpt-4o",
      inputHash: "blake3:" + "0".repeat(64),
    });
    await session.toolCall({
      toolName: "claims_db.lookup",
      inputHash: "blake3:" + "1".repeat(64),
      outputHash: "blake3:" + "2".repeat(64),
    });
    await session.intent("verify_claim_validity");
    await session.memoryWrite({ schemaVersion: "1.0.0" });
  });

  await session.stop();

  if (client.endpoint) {
    console.log(JSON.stringify(await session.report(), null, 2));
  } else {
    // Local mode: export events for `agenomic track` to analyze offline.
    process.stdout.write(session.toJsonl());
  }
}

void main();
