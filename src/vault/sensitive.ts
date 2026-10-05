import { Buffer } from "node:buffer";
import { inspect } from "node:util";

import { VaultValidationError } from "./errors";

export const SENSITIVE_MASK = "[REDACTED]";

const held = new WeakMap<object, Uint8Array>();
const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Shared masking behaviour. Every textual, JSON, inspection and structured
 * clone view is the same constant, whatever the length of the held value. The
 * own enumerable `redacted` field is what `structuredClone` copies.
 */
abstract class Masked {
  readonly redacted = SENSITIVE_MASK;

  toString(): string {
    return SENSITIVE_MASK;
  }

  toJSON(): string {
    return SENSITIVE_MASK;
  }

  [Symbol.toPrimitive](): string {
    return SENSITIVE_MASK;
  }

  [inspect.custom](): string {
    return SENSITIVE_MASK;
  }
}

function toBytes(value: unknown): Uint8Array {
  if (typeof value === "string" && value.length > 0) return encoder.encode(value);
  if (value instanceof Uint8Array && value.length > 0) return Uint8Array.from(value);
  throw new VaultValidationError("a Sensitive value must be a non-empty string or Uint8Array", {
    code: "sensitive_invalid",
    status: 0,
  });
}

/**
 * Write-only carrier for a secret value on its way into the vault. It is the
 * only type accepted by `vault.secrets.create` and `vault.secrets.rotate`.
 * There is no way to read the value back: every string, JSON, inspection and
 * structured clone view is the constant mask. `dispose` zeroes the held bytes
 * (best effort: the string the caller built it from stays in their heap).
 */
export class Sensitive extends Masked {
  constructor(value: string | Uint8Array) {
    super();
    held.set(this, toBytes(value));
    Object.freeze(this);
  }

  dispose(): void {
    held.get(this)?.fill(0);
    held.delete(this);
  }
}

/**
 * A runtime-identity token, returned once when an identity is issued. It is
 * masked like a secret so logging the issue response cannot leak it. `takeOnce`
 * hands it to the code that must configure the agent runtime and then forgets
 * it. This is an enrollment credential, not a vault secret value.
 */
export class RuntimeToken extends Masked {
  constructor(token: string) {
    super();
    held.set(this, toBytes(token));
    Object.freeze(this);
  }

  takeOnce(): string {
    const text = decodeHeld(this, "runtime_token_taken", "the runtime token was already taken");
    held.get(this)?.fill(0);
    held.delete(this);
    return text;
  }
}

export function isMasked(value: unknown): value is Masked {
  return value instanceof Masked;
}

function decodeHeld(value: object, code: string, message: string): string {
  const bytes = held.get(value);
  if (!bytes) throw new VaultValidationError(message, { code, status: 0 });
  try {
    return strictDecoder.decode(bytes);
  } catch {
    throw new VaultValidationError("a Sensitive value must be valid UTF-8 text (use PEM for keys and certificates)", {
      code: "sensitive_invalid",
      status: 0,
    });
  }
}

/** Internal: refuses anything that is not a live `Sensitive`, with a constant message that never echoes the value. */
export function assertSensitive(value: unknown): asserts value is Sensitive {
  if (value instanceof Sensitive && held.has(value)) return;
  throw new VaultValidationError("the secret value must be wrapped in Sensitive; plain values are refused", {
    code: "sensitive_required",
    status: 0,
  });
}

/** Internal: the raw text of a `Sensitive`, for the request serializer only. Not exported from the package. */
export function serializeSensitive(value: unknown): string {
  if (!(value instanceof Sensitive)) {
    throw new VaultValidationError("the secret value must be wrapped in Sensitive; plain values are refused", {
      code: "sensitive_required",
      status: 0,
    });
  }
  return decodeHeld(value, "sensitive_disposed", "the Sensitive value was disposed");
}

/** Internal: the runtime token text, without consuming the wrapper. Not exported from the package. */
export function serializeRuntimeToken(value: string | RuntimeToken): string {
  if (typeof value === "string") return value;
  return decodeHeld(value, "runtime_token_taken", "the runtime token was already taken");
}

function variants(raw: string): string[] {
  const bytes = Buffer.from(raw, "utf8");
  return [
    raw,
    JSON.stringify(raw).slice(1, -1),
    encodeURIComponent(raw),
    bytes.toString("base64"),
    bytes.toString("base64url"),
    bytes.toString("hex"),
  ];
}

const MIN_NEEDLE = 4;

/** Defence in depth: removes known secret texts, in the encodings an echo would use, from text that may reach an error. */
export function scrubText(text: string, secrets: readonly string[]): string {
  const needles = secrets.filter((secret) => secret.length >= MIN_NEEDLE).flatMap(variants);
  return needles.reduce((out, needle) => (needle ? out.split(needle).join(SENSITIVE_MASK) : out), text);
}

/** Defence in depth: scrubs every string (and key) of a parsed response against the secrets this request carried. */
export function scrubDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return scrubText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, secrets));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrubText(key, secrets), scrubDeep(item, secrets)]));
}
