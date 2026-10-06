import { PromptRenderError, PromptTemplateError, integrityError } from "./errors";
import {
  CONTENT_SCHEMA,
  ajsViolation,
  codePointLength,
  deepFreeze,
  isPlainRecord,
  jsonCopy,
  normalizedJson,
  pointer,
  promptDigest,
  safeDigest,
  sortedKeys,
  stringViolation,
  MAX_SAFE_JSON_INTEGER,
} from "./prompt-digest";
import type { PromptVersionRef } from "./prompt-refs";
import { isSecretShapedKey, scanSecrets } from "./prompt-secrets";

export const TEMPLATE_FORMAT = "agenomic-fstring/v1";
export const RENDERER_VERSION = "1";
export const SUPPORTED_RENDERER_VERSIONS: readonly string[] = ["1"];

const RENDERED_SCHEMA = "agenomic.rendered_prompt/v1";
const CONTENT_MEMBERS = [
  "schema",
  "template_format",
  "renderer_version",
  "kind",
  "body",
  "variables",
  "partials",
  "output_contract",
  "fragments",
] as const;
const VARIABLE_TYPES = new Set(["string", "integer", "boolean", "json", "messages"]);
const CHAT_ROLES = new Set(["system", "user", "assistant"]);
const MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);
const MAX_FRAGMENT_DEPTH = 8;
const MAX_FRAGMENT_EXPANSIONS = 256;
const MAX_TEMPLATE_CODE_POINTS = 65536;
const MAX_CONTENT_BYTES = 262144;
const MAX_EXPANDED_CODE_POINTS = 1048576;
const MAX_RENDERED_CODE_POINTS = 4194304;
const MAX_OUTPUT_CONTRACT_BYTES = 65536;
const MAX_OUTPUT_CONTRACT_DEPTH = 32;
const MAX_CHAT_MESSAGES = 256;
const MAX_VARIABLES = 128;
const MAX_FRAGMENTS = 32;
const MAX_VERSION = 2147483647;
const CONTENT_TOO_LARGE_REASONS = new Set([
  "content_too_large",
  "template_too_large",
  "too_many_messages",
  "too_many_variables",
  "too_many_fragments",
]);
const NAMED_CONTENT_CODES = new Map([
  ["prompt_kind_mismatch", "prompt_kind_mismatch"],
  ["fragment_cycle", "prompt_fragment_cycle"],
  ["fragment_depth_exceeded", "prompt_fragment_depth_exceeded"],
]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME_CHAR = /^[A-Za-z0-9_]$/;
const PROMPT_ID = /^prm_[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SPECIAL: ReadonlyMap<string, string> = new Map([
  ["!", "conversion"],
  [":", "format_spec"],
  [".", "attribute_access"],
  ["[", "index_access"],
]);

export type PromptKind = "text" | "chat" | "fragment";
export type VariableType = "string" | "integer" | "boolean" | "json" | "messages";
export type SecretPolicy = "off" | "error";

export interface VariableSpec {
  type: VariableType;
  required: boolean;
}

export interface FragmentPin {
  prompt_id: string;
  version: number;
  content_digest: string;
}

export interface TemplateMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Placeholder {
  placeholder: string;
  optional: boolean;
}

export interface PromptContent {
  schema: "agenomic.prompt_content/v1";
  template_format: "agenomic-fstring/v1";
  renderer_version: "1";
  kind: "text" | "chat";
  body: string | Array<TemplateMessage | Placeholder>;
  variables: Record<string, VariableSpec>;
  partials: Record<string, string | number | boolean | null>;
  output_contract: { type: "json_schema"; json_schema: Record<string, unknown> } | null;
  fragments: Record<string, FragmentPin>;
}

export interface FragmentEntry {
  promptKind?: PromptKind | null;
  content: unknown;
}

export type FragmentSource = (promptId: string, version: number, contentDigest: string) => FragmentEntry | undefined;

export interface PromptIssue {
  code: string;
  path?: string;
  offset?: number;
  line?: number;
  column?: number;
  syntax?: string;
  variable?: string;
  value_path?: string;
  pattern?: string;
  fragment?: string;
}

export interface SecretLocation {
  pattern: string;
  path: string;
  offset: number;
  length: number;
}

export interface ValidationReport {
  ok: boolean;
  errors: PromptIssue[];
  warnings: PromptIssue[];
  findings: SecretLocation[];
  variables: { declared: string[]; referenced: string[]; placeholders: string[] };
  contentDigest: string | null;
}

export type TemplateToken =
  | { t: "literal"; text: string }
  | { t: "var"; name: string; offset: number }
  | { t: "include"; name: string; offset: number };

export type VariableValues = Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>;

export interface RenderOptions {
  strict?: boolean;
  history?: ReadonlyArray<unknown> | null;
  allowDuplicateSystem?: boolean;
  secretPolicy?: SecretPolicy;
  expectKind?: "text" | "chat";
}

export interface RenderedMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RenderedPrompt {
  kind: "text" | "chat";
  text: string | null;
  messages: unknown[] | null;
  renderedHash: string;
  contentDigest: string;
  warnings: PromptIssue[];
  expandedTemplate: string | Array<Record<string, unknown>>;
  renderedDocument: Record<string, unknown>;
}

export interface ResolvedFrom {
  readonly alias: string;
  readonly generation: number;
}

export interface ManagedPromptVersion {
  readonly ref: PromptVersionRef;
  readonly workspaceId: string;
  readonly kind: PromptKind;
  readonly contentDigest: string;
  readonly content: PromptContent;
  readonly fragments: Readonly<Record<string, ManagedPromptVersion>>;
  readonly resolvedFrom?: ResolvedFrom;
}

export interface PromptVersionRecord {
  prompt_id: string;
  version: number;
  prompt_kind?: PromptKind | null;
  content_digest: string;
  content: unknown;
}

export type RecordLookup = (promptId: string, version: number) => PromptVersionRecord | undefined;

interface Origin {
  key: string;
  variables: unknown;
}

type Token =
  | { t: "literal"; text: string }
  | { t: "var"; name: string; offset: number; origin?: Origin }
  | { t: "include"; name: string; offset: number };

type Content = Record<string, unknown> & {
  kind: "text" | "chat";
  body: unknown;
  variables: Record<string, Record<string, unknown> & { type: VariableType; required: boolean }>;
  partials: Record<string, unknown>;
  fragments: Record<string, unknown>;
  output_contract: unknown;
};

interface Validated {
  report: ValidationReport;
  content?: Content;
  expanded?: Map<string, Token[]>;
}

class IssueFailure extends Error {
  constructor(readonly issue: PromptIssue) {
    super(issue.code);
  }
}

class SyntaxFailure extends Error {
  constructor(
    readonly syntax: string,
    readonly offset: number,
    readonly line: number,
    readonly column: number,
  ) {
    super(syntax);
  }

  issue(extra: Partial<PromptIssue> = {}): PromptIssue {
    return { code: "syntax_error", syntax: this.syntax, offset: this.offset, line: this.line, column: this.column, ...extra };
  }
}

const hasOwn = (value: object, key: string): boolean => Object.hasOwn(value, key);

function clean(issue: PromptIssue): PromptIssue {
  const out: PromptIssue = { code: issue.code };
  for (const key of Object.keys(issue) as Array<keyof PromptIssue>) {
    if (issue[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = issue[key];
  }
  return out;
}

function itemDetails(item: PromptIssue): Record<string, unknown> {
  const details: Record<string, unknown> = { reason: item.code, errors: [item] };
  for (const key of Object.keys(item)) {
    if (key !== "code") details[key] = (item as unknown as Record<string, unknown>)[key];
  }
  return details;
}

function renderFailure(item: PromptIssue): PromptRenderError {
  return new PromptRenderError("prompt_render_error", 0, `render failed: ${item.code}`, itemDetails(item));
}

function syntaxFailure(syntax: string, offset: number, points: readonly string[]): SyntaxFailure {
  let line = 1;
  let last = -1;
  for (let index = 0; index < offset; index += 1) {
    if (points[index] === "\n") {
      line += 1;
      last = index;
    }
  }
  return new SyntaxFailure(syntax, offset, line, offset - last);
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 64 && NAME.test(value);
}

function classify(inner: readonly string[], offset: number, points: readonly string[]): string {
  if (inner.length === 0) throw syntaxFailure("empty_placeholder", offset, points);
  if (inner.includes("{")) throw syntaxFailure("nested_placeholder", offset, points);
  for (const char of inner) {
    if (NAME_CHAR.test(char)) continue;
    const special = SPECIAL.get(char);
    if (special !== undefined) throw syntaxFailure(special, offset, points);
    const code = char.codePointAt(0) ?? 0;
    if ((code >= 0x09 && code <= 0x0d) || code === 0x20) throw syntaxFailure("whitespace_in_placeholder", offset, points);
    throw syntaxFailure("invalid_placeholder_name", offset, points);
  }
  const name = inner.join("");
  if (/^[0-9]+$/.test(name)) throw syntaxFailure("positional_placeholder", offset, points);
  if (/^[0-9]/.test(name)) throw syntaxFailure("invalid_placeholder_name", offset, points);
  if (inner.length > 64) throw syntaxFailure("placeholder_name_too_long", offset, points);
  return name;
}

function tokenize(template: string): Token[] {
  const points = Array.from(template);
  const out: Token[] = [];
  let literal = "";
  let index = 0;
  const flush = (): void => {
    if (literal !== "") {
      out.push({ t: "literal", text: literal });
      literal = "";
    }
  };
  while (index < points.length) {
    const char = points[index];
    if (char === "{") {
      if (points[index + 1] === "{") {
        literal += "{";
        index += 2;
        continue;
      }
      const close = points.indexOf("}", index + 1);
      if (close < 0) throw syntaxFailure("unclosed_brace", index, points);
      const inner = points.slice(index + 1, close);
      flush();
      if (inner[0] === ">") {
        const name = inner.slice(1).join("");
        if (!isName(name)) throw syntaxFailure("invalid_fragment_name", index, points);
        out.push({ t: "include", name, offset: index });
      } else {
        out.push({ t: "var", name: classify(inner, index, points), offset: index });
      }
      index = close + 1;
      continue;
    }
    if (char === "}") {
      if (points[index + 1] === "}") {
        literal += "}";
        index += 2;
        continue;
      }
      throw syntaxFailure("unmatched_closing_brace", index, points);
    }
    literal += char;
    index += 1;
  }
  flush();
  return out;
}

export function tokenizeTemplate(template: string): TemplateToken[] {
  try {
    return tokenize(template);
  } catch (error) {
    if (!(error instanceof SyntaxFailure)) throw error;
    throw new PromptTemplateError("prompt_template_invalid", 0, `template syntax error: ${error.syntax}`, itemDetails(error.issue()));
  }
}

export function templateSource(tokens: ReadonlyArray<TemplateToken>): string {
  return tokens
    .map((token) => {
      if (token.t === "literal") return token.text.replace(/\{/g, "{{").replace(/\}/g, "}}");
      if (token.t === "var") return `{${token.name}}`;
      return `{>${token.name}}`;
    })
    .join("");
}

function merge(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  for (const token of tokens) {
    if (token.t === "literal") {
      if (token.text === "") continue;
      const last = out[out.length - 1];
      if (last && last.t === "literal") {
        out[out.length - 1] = { t: "literal", text: last.text + token.text };
        continue;
      }
    }
    out.push(token);
  }
  return out;
}

function validPin(pin: unknown): pin is FragmentPin {
  if (!isPlainRecord(pin)) return false;
  if (sortedKeys(pin).join(",") !== "content_digest,prompt_id,version") return false;
  const { prompt_id: promptId, version, content_digest: digest } = pin;
  return (
    typeof promptId === "string" &&
    promptId.length <= 64 &&
    PROMPT_ID.test(promptId) &&
    typeof version === "number" &&
    Number.isInteger(version) &&
    version >= 1 &&
    version <= MAX_VERSION &&
    typeof digest === "string" &&
    SHA256.test(digest)
  );
}

function fragmentKindIssue(entry: FragmentEntry, path: string, key: string): PromptIssue | undefined {
  if (entry.promptKind !== undefined && entry.promptKind !== null && entry.promptKind !== "fragment") {
    return { code: "fragment_not_fragment", path, fragment: key };
  }
  const content = entry.content;
  if (!isPlainRecord(content) || content.kind !== "text") return { code: "fragment_not_text", path, fragment: key };
  if (!isPlainRecord(content.partials) || Object.keys(content.partials).length > 0) {
    return { code: "fragment_has_partials", path, fragment: key };
  }
  if (!hasOwn(content, "output_contract") || content.output_contract !== null) {
    return { code: "fragment_has_output_contract", path, fragment: key };
  }
  return undefined;
}

function templates(content: Record<string, unknown>): Array<[string, unknown]> {
  if (content.kind === "text") return [["/body", content.body]];
  const out: Array<[string, unknown]> = [];
  if (Array.isArray(content.body)) {
    content.body.forEach((entry: unknown, index) => {
      if (isPlainRecord(entry) && hasOwn(entry, "role")) out.push([`/body/${index}/content`, entry.content]);
    });
  }
  return out;
}

function jsonDepth(value: unknown): number {
  if (Array.isArray(value)) return 1 + value.reduce<number>((max, item) => Math.max(max, jsonDepth(item)), 0);
  if (isPlainRecord(value)) return 1 + Object.keys(value).reduce((max, key) => Math.max(max, jsonDepth(value[key])), 0);
  return 0;
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function contentSecrets(content: Content): SecretLocation[] {
  const out: SecretLocation[] = [];
  const push = (text: string, path: string): void => {
    for (const finding of scanSecrets(text)) out.push({ pattern: finding.pattern, path, offset: finding.offset, length: finding.length });
  };
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") push(value, path);
    else if (Array.isArray(value)) value.forEach((item, index) => walk(item, pointer(path, index)));
    else if (isPlainRecord(value)) for (const key of sortedKeys(value)) walk(value[key], pointer(path, key));
  };
  if (content.kind === "text" && typeof content.body === "string") push(content.body, "/body");
  if (content.kind === "chat" && Array.isArray(content.body)) {
    content.body.forEach((entry: unknown, index) => {
      if (isPlainRecord(entry) && typeof entry.content === "string") push(entry.content, `/body/${index}/content`);
    });
  }
  if (isPlainRecord(content.partials)) {
    for (const key of sortedKeys(content.partials)) {
      const value = content.partials[key];
      if (typeof value === "string") push(value, pointer("/partials", key));
    }
  }
  if (content.output_contract !== null && content.output_contract !== undefined) walk(content.output_contract, "/output_contract");
  return out;
}

function partialMatches(type: string, value: unknown): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "integer") return typeof value === "number";
  if (type === "boolean") return typeof value === "boolean";
  return type === "json";
}

function emptyReport(errors: PromptIssue[], warnings: PromptIssue[], findings: SecretLocation[]): ValidationReport {
  return {
    ok: errors.length === 0,
    errors: errors.map(clean),
    warnings: warnings.map(clean),
    findings,
    variables: { declared: [], referenced: [], placeholders: [] },
    contentDigest: null,
  };
}

function validate(raw: unknown, fragments: FragmentSource, promptKind?: PromptKind | null): Validated {
  const errors: PromptIssue[] = [];
  const warnings: PromptIssue[] = [];
  let findings: SecretLocation[] = [];
  const error = (issue: PromptIssue): void => {
    errors.push(issue);
  };
  const warn = (issue: PromptIssue): void => {
    warnings.push(issue);
  };
  const stop = (): Validated => ({ report: emptyReport(errors, warnings, findings) });
  const lookup = (pin: FragmentPin): FragmentEntry | undefined => fragments(pin.prompt_id, pin.version, pin.content_digest);

  if (!isPlainRecord(raw)) {
    error({ code: "invalid_field_type", path: "" });
    return stop();
  }
  if (!hasOwn(raw, "schema")) {
    error({ code: "missing_field", path: "/schema" });
    return stop();
  }
  if (raw.schema !== CONTENT_SCHEMA) {
    error({ code: "unsupported_schema", path: "/schema" });
    return stop();
  }
  const ajs = ajsViolation(raw);
  if (ajs) {
    error({ code: ajs.code, value_path: ajs.value_path });
    return stop();
  }
  let structural = false;
  for (const member of CONTENT_MEMBERS) {
    if (!hasOwn(raw, member)) {
      error({ code: "missing_field", path: `/${member}` });
      structural = true;
    }
  }
  for (const key of sortedKeys(raw)) {
    if (!(CONTENT_MEMBERS as readonly string[]).includes(key)) {
      error({ code: "unknown_field", path: pointer("", key) });
      structural = true;
    }
  }
  if (structural) return stop();

  if (raw.template_format !== TEMPLATE_FORMAT) error({ code: "unsupported_template_format", path: "/template_format" });
  if (raw.renderer_version !== RENDERER_VERSION) error({ code: "unsupported_renderer_version", path: "/renderer_version" });
  const kind = raw.kind;
  const body = raw.body;
  if (kind !== "text" && kind !== "chat") error({ code: "invalid_field_type", path: "/kind" });
  else if (kind === "text") {
    if (typeof body !== "string") error({ code: "invalid_body", path: "/body" });
  } else if (!Array.isArray(body)) error({ code: "invalid_body", path: "/body" });
  else if (body.length === 0) error({ code: "empty_chat", path: "/body" });
  else if (body.length > MAX_CHAT_MESSAGES) error({ code: "too_many_messages", path: "/body" });
  const declaredRaw = raw.variables;
  if (!isPlainRecord(declaredRaw)) error({ code: "invalid_field_type", path: "/variables" });
  else {
    if (Object.keys(declaredRaw).length > MAX_VARIABLES) error({ code: "too_many_variables", path: "/variables" });
    for (const name of sortedKeys(declaredRaw)) {
      const path = pointer("/variables", name);
      const declaration = declaredRaw[name];
      if (!isName(name)) {
        error({ code: "invalid_variable_name", path });
        continue;
      }
      if (!isPlainRecord(declaration)) {
        error({ code: "invalid_field_type", path });
        continue;
      }
      for (const member of ["type", "required"]) {
        if (!hasOwn(declaration, member)) error({ code: "missing_field", path: pointer(path, member) });
      }
      for (const member of sortedKeys(declaration)) {
        if (member !== "type" && member !== "required") error({ code: "unknown_field", path: pointer(path, member) });
      }
      if (hasOwn(declaration, "type") && !VARIABLE_TYPES.has(declaration.type as string)) {
        error({ code: "invalid_variable_type", path: pointer(path, "type") });
      }
      if (hasOwn(declaration, "required") && typeof declaration.required !== "boolean") {
        error({ code: "invalid_field_type", path: pointer(path, "required") });
      }
    }
  }
  if (!isPlainRecord(raw.partials)) error({ code: "invalid_field_type", path: "/partials" });
  if (!isPlainRecord(raw.fragments)) error({ code: "invalid_field_type", path: "/fragments" });
  else if (Object.keys(raw.fragments).length > MAX_FRAGMENTS) error({ code: "too_many_fragments", path: "/fragments" });
  if (errors.length) return stop();

  const content = raw as Content;
  for (const [path, text] of templates(content)) {
    if (typeof text === "string" && codePointLength(text) > MAX_TEMPLATE_CODE_POINTS) error({ code: "template_too_large", path });
  }
  if (utf8Length(normalizedJson(content)) > MAX_CONTENT_BYTES) error({ code: "content_too_large", path: "" });
  if (errors.length) return stop();

  findings = contentSecrets(content);

  if (content.kind === "chat") {
    (content.body as unknown[]).forEach((entry, index) => {
      const path = `/body/${index}`;
      if (!isPlainRecord(entry)) {
        error({ code: "invalid_message_entry", path });
        return;
      }
      const hasRole = hasOwn(entry, "role");
      const hasPlaceholder = hasOwn(entry, "placeholder");
      if (hasRole && hasPlaceholder) {
        error({ code: "invalid_message_entry", path });
      } else if (hasRole) {
        if (sortedKeys(entry).join(",") !== "content,role") error({ code: "invalid_message_entry", path });
        else if (typeof entry.role !== "string" || !CHAT_ROLES.has(entry.role)) error({ code: "unsupported_role", path: `${path}/role` });
        else if (Array.isArray(entry.content)) error({ code: "unsupported_content_block", path: `${path}/content` });
        else if (typeof entry.content !== "string") error({ code: "invalid_message_entry", path: `${path}/content` });
      } else if (hasPlaceholder) {
        if (sortedKeys(entry).join(",") !== "optional,placeholder") error({ code: "invalid_message_entry", path });
        else if (!isName(entry.placeholder)) error({ code: "invalid_message_entry", path: `${path}/placeholder` });
        else if (typeof entry.optional !== "boolean") error({ code: "invalid_message_entry", path: `${path}/optional` });
      } else {
        error({ code: "invalid_message_entry", path });
      }
    });
  }
  if (errors.length) return stop();

  const tokens = new Map<string, Token[]>();
  for (const [path, text] of templates(content)) {
    try {
      tokens.set(path, tokenize(text as string));
    } catch (failure) {
      if (!(failure instanceof SyntaxFailure)) throw failure;
      error(failure.issue({ path }));
    }
  }
  if (errors.length) return stop();

  for (const name of sortedKeys(content.fragments)) {
    const path = pointer("/fragments", name);
    const pin = content.fragments[name];
    if (!isName(name) || !validPin(pin)) {
      error({ code: "invalid_fragment_pin", path });
      continue;
    }
    const key = `${pin.prompt_id}:${pin.version}`;
    const entry = lookup(pin);
    if (entry === undefined || entry === null) {
      error({ code: "fragment_not_found", path, fragment: key });
      continue;
    }
    if (safeDigest(entry.content) !== pin.content_digest) {
      error({ code: "fragment_digest_mismatch", path, fragment: key });
      continue;
    }
    const issue = fragmentKindIssue(entry, path, key);
    if (issue) error(issue);
  }
  if (errors.length) return stop();

  const budget = { count: 0 };
  const expand = (
    items: readonly Token[],
    fragmentMap: unknown,
    depth: number,
    stack: readonly string[],
    path: string,
    origin: Origin | undefined,
  ): Token[] => {
    const out: Token[] = [];
    for (const token of items) {
      if (token.t !== "include") {
        out.push(token.t === "var" ? { ...token, origin } : token);
        continue;
      }
      if (!isPlainRecord(fragmentMap) || !hasOwn(fragmentMap, token.name)) {
        throw new IssueFailure({ code: "fragment_not_declared", path, offset: token.offset, fragment: origin?.key });
      }
      const pin = fragmentMap[token.name];
      if (!validPin(pin)) throw new IssueFailure({ code: "invalid_fragment_pin", path, fragment: origin?.key });
      const key = `${pin.prompt_id}:${pin.version}`;
      if (stack.includes(key)) throw new IssueFailure({ code: "fragment_cycle", path, fragment: key });
      if (depth + 1 > MAX_FRAGMENT_DEPTH) throw new IssueFailure({ code: "fragment_depth_exceeded", path, fragment: key });
      budget.count += 1;
      if (budget.count > MAX_FRAGMENT_EXPANSIONS) throw new IssueFailure({ code: "fragment_expansion_limit", path, fragment: key });
      const entry = lookup(pin);
      if (entry === undefined || entry === null) throw new IssueFailure({ code: "fragment_not_found", path, fragment: key });
      if (safeDigest(entry.content) !== pin.content_digest) throw new IssueFailure({ code: "fragment_digest_mismatch", path, fragment: key });
      const issue = fragmentKindIssue(entry, path, key);
      if (issue) throw new IssueFailure(issue);
      const fragment = entry.content as Record<string, unknown>;
      if (typeof fragment.body !== "string") throw new IssueFailure({ code: "fragment_not_text", path, fragment: key });
      let inner: Token[];
      try {
        inner = tokenize(fragment.body);
      } catch (failure) {
        if (!(failure instanceof SyntaxFailure)) throw failure;
        throw new IssueFailure(failure.issue({ path, fragment: key }));
      }
      out.push(...expand(inner, fragment.fragments, depth + 1, [...stack, key], path, { key, variables: fragment.variables }));
    }
    const merged = merge(out);
    if (codePointLength(templateSource(merged)) > MAX_EXPANDED_CODE_POINTS) {
      throw new IssueFailure({ code: "expanded_template_too_large", path });
    }
    return merged;
  };

  const expanded = new Map<string, Token[]>();
  for (const [path] of templates(content)) {
    try {
      expanded.set(path, expand(tokens.get(path) ?? [], content.fragments, 0, [], path, undefined));
    } catch (failure) {
      if (!(failure instanceof IssueFailure)) throw failure;
      error(failure.issue);
      break;
    }
  }
  if (errors.length) return stop();

  const included = new Set<string>();
  for (const items of tokens.values()) for (const token of items) if (token.t === "include") included.add(token.name);
  for (const name of sortedKeys(content.fragments)) {
    if (!included.has(name)) warn({ code: "fragment_unused", path: pointer("/fragments", name) });
  }

  const declared = content.variables;
  const used = new Set<string>();
  const placeholders = new Set<string>();
  const placeholderEntries: Array<[number, Placeholder]> = [];
  const checkUse = (token: Extract<Token, { t: "var" }>, path: string): void => {
    const name = token.name;
    used.add(name);
    if (!hasOwn(declared, name)) {
      error({ code: "undeclared_variable", path, variable: name });
      return;
    }
    const type = declared[name]!.type;
    if (type === "messages") {
      error({ code: "messages_outside_placeholder", path, variable: name });
      return;
    }
    const origin = token.origin;
    if (origin && isPlainRecord(origin.variables) && hasOwn(origin.variables, name)) {
      const fragmentDeclaration = origin.variables[name];
      const fragmentType = isPlainRecord(fragmentDeclaration) ? fragmentDeclaration.type : undefined;
      if (fragmentType !== type) error({ code: "fragment_variable_type_mismatch", path, variable: name, fragment: origin.key });
    }
  };
  if (content.kind === "text") {
    for (const token of expanded.get("/body") ?? []) if (token.t === "var") checkUse(token, "/body");
  } else {
    (content.body as Array<Record<string, unknown>>).forEach((entry, index) => {
      if (hasOwn(entry, "role")) {
        const path = `/body/${index}/content`;
        for (const token of expanded.get(path) ?? []) if (token.t === "var") checkUse(token, path);
        return;
      }
      const path = `/body/${index}`;
      const name = entry.placeholder as string;
      if (!hasOwn(declared, name)) error({ code: "undeclared_variable", path, variable: name });
      else if (declared[name]!.type !== "messages") error({ code: "placeholder_type_mismatch", path, variable: name });
      if (placeholders.has(name)) error({ code: "duplicate_placeholder", path, variable: name });
      placeholders.add(name);
      placeholderEntries.push([index, entry as unknown as Placeholder]);
    });
  }
  if (content.kind === "text") {
    for (const name of sortedKeys(declared)) {
      if (declared[name]!.type === "messages") {
        error({ code: "messages_outside_placeholder", path: pointer("/variables", name), variable: name });
      }
    }
  }
  if (errors.length) return stop();
  for (const name of sortedKeys(declared)) {
    if (!used.has(name) && !placeholders.has(name)) warn({ code: "variable_unused", path: pointer("/variables", name), variable: name });
  }

  const partials = content.partials;
  for (const [index, entry] of placeholderEntries) {
    if (declared[entry.placeholder]!.required !== !entry.optional) {
      error({ code: "placeholder_required_mismatch", path: `/body/${index}`, variable: entry.placeholder });
    }
  }
  for (const name of sortedKeys(declared)) {
    const declaration = declared[name]!;
    if (declaration.type === "messages") continue;
    const path = pointer("/variables", name);
    const hasPartial = hasOwn(partials, name);
    if (hasPartial && declaration.required) error({ code: "partial_required_mismatch", path, variable: name });
    if (!hasPartial && !declaration.required) error({ code: "optional_without_partial", path, variable: name });
  }
  if (errors.length) return stop();

  for (const name of sortedKeys(partials)) {
    const path = pointer("/partials", name);
    const value = partials[name];
    if (!hasOwn(declared, name)) {
      error({ code: "partial_for_unknown_variable", path, variable: name });
      continue;
    }
    const type = declared[name]!.type;
    if (type === "messages") {
      error({ code: "partial_for_messages_variable", path, variable: name });
      continue;
    }
    if (Array.isArray(value) || isPlainRecord(value)) {
      error({ code: "partial_not_scalar", path, variable: name });
      continue;
    }
    if (!partialMatches(type, value)) error({ code: "partial_type_mismatch", path, variable: name });
  }
  if (errors.length) return stop();

  const contract = content.output_contract;
  if (contract !== null) {
    let good =
      isPlainRecord(contract) &&
      sortedKeys(contract).join(",") === "json_schema,type" &&
      contract.type === "json_schema" &&
      isPlainRecord(contract.json_schema);
    if (good) {
      const schema = (contract as Record<string, unknown>).json_schema;
      good = utf8Length(normalizedJson(schema)) <= MAX_OUTPUT_CONTRACT_BYTES && jsonDepth(schema) <= MAX_OUTPUT_CONTRACT_DEPTH;
    }
    if (!good) error({ code: "output_contract_invalid", path: "/output_contract" });
  }
  if (errors.length) return stop();

  for (const finding of findings) {
    error({ code: "secret_detected", pattern: finding.pattern, path: finding.path, offset: finding.offset });
  }
  for (const name of sortedKeys(declared)) {
    if (isSecretShapedKey(name)) warn({ code: "secret_shaped_variable_name", path: pointer("/variables", name), variable: name });
  }
  if (errors.length) return stop();

  if (promptKind !== undefined && promptKind !== null) {
    const wanted = promptKind === "chat" ? "chat" : "text";
    if (content.kind !== wanted) {
      error({ code: "prompt_kind_mismatch", path: "/kind" });
      return stop();
    }
  }

  return {
    report: {
      ok: true,
      errors: [],
      warnings: warnings.map(clean),
      findings,
      variables: {
        declared: sortedKeys(declared),
        referenced: [...used].sort(),
        placeholders: [...placeholders].sort(),
      },
      contentDigest: promptDigest(content),
    },
    content,
    expanded,
  };
}

export function validateContent(content: unknown, fragments: FragmentSource, options: { promptKind?: PromptKind | null } = {}): ValidationReport {
  return validate(content, fragments, options.promptKind).report;
}

export function assertValidContent(report: ValidationReport, status = 0): void {
  const first = report.errors[0];
  if (!first) return;
  const details = itemDetails(first);
  details.errors = report.errors;
  if (report.findings.length > 0) {
    details.findings = report.findings;
    throw new PromptTemplateError("prompt_secret_detected", status, "the prompt content contains a secret", details);
  }
  if (CONTENT_TOO_LARGE_REASONS.has(first.code)) {
    throw new PromptTemplateError("prompt_content_too_large", status, `prompt content too large: ${first.code}`, details);
  }
  const code = NAMED_CONTENT_CODES.get(first.code) ?? "prompt_template_invalid";
  throw new PromptTemplateError(code, status, `prompt content invalid: ${first.code}`, details);
}

function valueMap(variables: VariableValues | null | undefined): Map<string, unknown> {
  if (variables === null || variables === undefined) return new Map();
  if (variables instanceof Map) return new Map(variables);
  const record = variables as Readonly<Record<string, unknown>>;
  return new Map(Object.keys(record).map((key) => [key, record[key]]));
}

function checkMessage(item: unknown, path: string, variable?: string): void {
  const fail = (valuePath: string): IssueFailure => new IssueFailure(clean({ code: "invalid_message_value", value_path: valuePath, variable }));
  if (item === null || typeof item !== "object" || Array.isArray(item)) throw fail(path);
  const message = item as Record<string, unknown>;
  if (!hasOwn(message, "role") || !hasOwn(message, "content")) throw fail(path);
  if (typeof message.role !== "string" || !MESSAGE_ROLES.has(message.role)) throw fail(`${path}/role`);
  const content = message.content;
  if (!(content === null || typeof content === "string" || Array.isArray(content))) throw fail(`${path}/content`);
}

function checkValue(type: VariableType, value: unknown, path: string, name: string): void {
  const fail = (code: string, valuePath = path): IssueFailure => new IssueFailure({ code, variable: name, value_path: valuePath });
  if (type === "string") {
    if (typeof value !== "string") throw fail("type_mismatch");
    const found = stringViolation(value, path);
    if (found) throw fail(found.code, found.value_path);
    return;
  }
  if (type === "integer") {
    if (typeof value !== "number") throw fail("type_mismatch");
    if (!Number.isFinite(value) || !Number.isInteger(value)) throw fail("float_not_allowed");
    if (Math.abs(value) > MAX_SAFE_JSON_INTEGER) throw fail("integer_out_of_range");
    return;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") throw fail("type_mismatch");
    return;
  }
  if (type === "json") {
    const found = ajsViolation(value, path);
    if (found) throw fail(found.code, found.value_path);
    return;
  }
  if (!Array.isArray(value)) throw fail("placeholder_not_list");
  value.forEach((item, index) => checkMessage(item, pointer(path, index), name));
}

function renderScalar(type: VariableType, value: unknown): string {
  if (type === "string") return value as string;
  if (type === "integer") return Object.is(value, -0) ? "0" : String(value);
  if (type === "boolean") return value ? "true" : "false";
  return normalizedJson(value);
}

function scanValues(declared: Content["variables"], values: Map<string, unknown>): void {
  for (const name of sortedKeys(declared)) {
    const scanAt = (text: string, path: string): void => {
      const found = scanSecrets(text);
      if (found.length > 0) {
        throw new IssueFailure({ code: "secret_in_variables", variable: name, value_path: path, pattern: found[0]!.pattern });
      }
    };
    const walk = (value: unknown, path: string): void => {
      if (typeof value === "string") scanAt(value, path);
      else if (Array.isArray(value)) value.forEach((item, index) => walk(item, pointer(path, index)));
      else if (isPlainRecord(value)) for (const key of sortedKeys(value)) walk(value[key], pointer(path, key));
    };
    const type = declared[name]!.type;
    if (type === "string") scanAt(values.get(name) as string, pointer("/variables", name));
    else if (type === "json") walk(values.get(name), pointer("/variables", name));
  }
}

function duplicateSystem(item: unknown, systemContents: Set<string>): boolean {
  if (item === null || typeof item !== "object") return false;
  const message = item as Record<string, unknown>;
  return message.role === "system" && typeof message.content === "string" && systemContents.has(message.content);
}

function renderValidated(state: Validated, variables: VariableValues | null | undefined, options: RenderOptions): RenderedPrompt {
  const { report, content, expanded } = state;
  const firstError = report.errors[0];
  if (firstError || !content || !expanded) throw new IssueFailure(firstError ?? { code: "invalid_field_type", path: "" });
  const kind = content.kind;
  if (options.expectKind !== undefined && kind !== options.expectKind) throw new IssueFailure({ code: "kind_mismatch" });
  const declared = content.variables;
  const partials = content.partials;
  const supplied = valueMap(variables);
  const warnings = [...report.warnings];
  const strict = options.strict ?? true;
  for (const name of [...supplied.keys()].sort()) {
    if (!hasOwn(declared, name)) {
      if (strict) throw new IssueFailure({ code: "unknown_variable", variable: name });
      warnings.push({ code: "strict_disabled", variable: name });
    }
  }
  const values = new Map<string, unknown>();
  for (const name of sortedKeys(declared)) {
    const declaration = declared[name]!;
    let value: unknown;
    if (supplied.has(name)) value = supplied.get(name);
    else if (hasOwn(partials, name)) value = partials[name];
    else if (declaration.type === "messages" && !declaration.required) value = [];
    else throw new IssueFailure({ code: "missing_variable", variable: name });
    checkValue(declaration.type, value, pointer("/variables", name), name);
    values.set(name, declaration.type === "messages" ? [...(value as unknown[])] : value);
  }
  if (options.secretPolicy === "error") scanValues(declared, values);
  const body = content.body;
  const hasPlaceholder = kind === "chat" && (body as Array<Record<string, unknown>>).some((entry) => hasOwn(entry, "placeholder"));
  const history = options.history;
  if (history !== undefined && history !== null) {
    if (kind === "text") throw new IssueFailure({ code: "history_not_supported" });
    if (hasPlaceholder) throw new IssueFailure({ code: "history_conflict" });
    if (!Array.isArray(history)) throw new IssueFailure({ code: "invalid_message_value", value_path: "/history" });
    history.forEach((item, index) => checkMessage(item, pointer("/history", index)));
  }
  const renderTokens = (items: readonly Token[]): string =>
    items.map((token) => (token.t === "literal" ? token.text : renderScalar(declared[token.name]!.type, values.get(token.name)))).join("");
  const historyItems = history ? [...history] : [];
  let text: string | null = null;
  let messages: unknown[] | null = null;
  let documentMessages: Array<Record<string, unknown>> | null = null;
  let expandedTemplate: string | Array<Record<string, unknown>>;
  let size = 0;
  if (kind === "text") {
    const items = expanded.get("/body") ?? [];
    text = renderTokens(items);
    expandedTemplate = templateSource(items);
    size = codePointLength(text);
  } else {
    const rendered: unknown[] = [];
    const documentEntries: Array<Record<string, unknown>> = [];
    const templateEntries: Array<Record<string, unknown>> = [];
    const systemContents = new Set<string>();
    const entries = body as Array<Record<string, unknown>>;
    entries.forEach((entry, index) => {
      if (hasOwn(entry, "role")) {
        const items = expanded.get(`/body/${index}/content`) ?? [];
        const role = entry.role as RenderedMessage["role"];
        const output = renderTokens(items);
        rendered.push({ role, content: output });
        documentEntries.push({ role, content: output });
        templateEntries.push({ role, content: templateSource(items) });
        if (role === "system") systemContents.add(output);
        size += codePointLength(output);
        return;
      }
      const name = entry.placeholder as string;
      const items = values.get(name) as unknown[];
      rendered.push(...items);
      documentEntries.push({ placeholder: name, count: items.length });
      templateEntries.push({ placeholder: name, optional: entry.optional });
    });
    rendered.push(...historyItems);
    if (!options.allowDuplicateSystem) {
      for (const entry of entries) {
        if (!hasOwn(entry, "placeholder")) continue;
        const name = entry.placeholder as string;
        (values.get(name) as unknown[]).forEach((item, index) => {
          if (duplicateSystem(item, systemContents)) {
            throw new IssueFailure({ code: "duplicate_system_message", value_path: pointer(pointer("/variables", name), index) });
          }
        });
      }
      historyItems.forEach((item, index) => {
        if (duplicateSystem(item, systemContents)) {
          throw new IssueFailure({ code: "duplicate_system_message", value_path: pointer("/history", index) });
        }
      });
    }
    messages = rendered;
    documentMessages = documentEntries;
    expandedTemplate = templateEntries;
  }
  if (size > MAX_RENDERED_CODE_POINTS) throw new IssueFailure({ code: "rendered_output_too_large" });
  const contentDigest = report.contentDigest ?? promptDigest(content);
  const renderedDocument: Record<string, unknown> = {
    schema: RENDERED_SCHEMA,
    content_digest: contentDigest,
    kind,
    text,
    messages: documentMessages,
    history_count: historyItems.length,
  };
  return {
    kind,
    text,
    messages,
    renderedHash: promptDigest(renderedDocument),
    contentDigest,
    warnings: warnings.map(clean),
    expandedTemplate,
    renderedDocument,
  };
}

function renderState(state: Validated, variables: VariableValues | null | undefined, options: RenderOptions): RenderedPrompt {
  try {
    return renderValidated(state, variables, options);
  } catch (failure) {
    if (failure instanceof IssueFailure) throw renderFailure(clean(failure.issue));
    throw failure;
  }
}

export function renderContent(
  content: unknown,
  variables: VariableValues | null | undefined,
  fragments: FragmentSource,
  options: RenderOptions = {},
): RenderedPrompt {
  return renderState(validate(content, fragments), variables, options);
}

const PREPARED = new WeakMap<ManagedPromptVersion, Validated>();

function versionKey(ref: PromptVersionRef): string {
  return `${ref.promptId}:${ref.version}`;
}

function closureSource(version: ManagedPromptVersion): FragmentSource {
  const closure = new Map<string, FragmentEntry>();
  const pending: ManagedPromptVersion[] = Object.values(version.fragments);
  while (pending.length > 0) {
    const fragment = pending.pop()!;
    const key = versionKey(fragment.ref);
    if (closure.has(key)) continue;
    closure.set(key, { promptKind: fragment.kind === "fragment" ? "fragment" : null, content: fragment.content });
    pending.push(...Object.values(fragment.fragments));
  }
  return (promptId, number) => closure.get(`${promptId}:${number}`);
}

function prepare(version: ManagedPromptVersion): Validated {
  const known = PREPARED.get(version);
  if (known) return known;
  const state = validate(version.content, closureSource(version), version.kind);
  const firstError = state.report.errors[0];
  if (firstError) throw renderFailure(firstError);
  if (state.report.contentDigest !== version.contentDigest) {
    throw integrityError("prompt_digest_mismatch", `content digest of ${versionKey(version.ref)} does not match`, {
      ref: versionKey(version.ref),
      expected: version.contentDigest,
      actual: state.report.contentDigest,
    });
  }
  return state;
}

export function renderText(
  version: ManagedPromptVersion,
  variables?: VariableValues | null,
  options: { strict?: boolean } = {},
): string {
  return renderState(prepare(version), variables, { strict: options.strict, expectKind: "text" }).text as string;
}

export function renderMessages(
  version: ManagedPromptVersion,
  variables?: VariableValues | null,
  options: { strict?: boolean; allowDuplicateSystem?: boolean; secretPolicy?: SecretPolicy } = {},
): Array<RenderedMessage | unknown> {
  return renderState(prepare(version), variables, { ...options, expectKind: "chat" }).messages ?? [];
}

export function compose(
  version: ManagedPromptVersion,
  variables: VariableValues | null | undefined,
  history: ReadonlyArray<unknown>,
  options: { strict?: boolean; allowDuplicateSystem?: boolean; secretPolicy?: SecretPolicy } = {},
): Array<RenderedMessage | unknown> {
  return renderState(prepare(version), variables, { ...options, history }).messages ?? [];
}

export function verifyRecord(record: PromptVersionRecord): void {
  const ref = `${record.prompt_id}:${record.version}`;
  const found = ajsViolation(record.content);
  if (found) {
    throw integrityError("prompt_digest_mismatch", `content of ${ref} is outside the JSON subset`, {
      ref,
      expected: record.content_digest,
      reason: found.code,
    });
  }
  const actual = promptDigest(record.content);
  if (actual !== record.content_digest) {
    throw integrityError("prompt_digest_mismatch", `content digest of ${ref} does not match`, {
      ref,
      expected: record.content_digest,
      actual,
    });
  }
}

export function buildPromptVersion(
  record: PromptVersionRecord,
  workspaceId: string,
  lookup: RecordLookup,
  memo: Map<string, ManagedPromptVersion> = new Map(),
): ManagedPromptVersion {
  const key = `${record.prompt_id}:${record.version}`;
  const built = memo.get(key);
  if (built) return built;
  verifyRecord(record);
  const content = deepFreeze(jsonCopy(record.content)) as unknown as PromptContent;
  const source: FragmentSource = (promptId, number) => {
    const found = lookup(promptId, number);
    return found ? { promptKind: found.prompt_kind ?? undefined, content: found.content } : undefined;
  };
  const state = validate(content, source, record.prompt_kind);
  assertValidContent(state.report);
  const fragments = Object.create(null) as Record<string, ManagedPromptVersion>;
  for (const name of Object.keys(content.fragments)) {
    const pin = content.fragments[name]!;
    const found = lookup(pin.prompt_id, pin.version);
    if (found) fragments[name] = buildPromptVersion(found, workspaceId, lookup, memo);
  }
  const version: ManagedPromptVersion = deepFreeze({
    ref: { form: "version", promptId: record.prompt_id, version: record.version },
    workspaceId,
    kind: record.prompt_kind ?? content.kind,
    contentDigest: record.content_digest,
    content,
    fragments,
  });
  PREPARED.set(version, state);
  memo.set(key, version);
  return version;
}

export function withResolvedFrom(version: ManagedPromptVersion, resolvedFrom: ResolvedFrom): ManagedPromptVersion {
  const copy: ManagedPromptVersion = Object.freeze({ ...version, resolvedFrom: Object.freeze({ ...resolvedFrom }) });
  const state = PREPARED.get(version);
  if (state) PREPARED.set(copy, state);
  return copy;
}
