# Hugging Face Connection

The Hugging Face connection lets you configure models, resolve and pin Hub
revisions, validate credentials, and run inference, with the same redaction and
tracing guarantees as the rest of the SDK. The API token is **never** logged,
returned, or embedded in any object, trace, or error.

## Provider name and aliases

The canonical provider name is `huggingface`. The following aliases are accepted
(case-insensitive; `-` and `_` are equivalent) and normalize to `huggingface`:

- `huggingface`
- `hf`
- `hugging_face` (and `hugging-face`)

```ts
import { normalizeProvider, isHuggingFace } from "agenomic-typescript";

normalizeProvider("HF"); // "huggingface"
normalizeProvider("Hugging-Face"); // "huggingface"
normalizeProvider("openai"); // "openai" (passed through)
isHuggingFace("hf"); // true
```

## Configuration

`HuggingFaceConfig.fromEnv()` reads configuration from the environment:

| Variable | Purpose | Default |
| --- | --- | --- |
| `HUGGINGFACE_API_TOKEN` | API token (preferred) | — |
| `HF_TOKEN` | API token (fallback) | — |
| `HUGGINGFACE_ENDPOINT_URL` | Custom inference endpoint base URL | serverless Inference API |
| `HUGGINGFACE_ORG` | Default organization / namespace | — |
| `HUGGINGFACE_DEFAULT_MODEL` | Default model id | — |
| `HUGGINGFACE_TIMEOUT_SECONDS` | Per-request timeout (seconds) | `30` |

The token is held on a private field. `JSON.stringify(config)` reports only
`hasToken: boolean`, never the token itself. Endpoint URLs containing inline
credentials (`https://user:pass@host`) are rejected.

```ts
import { HuggingFaceConfig } from "agenomic-typescript";

const config = HuggingFaceConfig.fromEnv();
config.hasToken(); // true | false
config.redact("error mentioning hf_xxx and your token"); // secrets -> [REDACTED]
```

## Client

`HuggingFaceClient` uses the global `fetch` and honors the configured timeout via
an `AbortController`. A `401`/`403` from the Hub or Inference API is surfaced as a
`HuggingFaceAuthError`; all error messages are passed through the config's
redaction.

```ts
import { HuggingFaceClient } from "agenomic-typescript";

const hf = new HuggingFaceClient(); // uses HuggingFaceConfig.fromEnv()

// Validate the token against GET /api/whoami-v2
const who = await hf.validateCredentials();

// Resolve a model revision -> { modelId, revision, resolvedCommit, task, private }
const meta = await hf.resolveModelMetadata(
  "mistralai/Mistral-7B-Instruct-v0.3",
  "main",
);

// Inference: POST {endpoint}/models/{model} with { inputs, parameters }
const generated = await hf.generateText("gpt2", "Hello", { max_new_tokens: 16 });
const vectors = await hf.embeddings("sentence-transformers/all-MiniLM-L6-v2", [
  "hello",
  "world",
]);
```

## Model locking

`lockModel(meta, endpointUrl?, parameters?)` builds a deterministic,
credential-free lock block that pins a model to a resolved commit, task,
endpoint, and parameter set. Hashes are SHA-256 (hex) over canonical
(stably key-sorted) JSON, so the lock is reproducible and diff-able. The endpoint
is reduced to a redacted `scheme://host[/path]` reference with any inline
credentials and query/fragment stripped.

```ts
import { lockModel } from "agenomic-typescript";

const lock = lockModel(meta, process.env.HUGGINGFACE_ENDPOINT_URL, {
  temperature: 0.2,
});
// {
//   provider: "huggingface",
//   modelId, model_id, revision, resolvedCommit, task,
//   endpointRef, endpointHash, metadataHash, parameterHash
// }
```

## Configuring a model via the client

`client.models.configure(...)` is provider-agnostic but validates Hugging Face
aliases and normalizes them to `huggingface`. When given a `path`, the resolved
config is merged into a local `genome.yaml` under a `models:` list.

```ts
import { AgenomicClient } from "agenomic-typescript";

const client = new AgenomicClient();
const config = await client.models.configure({
  provider: "huggingface",
  model: "mistralai/Mistral-7B-Instruct-v0.3",
  task: "text-generation",
  // path: "./genome.yaml", // optional local persistence
});
// { provider: "huggingface", model: "...", task: "text-generation", revision: "main" }
```

## Tracing inference

`instrumentHuggingFace()` mirrors `instrumentOpenAI()`. It wraps a Hugging Face
client-like object so its inference methods (`generateText`, `embeddings`,
`textGeneration`, `featureExtraction`) record `model_call` events on the active
trace with provider `"huggingface"`, on both success and error. No token is read
or recorded.

```ts
import {
  AgenomicClient,
  HuggingFaceClient,
  instrumentHuggingFace,
  traceAgentRun,
} from "agenomic-typescript";

const client = new AgenomicClient();
const hf = instrumentHuggingFace(new HuggingFaceClient());

const run = traceAgentRun({ client, agentId: "hf-agent" }, async () => {
  return hf.generateText("gpt2", "Hello", { max_new_tokens: 16 });
});
```
