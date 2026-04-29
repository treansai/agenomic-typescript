import type {
  RedactionInput,
  RedactionMode,
  RedactionRule,
  TraceEnvelope,
  TraceEvent,
} from "./models";
import { cloneValue, hashValue, isRecord, nowIso } from "./utils";

export interface ApplyRedactionOptions {
  defaultMode?: RedactionMode;
}

function isNumericKey(segment: string): boolean {
  return /^\d+$/.test(segment);
}

function maskValue(): string {
  return "[REDACTED]";
}

function mutateTerminal(
  parent: Record<string, unknown> | unknown[],
  segment: string,
  mode: RedactionMode,
): void {
  const key = Array.isArray(parent) && isNumericKey(segment) ? Number(segment) : segment;
  const currentValue = parent[key as keyof typeof parent];

  if (currentValue === undefined) {
    return;
  }

  if (mode === "remove") {
    if (Array.isArray(parent) && typeof key === "number") {
      parent[key] = undefined;
      return;
    }

    delete (parent as Record<string, unknown>)[segment];
    return;
  }

  if (mode === "mask") {
    parent[key as keyof typeof parent] = maskValue() as never;
    return;
  }

  parent[key as keyof typeof parent] = hashValue(currentValue) as never;
}

function walkRule(
  current: unknown,
  segments: string[],
  mode: RedactionMode,
): void {
  if (segments.length === 0 || (!Array.isArray(current) && !isRecord(current))) {
    return;
  }

  const [segment, ...rest] = segments;
  if (!segment) {
    return;
  }

  if (segment === "*") {
    if (Array.isArray(current)) {
      if (rest.length === 0) {
        for (let index = 0; index < current.length; index += 1) {
          mutateTerminal(current, String(index), mode);
        }
        return;
      }

      for (const item of current) {
        walkRule(item, rest, mode);
      }
      return;
    }

    const entries = Object.keys(current);
    if (rest.length === 0) {
      for (const key of entries) {
        mutateTerminal(current, key, mode);
      }
      return;
    }

    for (const key of entries) {
      walkRule(current[key], rest, mode);
    }
    return;
  }

  if (rest.length === 0) {
    mutateTerminal(current, segment, mode);
    return;
  }

  const nextValue = Array.isArray(current) && isNumericKey(segment)
    ? current[Number(segment)]
    : isRecord(current)
      ? current[segment]
      : undefined;

  walkRule(nextValue, rest, mode);
}

export function normalizeRedactionRules(
  input?: RedactionInput,
  defaultMode: RedactionMode = "mask",
): RedactionRule[] {
  if (!input || input.length === 0) {
    return [];
  }

  return input.map((entry) =>
    typeof entry === "string" ? { path: entry, mode: defaultMode } : entry,
  );
}

export function applyRedaction<T>(
  value: T,
  rules?: RedactionInput,
  options: ApplyRedactionOptions = {},
): T {
  if (value === undefined || !rules || rules.length === 0) {
    return value;
  }

  const normalizedRules = normalizeRedactionRules(
    rules,
    options.defaultMode ?? "mask",
  );
  const clone = cloneValue(value);

  for (const rule of normalizedRules) {
    const segments = rule.path.split(".").filter(Boolean);
    walkRule(clone, segments, rule.mode);
  }

  return clone;
}

function redactEvent(event: TraceEvent, rules: RedactionRule[]): TraceEvent {
  const clone = cloneValue(event);

  if ("input" in clone && clone.input !== undefined) {
    clone.input = applyRedaction(clone.input, rules);
  }

  if ("output" in clone && clone.output !== undefined) {
    clone.output = applyRedaction(clone.output, rules);
  }

  if ("query" in clone && clone.query !== undefined) {
    clone.query = applyRedaction(clone.query, rules);
  }

  return clone;
}

export function redactTraceEnvelope(
  trace: TraceEnvelope,
  rules?: RedactionInput,
  defaultMode: RedactionMode = "mask",
): TraceEnvelope {
  const normalizedRules = normalizeRedactionRules(rules, defaultMode);
  if (normalizedRules.length === 0) {
    return trace;
  }

  const clone = cloneValue(trace);

  if (clone.run.input !== undefined) {
    clone.run.input = applyRedaction(clone.run.input, normalizedRules);
  }

  if (clone.run.output !== undefined) {
    clone.run.output = applyRedaction(clone.run.output, normalizedRules);
  }

  clone.events = clone.events.map((event) => redactEvent(event, normalizedRules));
  clone.redaction = {
    rules: normalizedRules,
    appliedAt: nowIso(),
  };

  return clone;
}
