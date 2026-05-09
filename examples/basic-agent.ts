import { AgenomicClient, recordMCPToolCall, traceAgentRun } from "../src/index";

const client = new AgenomicClient();

const invokeClaimsAgent = traceAgentRun(
  {
    client,
    agentId: "claims-agent",
    release: "dev",
    redact: ["customer.email"],
  },
  async (
    payload: {
      claimId: string;
      customer: {
        email: string;
      };
    },
    trace,
  ) => {
    trace.addPolicyCheck({
      type: "policy_check",
      policyName: "claims-intake",
      outcome: "allow",
    });

    recordMCPToolCall({
      server: "knowledge-base",
      tool: "find_claim",
      arguments: { claimId: payload.claimId },
      result: { exists: true },
    });

    return {
      approved: true,
      customer: payload.customer,
    };
  },
);

async function main(): Promise<void> {
  const result = await invokeClaimsAgent({
    claimId: "clm_123",
    customer: {
      email: "user@example.com",
    },
  });

  console.log(result);
}

void main();
