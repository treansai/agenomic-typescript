import { format, inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { RuntimeToken, SENSITIVE_MASK, Sensitive } from "../src";
import { scrubText } from "../src/vault/sensitive";
import { CANARY } from "./vault-helpers";

function everyView(value: unknown): string[] {
  return [
    String(value),
    `${String(value)}`,
    `${value as string}`,
    `x${value as string}y`,
    JSON.stringify(value),
    JSON.stringify({ nested: { deep: [value] } }),
    inspect(value),
    inspect(value, { depth: 10, showHidden: true, colors: true }),
    inspect({ nested: { deep: [value] } }, { depth: 10 }),
    format("%s|%o|%O|%j|%d", value, value, value, value, value),
    JSON.stringify(structuredClone(value)),
    inspect(structuredClone(value)),
    JSON.stringify(Object.entries(value as object)),
    Object.getOwnPropertyNames(value).join(","),
  ];
}

const HOOKS: Array<[string, (value: Sensitive | RuntimeToken) => unknown]> = [
  ["toString()", (value) => value.toString()],
  ["toJSON()", (value) => value.toJSON()],
  ["Symbol.toPrimitive (string)", (value) => (value as unknown as Record<symbol, (hint: string) => unknown>)[Symbol.toPrimitive]!("string")],
  ["Symbol.toPrimitive (number)", (value) => (value as unknown as Record<symbol, (hint: string) => unknown>)[Symbol.toPrimitive]!("number")],
  ["Symbol.toPrimitive (default)", (value) => (value as unknown as Record<symbol, (hint: string) => unknown>)[Symbol.toPrimitive]!("default")],
  ["inspect.custom", (value) => (value as unknown as Record<symbol, () => unknown>)[inspect.custom]!()],
  ["Object.prototype.toString", (value) => Object.prototype.toString.call(value)],
  ["valueOf()", (value) => String(value.valueOf())],
  ["unary plus", (value) => String(+(value as unknown as number))],
];

describe("every masking hook on its own", () => {
  for (const [name, hook] of HOOKS) {
    it(`${name} never yields the value, for a Sensitive and a RuntimeToken`, () => {
      for (const wrapper of [new Sensitive(CANARY), new RuntimeToken(CANARY)]) {
        expect(String(hook(wrapper))).not.toContain(CANARY);
      }
    });
  }

  it("the explicit string hooks return exactly the constant mask", () => {
    for (const wrapper of [new Sensitive(CANARY), new RuntimeToken(CANARY)]) {
      expect(wrapper.toString()).toBe(SENSITIVE_MASK);
      expect(wrapper.toJSON()).toBe(SENSITIVE_MASK);
      expect((wrapper as unknown as Record<symbol, () => string>)[inspect.custom]!()).toBe(SENSITIVE_MASK);
    }
  });
});

describe("Sensitive", () => {
  it("shows one constant mask in every string, JSON, inspection and clone view", () => {
    const views = everyView(new Sensitive(CANARY));
    for (const view of views) expect(view).not.toContain(CANARY);
    expect(String(new Sensitive(CANARY))).toBe(SENSITIVE_MASK);
    expect(JSON.stringify(new Sensitive(CANARY))).toBe(`"${SENSITIVE_MASK}"`);
    expect(inspect(new Sensitive(CANARY))).toBe(SENSITIVE_MASK);
    expect(structuredClone(new Sensitive(CANARY))).toEqual({ redacted: SENSITIVE_MASK });
  });

  it("is identical whatever the length of the value", () => {
    const short = everyView(new Sensitive("a"));
    const long = everyView(new Sensitive("z".repeat(100_000)));
    const bytes = everyView(new Sensitive(new Uint8Array(4096).fill(65)));
    expect(long).toEqual(short);
    expect(bytes).toEqual(short);
  });

  it("never reaches console output", () => {
    const sinks = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info"), vi.spyOn(console, "debug")];
    for (const sink of sinks) sink.mockImplementation(() => undefined);
    const secret = new Sensitive(CANARY);
    console.log(secret, { secret });
    console.error(secret);
    console.warn("%s", secret);
    console.info({ list: [secret] });
    console.debug(`${String(secret)}`);
    const written = sinks.map((sink) => format(...(sink.mock.calls.flat() as [unknown]))).join("\n");
    vi.restoreAllMocks();
    expect(written).not.toContain(CANARY);
    expect(written).toContain(SENSITIVE_MASK);
  });

  it("exposes no own property but the mask and cannot be modified", () => {
    const secret = new Sensitive(CANARY);
    expect(Object.getOwnPropertyNames(secret)).toEqual(["redacted"]);
    expect(Object.isFrozen(secret)).toBe(true);
    expect(() => {
      (secret as unknown as Record<string, unknown>).value = "x";
    }).toThrow();
  });

  it("refuses empty and non text input without echoing it", () => {
    for (const bad of ["", new Uint8Array(0), 42, null, { value: CANARY }] as unknown[]) {
      let message = "";
      try {
        new Sensitive(bad as string);
      } catch (error) {
        message = String((error as Error).message);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(CANARY);
    }
  });

  it("dispose makes the value unusable", () => {
    const secret = new Sensitive(CANARY);
    secret.dispose();
    expect(String(secret)).toBe(SENSITIVE_MASK);
  });
});

describe("RuntimeToken", () => {
  it("is masked everywhere and hands the token out once", () => {
    const token = new RuntimeToken("vrt_secret_enrollment_token");
    for (const view of everyView(token)) expect(view).not.toContain("vrt_secret");
    expect(token.takeOnce()).toBe("vrt_secret_enrollment_token");
    expect(() => token.takeOnce()).toThrowError(/already taken/);
    expect(String(token)).toBe(SENSITIVE_MASK);
  });
});

describe("scrubText", () => {
  it("removes a secret in the encodings an echo would use", () => {
    const secret = 'sk_live/abc+def="quoted"';
    const bytes = Buffer.from(secret, "utf8");
    const echoes = [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      bytes.toString("base64"),
      bytes.toString("base64url"),
      bytes.toString("hex"),
    ];
    const text = `provider said: ${echoes.join(" | ")}`;
    const scrubbed = scrubText(text, [secret]);
    for (const echo of echoes) expect(scrubbed).not.toContain(echo);
    expect(scrubbed).toContain(SENSITIVE_MASK);
  });

  it("leaves text without the secret untouched", () => {
    expect(scrubText("nothing to see", [CANARY])).toBe("nothing to see");
  });
});
