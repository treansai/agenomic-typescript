/**
 * The `client.models` resource.
 *
 * `client.models.configure({ provider, model, task })` validates the provider
 * and produces a normalized, persistable model configuration. It is
 * provider-agnostic, but performs extra validation for Hugging Face aliases and
 * normalizes them to the canonical `"huggingface"` name.
 *
 * When a `path` is supplied, the resolved config is appended/merged into a
 * local `genome.yaml` under a `models:` list (created if absent).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgenomicClient } from "./client";
import {
  isHuggingFace,
  normalizeProvider,
} from "./providers/huggingface";

export interface ConfigureModelInput {
  /** Provider name or alias (e.g. `hf`, `huggingface`). */
  provider: string;
  /** Model id (e.g. `mistralai/Mistral-7B-Instruct-v0.3`). */
  model: string;
  /** Optional task / pipeline tag (e.g. `text-generation`). */
  task?: string;
  /** Optional model revision (defaults to `main` for huggingface). */
  revision?: string;
  /** Optional inference parameters captured with the config. */
  parameters?: Record<string, unknown>;
  /** Optional logical name for this model entry. */
  name?: string;
  /**
   * Optional path to a local `genome.yaml`. When set, the normalized config is
   * persisted (merged by `provider` + `model`).
   */
  path?: string;
}

/** A normalized model configuration. */
export interface ModelConfig {
  provider: string;
  model: string;
  task?: string;
  revision?: string;
  parameters?: Record<string, unknown>;
  name?: string;
}

function normalize(input: ConfigureModelInput): ModelConfig {
  if (!input.provider || input.provider.trim().length === 0) {
    throw new Error("models.configure: `provider` is required");
  }
  if (!input.model || input.model.trim().length === 0) {
    throw new Error("models.configure: `model` is required");
  }

  const provider = normalizeProvider(input.provider);
  if (!provider) {
    throw new Error(
      `models.configure: unrecognized provider \"${input.provider}\"`,
    );
  }

  const config: ModelConfig = {
    provider,
    model: input.model.trim(),
  };

  if (isHuggingFace(input.provider)) {
    // Hugging Face model ids are `namespace/name` or a bare name; reject obvious
    // junk like URLs or whitespace.
    if (/\s/.test(config.model) || /^https?:\/\//i.test(config.model)) {
      throw new Error(
        `models.configure: invalid huggingface model id \"${config.model}\"`,
      );
    }
    config.revision = input.revision ?? "main";
  } else if (input.revision) {
    config.revision = input.revision;
  }

  if (input.task) config.task = input.task;
  if (input.parameters) config.parameters = input.parameters;
  if (input.name) config.name = input.name;

  return config;
}

/** Minimal YAML emitter for the `genome.yaml` model list (no dependency). */
function toYaml(models: ModelConfig[]): string {
  const lines: string[] = ["models:"];
  for (const model of models) {
    lines.push(`  - provider: ${yamlScalar(model.provider)}`);
    lines.push(`    model: ${yamlScalar(model.model)}`);
    if (model.name !== undefined) lines.push(`    name: ${yamlScalar(model.name)}`);
    if (model.task !== undefined) lines.push(`    task: ${yamlScalar(model.task)}`);
    if (model.revision !== undefined) lines.push(`    revision: ${yamlScalar(model.revision)}`);
    if (model.parameters !== undefined) {
      lines.push(`    parameters:`);
      for (const [key, value] of Object.entries(model.parameters)) {
        lines.push(`      ${key}: ${yamlScalar(value)}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const str = String(value);
  // Quote when the scalar could be misparsed.
  if (str.length === 0 || /[:#\-{}\[\],&*!|>'"%@`]/.test(str) || /^\s|\s$/.test(str)) {
    return JSON.stringify(str);
  }
  return str;
}

/**
 * Parse the `models:` list out of an existing genome.yaml. Intentionally
 * minimal — it understands only the shape this resource writes — so it can merge
 * without pulling in a YAML dependency.
 */
function parseModels(yaml: string): ModelConfig[] {
  const models: ModelConfig[] = [];
  const lines = yaml.split(/\r?\n/);
  let inModels = false;
  let current: Partial<ModelConfig> | null = null;
  let inParams = false;

  const flush = () => {
    if (current?.provider && current.model) {
      models.push(current as ModelConfig);
    }
    current = null;
    inParams = false;
  };

  for (const line of lines) {
    if (/^models:\s*$/.test(line)) {
      inModels = true;
      continue;
    }
    if (!inModels) continue;
    if (/^\S/.test(line)) {
      // dedented back to a top-level key → models block ended.
      break;
    }
    const itemMatch = line.match(/^\s*-\s*provider:\s*(.+)$/);
    if (itemMatch) {
      flush();
      current = { provider: unquote(itemMatch[1]!) };
      continue;
    }
    if (!current) continue;
    const paramsMatch = line.match(/^\s{4}parameters:\s*$/);
    if (paramsMatch) {
      current.parameters = {};
      inParams = true;
      continue;
    }
    const kv = line.match(/^\s+(\w+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!;
    const value = unquote(kv[2]!);
    if (inParams && /^\s{6}/.test(line)) {
      (current.parameters as Record<string, unknown>)[key] = value;
      continue;
    }
    inParams = false;
    if (key === "model") current.model = value;
    else if (key === "name") current.name = value;
    else if (key === "task") current.task = value;
    else if (key === "revision") current.revision = value;
  }
  flush();
  return models;
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    try {
      return JSON.parse(value.startsWith("'") ? `"${value.slice(1, -1)}"` : value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

async function persist(path: string, config: ModelConfig): Promise<void> {
  let existing: ModelConfig[] = [];
  try {
    existing = parseModels(await readFile(path, "utf8"));
  } catch {
    existing = [];
  }
  const idx = existing.findIndex(
    (m) => m.provider === config.provider && m.model === config.model,
  );
  if (idx >= 0) existing[idx] = config;
  else existing.push(config);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, toYaml(existing), "utf8");
}

/** The `client.models` namespace. */
export class ModelsResource {
  // The client is accepted for symmetry with other resources and future
  // server-side configuration; configure() is currently local + provider-agnostic.
  constructor(private readonly client: AgenomicClient) {}

  /**
   * Validate and normalize a model configuration. When `path` is provided, the
   * config is also persisted to a local `genome.yaml`.
   */
  async configure(input: ConfigureModelInput): Promise<ModelConfig> {
    void this.client;
    const config = normalize(input);
    if (input.path) {
      await persist(input.path, config);
    }
    return config;
  }
}
