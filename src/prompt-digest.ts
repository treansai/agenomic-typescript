import { createHash } from "node:crypto";

import { PromptRenderError } from "./errors";

export const MAX_SAFE_JSON_INTEGER = 9007199254740991;
export const CONTENT_SCHEMA = "agenomic.prompt_content/v1";
export const MANIFEST_SCHEMA = "agenomic.prompt_manifest/v1";
export const ARTIFACT_SET_SCHEMA = "agenomic.prompt_artifact_set/v1";

const MAX_JSON_DEPTH = 64;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export interface AjsViolation {
  code: string;
  value_path: string;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

export function pointer(base: string, key: string | number): string {
  return `${base}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

export function stringViolation(value: string, path: string): AjsViolation | undefined {
  if (LONE_SURROGATE.test(value)) return { code: "invalid_unicode", value_path: path };
  if (value.includes("\u0000")) return { code: "nul_character", value_path: path };
  return undefined;
}

function violation(value: unknown, path: string, depth: number): AjsViolation | undefined {
  if (value === null || typeof value === "boolean") return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return { code: "float_not_allowed", value_path: path };
    if (Math.abs(value) > MAX_SAFE_JSON_INTEGER) return { code: "integer_out_of_range", value_path: path };
    return undefined;
  }
  if (typeof value === "string") return stringViolation(value, path);
  if (Array.isArray(value)) {
    if (depth + 1 > MAX_JSON_DEPTH) return { code: "json_too_deep", value_path: path };
    for (let index = 0; index < value.length; index += 1) {
      const itemPath = pointer(path, index);
      if (!Object.hasOwn(value, index)) return { code: "invalid_field_type", value_path: itemPath };
      const found = violation(value[index], itemPath, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (isPlainRecord(value)) {
    if (depth + 1 > MAX_JSON_DEPTH) return { code: "json_too_deep", value_path: path };
    for (const key of sortedKeys(value)) {
      const keyPath = pointer(path, key);
      const found = stringViolation(key, keyPath) ?? violation(value[key], keyPath, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  return { code: "invalid_field_type", value_path: path };
}

export function ajsViolation(value: unknown, path = ""): AjsViolation | undefined {
  return violation(value, path, 0);
}

export function ensureAjs(value: unknown, path = ""): void {
  const found = ajsViolation(value, path);
  if (found) {
    throw new PromptRenderError("prompt_render_error", 0, `value outside the JSON subset: ${found.code} at ${found.value_path || "/"}`, {
      reason: found.code,
      value_path: found.value_path,
      errors: [{ ...found }],
    });
  }
}

export function normalizedJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => normalizedJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${sortedKeys(record)
    .map((key) => `${JSON.stringify(key)}:${normalizedJson(record[key])}`)
    .join(",")}}`;
}

export function canonicalJsonV1(value: unknown): string {
  ensureAjs(value);
  return normalizedJson(value);
}

function sha256Digest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function promptDigest(value: unknown): string {
  return sha256Digest(canonicalJsonV1(value));
}

export function contentDigest(content: unknown): string {
  return promptDigest(content);
}

export function manifestDigest(manifest: unknown): string {
  return promptDigest(manifest);
}

export function safeDigest(value: unknown): string | undefined {
  return ajsViolation(value) ? undefined : sha256Digest(normalizedJson(value));
}

export function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
