import { AgentLockClient, withTracedRoute } from "../src/index";

const client = new AgentLockClient();

export const POST = withTracedRoute(
  {
    client,
    agentId: "support-route",
    release: "dev",
    redact: ["customer.email"],
    mapRequest: async (request) => {
      const body = await request.clone().json();
      return {
        method: request.method,
        url: request.url,
        body,
      };
    },
  },
  async (request, _context, trace) => {
    const payload = (await request.json()) as {
      customer: { email: string };
    };

    trace.addToolCall({
      type: "tool_call",
      toolName: "ticket.lookup",
      input: payload,
      output: { found: true },
    });

    return Response.json({
      ok: true,
    });
  },
);
