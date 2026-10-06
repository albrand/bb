import { describe, expect, it } from "vitest";
import { foldSubscriptions, subscriptionKey } from "./subscriptions.js";

type Record = Parameters<typeof foldSubscriptions>[0][number];

function record(overrides: Partial<Record> & Pick<Record, "id">): Record {
  return {
    provider: "claude",
    email: "person@example.com",
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    signInExpired: false,
    enabled: true,
    status: "ready",
    active: false,
    ...overrides,
  };
}

describe("subscription folding", () => {
  it("keeps the healthy record of one login even when the expired one comes first", () => {
    const expired = record({
      id: "expired",
      email: "Person@Example.com ",
      signInExpired: true,
      enabled: false,
      status: "disabled",
    });
    const healthy = record({ id: "healthy", status: "exhausted" });
    const other = record({ id: "other", email: "other@example.com" });
    expect(
      foldSubscriptions([expired, healthy, other]).map(({ id }) => id),
    ).toEqual(["healthy", "other"]);
  });

  it("prefers the active record when both are equally healthy", () => {
    expect(
      foldSubscriptions([
        record({ id: "first" }),
        record({ id: "second", active: true }),
      ]).map(({ id }) => id),
    ).toEqual(["second"]);
    expect(
      foldSubscriptions([
        record({ id: "first" }),
        record({ id: "second" }),
      ]).map(({ id }) => id),
    ).toEqual(["first"]);
  });

  it("never folds records without an email, across providers, plans, or ChatGPT workspaces", () => {
    expect(
      foldSubscriptions([
        record({ id: "key-one", email: null }),
        record({ id: "key-two", email: null }),
        record({ id: "five-x", rateLimitTier: "default_claude_max_5x" }),
        record({ id: "codex", provider: "codex", codexAccountId: "team" }),
        record({
          id: "codex-personal",
          provider: "codex",
          codexAccountId: "personal",
        }),
        record({ id: "claude" }),
      ]).map(({ id }) => id),
    ).toEqual([
      "key-one",
      "key-two",
      "five-x",
      "codex",
      "codex-personal",
      "claude",
    ]);
    expect(
      subscriptionKey(
        record({ id: "codex", provider: "codex", codexAccountId: "team" }),
      ),
    ).toBe(
      subscriptionKey(
        record({
          id: "codex-again",
          provider: "codex",
          email: "PERSON@example.com",
          codexAccountId: "team",
        }),
      ),
    );
  });
});
