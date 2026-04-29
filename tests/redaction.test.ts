import { describe, expect, it } from "vitest";

import { applyRedaction } from "../src/redaction";

describe("applyRedaction", () => {
  it("supports mask, remove, and hash modes", () => {
    const output = applyRedaction(
      {
        customer: {
          email: "user@example.com",
          token: "secret",
          ssn: "123-45-6789",
        },
      },
      [
        "customer.email",
        { path: "customer.token", mode: "remove" },
        { path: "customer.ssn", mode: "hash" },
      ],
    );

    expect(output.customer.email).toBe("[REDACTED]");
    expect("token" in output.customer).toBe(false);
    expect(output.customer.ssn).not.toBe("123-45-6789");
    expect(output.customer.ssn).toHaveLength(64);
  });

  it("supports wildcard traversal", () => {
    const output = applyRedaction(
      {
        messages: [
          { content: "first" },
          { content: "second" },
        ],
      },
      ["messages.*.content"],
    );

    expect(output.messages[0]?.content).toBe("[REDACTED]");
    expect(output.messages[1]?.content).toBe("[REDACTED]");
  });
});
