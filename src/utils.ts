import { createHash, randomUUID } from "node:crypto";

import type { ErrorInfo } from "./models";

export const TRACE_SPEC_VERSION = "agenomic.trace.v1";
export const SDK_METADATA = {
  name: "agenomic-typescript",
  language: "typescript",
  runtime: "node",
} as const;

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function diffMilliseconds(
  startedAt?: string,
  endedAt?: string,
): number | undefined {
  if (!startedAt || !endedAt) {
    return undefined;
  }

  const diff = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(diff) && diff >= 0 ? diff : undefined;
}

export function normalizeError(error: unknown): ErrorInfo {
  if (error instanceof Error) {
    const errorWithCode = error as Error & { code?: unknown };
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: typeof errorWithCode.code === "string" ? errorWithCode.code : undefined,
    };
  }

  if (
    isRecord(error) &&
    typeof error.name === "string" &&
    typeof error.message === "string"
  ) {
    return {
      name: error.name,
      message: error.message,
      stack: typeof error.stack === "string" ? error.stack : undefined,
      code: typeof error.code === "string" ? error.code : undefined,
    };
  }

  if (typeof error === "string") {
    return {
      name: "Error",
      message: error,
    };
  }

  return {
    name: "Error",
    message: "Unknown error",
    stack: stableStringify(error),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneValue<T>(value: T): T {
  if (value === undefined) {
    return value;
  }

  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return normalizeError(value);
  }

  if (isRecord(value)) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = sortValue(value[key]);
        return accumulator;
      }, {});
  }

  return value;
}

export function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }

  return JSON.stringify(sortValue(value));
}

export function hashValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function maybeHash(value: unknown): string | undefined {
  return value === undefined ? undefined : hashValue(value);
}

export function withDefined<T extends Record<string, unknown>>(
  value: T,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}
