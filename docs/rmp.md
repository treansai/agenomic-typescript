# Review · Monitor · Protect (RMP)

RMP is Agenomic's continuous safety loop for production agents:
**Review** (pre-release scenario testing) → **Monitor** (runtime detection) →
**Protect** (alerting / mitigation) → back to **Review** (scenario
enrichment). The loop engine runs in Agenomic Cloud under the
`/v1/rmp`, `/v1/review`, `/v1/monitor`, and `/v1/protect` endpoints; the SDK
provides a typed client surface over it.

The wire format is snake_case JSON with `spec_version: "agenomic.rmp/v0.1"`
(reports use `report_version: "agenomic.rmp.report/v0.1"`).

## Local-first

Like `client.tracking`, every RMP resource is local-first. Without a
`baseUrl`/`endpoint` on the `AgenomicClient`:

- `rmp.start` / `monitor.start` construct in-process sessions (ids are
  prefixed `rmp_` / `mon_`),
- monitor events are stamped (`event_id`, `timestamp`, `sequence_number`,
  `agent_id`) and buffered on the session (`session.events`),
- reads (`protect.alerts`, `protect.recommendations`, `monitor.findings`,
  `rmp.list`, …) return buffered or empty data and never throw,
- `review.run` returns a stub `{ result: "pass" }` outcome, and
  `review.approveScenarioEnrichment` flips the buffered proposal to
  `"approved"`.

With a `baseUrl` (or `endpoint`), the same calls hit Agenomic Cloud with
`authorization: Bearer <apiKey>`.

## The loop session: `client.rmp`

```ts
import { AgenomicClient } from "agenomic-typescript";

const client = new AgenomicClient({
  apiKey: process.env.AGENOMIC_API_KEY,
  baseUrl: "https://api.agenomic.dev",
});

const session = await client.rmp.start({
  agent: "agent://treans/claims-agent",
  releaseId: "release_123",
  environment: "production",
  ledger: true, // tamper-evident ledger
  genomeHash: "blake3:…",
});

const report = await client.rmp.report(session.session_id);
// report.report_version === "agenomic.rmp.report/v0.1"
// report.summary — { event_count, finding_count, alert_count, … }
```

`client.rmp.get(sessionId)` and `client.rmp.list()` read sessions back.

## Review: `client.review`

```ts
const outcome = await client.review.run({
  agent: "agent://treans/claims-agent",
  riskMatrix: { data_exfiltration: "high" },
}); // { result: "pass" | "fail" | "inconclusive", … }

await client.review.addScenario({
  name: "prompt injection via tool output",
  source: "incident_derived", // "manual" | "generated" | "incident_derived" |
                              // "monitor_derived" | "protect_derived" | "user_provided"
  severity: "high",
});
const scenarios = await client.review.listScenarios();
```

Monitor and Protect feed scenario-enrichment proposals back into Review.
Proposals carry a status (`"draft" | "pending_review" | "approved" |
"rejected" | "applied"`) and `human_approval_required`; approving is the
human-in-the-loop step:

```ts
await client.review.approveScenarioEnrichment({
  proposalId: "prop_123",
  sessionId: session.session_id,
  reviewer: "gabin",
});
```

## Monitor: `client.monitor`

```ts
const monitor = await client.monitor.start({
  agent: "agent://treans/claims-agent",
  releaseId: "release_123",
});

// events must carry a `type`; ids/timestamps/sequencing are stamped for you
await monitor.event({ type: "tool.call.completed", tool_name: "claims_db.lookup" });
await monitor.event({ type: "loop.detected" });

const findings = await client.monitor.findings({ sessionId: monitor.sessionId });
await monitor.stop(); // idempotent
```

`client.monitor.event({ sessionId, event })` emits onto a session by id.

## Protect: `client.protect`

```ts
const alerts = await client.protect.alerts({ sessionId: session.session_id });
// alerts: alert_id, severity, status, dedup_key, occurrence_count,
//         routes, throttled, escalated, …

const plan = await client.protect.actionPlan({ alertId: alerts[0]!.alert_id });
const recs = await client.protect.recommendations({ sessionId: session.session_id });
await client.protect.notify({ alertId: alerts[0]!.alert_id }); // route to channels
```
