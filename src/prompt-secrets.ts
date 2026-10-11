import { isPlainRecord } from "./prompt-digest";

export const SECRET_PATTERN_SET = "agenomic-secrets/1";
const REDACTED = "[REDACTED]";

const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["bearer_token", /\bbearer[\t\n\x0B\x0C\r ]+[A-Za-z0-9\-_.=+/]{20,}/gi],
  ["private_key_block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["openai_key", /\bsk-[A-Za-z0-9\-_]{20,}/g],
  ["stripe_key", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{36,}/g],
  ["huggingface_token", /\bhf_[A-Za-z0-9]{20,}/g],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9\-]{10,}/g],
  ["google_api_key", /\bAIza[0-9A-Za-z\-_]{35}/g],
  ["jwt", /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g],
  ["agenomic_api_key", /\bagm_[A-Za-z0-9]{24,}/g],
];

const TOKEN_WORDS = new Set(["secret", "password", "passwd", "token", "credential", "credentials", "authorization", "cookie"]);
const COLLAPSED_SUFFIXES = [
  "apikey",
  "secret",
  "password",
  "passwd",
  "token",
  "credential",
  "credentials",
  "authorization",
  "cookie",
  "privatekey",
  "accesskey",
  "clientsecret",
];
const NORMALIZED_SUFFIXES = ["_api_key", "_private_key", "_access_key", "_client_secret"];

export interface SecretFinding {
  pattern: string;
  offset: number;
  length: number;
}

function codePointIndex(text: string): Uint32Array {
  const index = new Uint32Array(text.length + 1);
  let count = 0;
  for (let unit = 0; unit < text.length; unit += 1) {
    index[unit] = count;
    const code = text.charCodeAt(unit);
    const next = unit + 1 < text.length ? text.charCodeAt(unit + 1) : 0;
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      index[unit + 1] = count;
      unit += 1;
    }
    count += 1;
  }
  index[text.length] = count;
  return index;
}

export function scanSecrets(text: string): SecretFinding[] {
  const found: Array<SecretFinding & { order: number }> = [];
  let positions: Uint32Array | undefined;
  SECRET_PATTERNS.forEach(([pattern, source], order) => {
    const expression = new RegExp(source.source, source.flags);
    let match: RegExpExecArray | null;
    while ((match = expression.exec(text)) !== null) {
      positions ??= codePointIndex(text);
      const start = positions[match.index] ?? 0;
      const end = positions[match.index + match[0].length] ?? start;
      found.push({
        pattern,
        offset: start,
        length: end - start,
        order,
      });
    }
  });
  found.sort((left, right) => left.offset - right.offset || left.order - right.order);
  return found.map(({ pattern, offset, length }) => ({ pattern, offset, length }));
}

export function scrubSecrets(text: string): string {
  const spans: Array<{ start: number; end: number; pattern: string }> = [];
  for (const finding of scanSecrets(text)) {
    const end = finding.offset + finding.length;
    const last = spans[spans.length - 1];
    if (last && finding.offset <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      spans.push({ start: finding.offset, end, pattern: finding.pattern });
    }
  }
  if (spans.length === 0) return text;
  const points = Array.from(text);
  let out = "";
  let position = 0;
  for (const span of spans) {
    out += `${points.slice(position, span.start).join("")}[REDACTED:${span.pattern}]`;
    position = span.end;
  }
  return out + points.slice(position).join("");
}

export function isSecretShapedKey(key: string): boolean {
  const normalized = Array.from(key, (char) => (/^[A-Za-z0-9]$/.test(char) ? char.toLowerCase() : "_")).join("");
  const tokens = normalized.split("_").filter((token) => token !== "");
  const collapsed = tokens.join("");
  return (
    tokens.some((token) => TOKEN_WORDS.has(token)) ||
    COLLAPSED_SUFFIXES.some((suffix) => collapsed.endsWith(suffix)) ||
    normalized === "apikey" ||
    NORMALIZED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

export function scrubSecretsJson(value: unknown): unknown {
  if (typeof value === "string") return scrubSecrets(value);
  if (Array.isArray(value)) return value.map((item) => scrubSecretsJson(item));
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).map((key) => [key, isSecretShapedKey(key) ? REDACTED : scrubSecretsJson(value[key])]),
    );
  }
  return value;
}
