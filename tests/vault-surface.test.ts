import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import * as sdk from "../src";
import { AgenomicClient, RuntimeToken, Sensitive } from "../src";
import { API_KEY, BASE, CANARY, RUNTIME_TOKEN } from "./vault-helpers";

const FORBIDDEN = /readValue|getValue|reveal|exportSecret|decrypt/i;

function namesOf(target: object): string[] {
  const names = new Set<string>();
  for (let node: object | null = target; node && node !== Object.prototype && node !== Function.prototype; node = Object.getPrototypeOf(node) as object | null) {
    for (const name of Object.getOwnPropertyNames(node)) names.add(name);
    for (const symbol of Object.getOwnPropertySymbols(node)) names.add(symbol.description ?? String(symbol));
  }
  return [...names];
}

function graphNames(root: object, limit = 6): string[] {
  const seen = new Set<object>();
  const names = new Set<string>();
  const visit = (node: unknown, depth: number): void => {
    if (typeof node !== "object" && typeof node !== "function") return;
    if (node === null || seen.has(node as object) || depth > limit) return;
    seen.add(node as object);
    for (const name of namesOf(node as object)) {
      names.add(name);
      const descriptor = Object.getOwnPropertyDescriptor(node, name);
      if (descriptor && "value" in descriptor) visit(descriptor.value, depth + 1);
    }
  };
  visit(root, 0);
  return [...names];
}

describe("no export can read a secret value back", () => {
  it("has no exported name that looks like reading, revealing, exporting or decrypting a value", () => {
    const names = Object.keys(sdk);
    expect(names.length).toBeGreaterThan(50);
    expect(names.filter((name) => FORBIDDEN.test(name))).toEqual([]);
  });

  it("has no such member on any exported class, its prototype or its statics", () => {
    const offenders: string[] = [];
    for (const [exportName, exported] of Object.entries(sdk)) {
      if (typeof exported !== "function") continue;
      for (const member of [...namesOf(exported), ...namesOf((exported as { prototype?: object }).prototype ?? {})]) {
        if (FORBIDDEN.test(member)) offenders.push(`${exportName}.${member}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has no such member anywhere on a live client's vault and tools graph", () => {
    const client = new AgenomicClient({ apiKey: API_KEY, baseUrl: BASE, vault: { runtimeToken: RUNTIME_TOKEN } });
    for (const root of [client.vault, client.tools]) {
      const names = graphNames(root);
      expect(names.length).toBeGreaterThan(40);
      expect(names.filter((name) => FORBIDDEN.test(name))).toEqual([]);
    }
  });

  it("has no such member on the wrappers", () => {
    for (const wrapper of [new Sensitive(CANARY), new RuntimeToken("vrt_issued_token_0001")]) {
      expect(graphNames(wrapper).filter((name) => FORBIDDEN.test(name))).toEqual([]);
    }
  });

  it("has no such name in the vault sources, including comments and docs", () => {
    const dir = join(__dirname, "..", "src", "vault");
    for (const file of readdirSync(dir)) {
      expect(FORBIDDEN.test(readFileSync(join(dir, file), "utf8")), file).toBe(false);
    }
    expect(FORBIDDEN.test(readFileSync(join(__dirname, "..", "docs", "vault.md"), "utf8"))).toBe(false);
  });

  it("exposes the Sensitive wrapper only with a mask and a dispose", () => {
    expect(namesOf(Sensitive.prototype).sort()).toEqual(["constructor", "dispose", "toJSON", "Symbol.toPrimitive", "toString", "nodejs.util.inspect.custom"].sort());
    expect(namesOf(RuntimeToken.prototype)).toContain("takeOnce");
  });

  it("exports the SDK entry points of the vault surface", () => {
    for (const name of ["Sensitive", "RuntimeToken", "VaultResource", "VaultError", "VaultNotEntitledError", "VaultApprovalRequiredError", "VaultPolicyDeniedError", "VaultGrantUnusableError", "VaultRevokedError", "VaultOutcomeUnknownError", "VaultRateLimitedError", "VaultValidationError", "isVaultLocked", "parseVaultReplayFixtures"]) {
      expect(sdk, name).toHaveProperty(name);
    }
  });
});
