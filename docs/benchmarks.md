# RMP benchmarks and the agent bridge

`client.benchmarks` plans, preflights, launches and follows external benchmark
suites (τ²-bench, ToolSandbox, AppWorld, AgentDojo, MCP-Universe) under an RMP
session; `BridgeServer` serves your own agent to the turns Agenomic relays from
its isolated runners. Both need a cloud client (`baseUrl`); there is no local
mode and `rmp.start()` still never launches anything.

## Serve your agent

```ts
import { AgenomicClient, BridgeServer, type AgentTargetBridge } from "agenomic";

const bridge: AgentTargetBridge = {
  capabilities: ["multi_turn", "benchmark_tools"],
  async handleTurn(turn) {
    const step = await myAgent.step({ messages: turn.messages, tools: turn.tools, system: turn.instructions });
    return { content: step.text, toolCalls: step.toolCalls, usage: step.usage };
  },
};

const client = new AgenomicClient({ apiKey: "agm_...", baseUrl: "https://cloud.agenomic.io" });
await new BridgeServer(client, bridge, { agent: "agent://acme/support", releaseId: "rel_2026_09" }).serve();
```

Tool calls you return are executed by the benchmark environment, never by your
integrations; their results arrive on the next turn. Registration expires two
minutes after the last heartbeat, and replies are idempotent per turn.

## Plan, preflight, launch, follow

```ts
const session = await client.rmp.start({ agent: "agent://acme/support", releaseId: "rel_2026_09" });
const catalog = await client.benchmarks.catalog({ agent: "agent://acme/support", releaseId: "rel_2026_09" });

let plan = await client.benchmarks.createPlan(session.session_id, [
  { benchmark_id: "agentdojo", benchmark_version: "v0.1.35", scope: { domains: ["workspace"] }, profile: "standard" },
]);
plan = await client.benchmarks.preflight(plan.plan_id);
if ((plan.preflight as { passed?: boolean } | null)?.passed) {
  const { runs, already_launched } = await client.benchmarks.launch(plan.plan_id);
}
const view = await client.benchmarks.getPlan(plan.plan_id);
const detail = await client.benchmarks.getRun(view.runs[0]!.run_id);
```

Preflight returns every check with its corrective action and the frozen
tasks × variants × repetitions per benchmark; launch freezes the manifest and
is idempotent. Verdicts (`pass`, `fail`, `inconclusive`, `not_applicable`) are
separate from the run lifecycle, smoke profiles are never conclusive, and
missing metrics are `null`, never zero. `decidePolicy(id, "approved", {
manifestHash })` binds a Protect proposal to the exact manifest it was built
from.
