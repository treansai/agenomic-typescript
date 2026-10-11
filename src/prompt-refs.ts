import { PromptRefError } from "./errors";

export interface PromptVersionRef {
  readonly form: "version";
  readonly promptId: string;
  readonly version: number;
}

export interface PromptAliasRef {
  readonly form: "alias";
  readonly promptId: string;
  readonly alias: string;
}

export interface PromptUri {
  readonly form: "uri";
  readonly workspaceId: string;
  readonly promptId: string;
  readonly version: number;
}

export type PromptReference = PromptVersionRef | PromptAliasRef | PromptUri;

export interface ParsePromptRefOptions {
  workspaceId?: string | null;
  allowBareId?: boolean;
}

const MAX_VERSION = 2147483647;
const PROMPT_ID = /^prm_[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
const ALIAS = /^[a-z][a-z0-9_-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^[1-9][0-9]{0,9}$/;

function isPromptId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && PROMPT_ID.test(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function versionNumber(value: string): number | undefined {
  if (!VERSION.test(value)) return undefined;
  const number = Number(value);
  return number <= MAX_VERSION ? number : undefined;
}

function invalid(reason: string): PromptRefError {
  return new PromptRefError("prompt_ref_invalid", 0, `invalid prompt reference: ${reason}`, { reason });
}

function crossWorkspace(): PromptRefError {
  return new PromptRefError("prompt_ref_cross_workspace", 0, "the prompt reference names another workspace");
}

function parseUri(text: string): PromptUri {
  const split = text.indexOf("://");
  const scheme = text.slice(0, split);
  const rest = text.slice(split + 3);
  if (scheme !== "agenomic") throw invalid("unsupported_scheme");
  if (rest.includes("?") || rest.includes("#")) throw invalid("query_or_fragment");
  if (rest === "") throw invalid("empty_segment");
  if (rest.endsWith("/")) throw invalid("trailing_slash");
  const segments = rest.split("/");
  if (segments.includes("")) throw invalid("empty_segment");
  const [workspaceId, prompts, promptId, versions, rawVersion] = segments;
  if (segments.length !== 5 || prompts !== "prompts" || versions !== "versions") throw invalid("invalid_uri_path");
  if (!isUuid(workspaceId)) throw invalid("invalid_workspace");
  if (!isPromptId(promptId)) throw invalid("invalid_prompt_id");
  const version = versionNumber(rawVersion ?? "");
  if (version === undefined) throw invalid("invalid_version");
  return { form: "uri", workspaceId, promptId, version };
}

function parse(text: string): PromptReference | string {
  if (typeof text !== "string") throw new TypeError("a prompt reference is a string");
  if (text === "") throw invalid("empty_segment");
  let length = 0;
  for (const char of text) {
    length += 1;
    if (length > 256) throw invalid("too_long");
  }
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x21 || code > 0x7e) {
      if ((code >= 0x09 && code <= 0x0d) || code === 0x20) throw invalid("whitespace");
      throw invalid("invalid_character");
    }
  }
  if (/[A-Z]/.test(text)) throw invalid("uppercase");
  if (text.includes("%")) throw invalid("percent_encoded_separator");
  if (text.includes("://")) return parseUri(text);
  if (text.includes(":") && text.includes("@")) throw invalid("mixed_form");
  if (text.includes(":")) {
    const split = text.indexOf(":");
    const promptId = text.slice(0, split);
    const rawVersion = text.slice(split + 1);
    if (promptId === "" || rawVersion === "") throw invalid("empty_segment");
    if (!isPromptId(promptId)) throw invalid("invalid_prompt_id");
    const version = versionNumber(rawVersion);
    if (version === undefined) throw invalid("invalid_version");
    return { form: "version", promptId, version };
  }
  if (text.includes("@")) {
    const split = text.indexOf("@");
    const promptId = text.slice(0, split);
    const alias = text.slice(split + 1);
    if (promptId === "" || alias === "") throw invalid("empty_segment");
    if (!isPromptId(promptId)) throw invalid("invalid_prompt_id");
    if (!ALIAS.test(alias)) throw invalid("invalid_alias");
    return { form: "alias", promptId, alias };
  }
  if (!isPromptId(text)) throw invalid("invalid_prompt_id");
  return text;
}

export function parsePromptRef(text: string, options: ParsePromptRefOptions = {}): PromptReference | string {
  const ref = parse(text);
  const workspaceId = options.workspaceId ?? null;
  if (typeof ref !== "string" && ref.form === "uri" && workspaceId !== null && ref.workspaceId !== workspaceId) {
    throw crossWorkspace();
  }
  if (typeof ref === "string" && !options.allowBareId) {
    throw new PromptRefError("prompt_ref_unversioned", 0, "a version or an alias is required; there is no implicit latest");
  }
  return ref;
}

export function parseExecutionRef(text: string, options: { workspaceId?: string | null } = {}): PromptReference {
  return parsePromptRef(text, { workspaceId: options.workspaceId ?? null }) as PromptReference;
}

export function formatPromptRef(ref: PromptReference | string): string {
  if (typeof ref === "string") return ref;
  if (ref.form === "version") return `${ref.promptId}:${ref.version}`;
  if (ref.form === "alias") return `${ref.promptId}@${ref.alias}`;
  return `agenomic://${ref.workspaceId}/prompts/${ref.promptId}/versions/${ref.version}`;
}

export function versionRefOf(uri: PromptUri, workspaceId: string): PromptVersionRef {
  if (uri.workspaceId !== workspaceId) throw crossWorkspace();
  return { form: "version", promptId: uri.promptId, version: uri.version };
}
