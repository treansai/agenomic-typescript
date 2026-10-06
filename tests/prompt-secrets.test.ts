import { describe, expect, it } from "vitest";
import { scanSecrets, scrubSecrets } from "../src/prompt-secrets";

const AWS = "AKIA" + "ABCDEFGHIJKLMNOP";

describe("secret scan", () => {
  it("reports code point offsets after astral characters", () => {
    const text = `\u{1F600}\u{1F600} key ${AWS} and ${AWS}`;
    const findings = scanSecrets(text);
    expect(findings).toEqual([
      { pattern: "aws_access_key", offset: 7, length: 20 },
      { pattern: "aws_access_key", offset: 32, length: 20 },
    ]);
    expect(scrubSecrets(text)).toBe(
      "\u{1F600}\u{1F600} key [REDACTED:aws_access_key] and [REDACTED:aws_access_key]",
    );
  });

  it("scans many findings in linear time", () => {
    const count = 13000;
    const text = Array.from({ length: count }, () => `\u{1F600}${AWS}`).join(" ");
    const started = performance.now();
    const findings = scanSecrets(text);
    const elapsed = performance.now() - started;
    expect(findings).toHaveLength(count);
    expect(findings[count - 1]).toEqual({ pattern: "aws_access_key", offset: (count - 1) * 22 + 1, length: 20 });
    expect(elapsed).toBeLessThan(2000);
  });
});
