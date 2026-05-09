import { AgenomicClient } from "../src/index";

async function main(): Promise<void> {
  const client = new AgenomicClient();
  const trace = client.createTrace({
    agentId: "export-agent",
    input: {
      prompt: "Generate an audit summary",
      customer: {
        email: "user@example.com",
      },
    },
    redact: ["customer.email"],
  });

  trace.addModelCall({
    type: "model_call",
    provider: "mock-openai",
    model: "gpt-4o-mini",
    input: { prompt: "Generate an audit summary" },
    output: { text: "Audit summary ready." },
  });

  trace.complete({
    output: { stored: true },
  });

  await client.exportJsonl("./traces/agenomic.jsonl", [trace.build()]);
}

void main();
