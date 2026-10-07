import { describe, expect, it } from "vitest";
import {
  foldSubscriptions,
  subscriptionMembers,
  subscriptionRepresentative,
} from "./subscriptions.js";

type Record = Parameters<typeof foldSubscriptions>[0][number];

const PERSONAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function record(overrides: Partial<Record> & Pick<Record, "id">): Record {
  return {
    provider: "claude",
    email: "person@example.com",
    accountUuid: "11111111-1111-4111-8111-111111111111",
    organizationUuid: null,
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    signInExpired: false,
    enabled: true,
    status: "ready",
    active: false,
    lastUsedAt: null,
    ...overrides,
  };
}

function ids(accounts: Record[]): string[] {
  return foldSubscriptions(accounts).map(({ id }) => id);
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
    const other = record({
      id: "other",
      email: "other@example.com",
      accountUuid: "22222222-2222-4222-8222-222222222222",
    });
    expect(ids([expired, healthy, other])).toEqual(["healthy", "other"]);
    expect(
      subscriptionRepresentative([expired, healthy, other], "expired")?.id,
    ).toBe("healthy");
  });

  it("prefers the active record when both are equally healthy", () => {
    expect(
      ids([record({ id: "first" }), record({ id: "second", active: true })]),
    ).toEqual(["second"]);
    expect(ids([record({ id: "first" }), record({ id: "second" })])).toEqual([
      "first",
    ]);
  });

  it("keeps the most recently used record when every record of a login is off", () => {
    const off = { enabled: false, status: "disabled" } as const;
    const twin = record({ id: "twin", lastUsedAt: 100, ...off });
    const principal = record({ id: "principal", lastUsedAt: 200, ...off });
    const unused = record({ id: "unused", ...off });
    expect(ids([twin, principal, unused])).toEqual(["principal"]);
    expect(subscriptionRepresentative([twin, principal], "twin")?.id).toBe(
      "principal",
    );
    const alsoUnused = record({ id: "also-unused", ...off });
    expect(ids([unused, alsoUnused])).toEqual(["also-unused"]);
    expect(ids([alsoUnused, unused])).toEqual(["also-unused"]);
  });

  it("keeps one login folded after its plan changes or goes unreported on one record", () => {
    const stale = record({
      id: "stale",
      rateLimitTier: "default_claude_max_5x",
      signInExpired: true,
      enabled: false,
      status: "disabled",
    });
    const refreshed = record({ id: "refreshed", organizationUuid: PERSONAL });
    const unreported = record({
      id: "unreported",
      rateLimitTier: null,
      subscriptionType: null,
    });
    expect(ids([stale, refreshed, unreported])).toEqual(["refreshed"]);
  });

  it("separates two organizations on one email and folds plan changes inside one organization", () => {
    expect(
      ids([
        record({ id: "personal", organizationUuid: PERSONAL }),
        record({ id: "team", organizationUuid: TEAM }),
        record({
          id: "personal-upgraded",
          organizationUuid: PERSONAL,
          rateLimitTier: "default_claude_max_5x",
          status: "exhausted",
        }),
      ]),
    ).toEqual(["personal", "team"]);
  });

  it("files a record without an organization under the organization with its plan", () => {
    const personal = record({
      id: "personal",
      organizationUuid: PERSONAL,
      rateLimitTier: "default_claude_max_5x",
    });
    const team = record({ id: "team", organizationUuid: TEAM });
    const legacy = record({
      id: "legacy",
      rateLimitTier: "default_claude_max_5x",
      active: true,
    });
    expect(ids([personal, team, legacy])).toEqual(["team", "legacy"]);
    expect(
      subscriptionRepresentative([personal, team, legacy], "personal")?.id,
    ).toBe("legacy");
  });

  it("gives the same subscriptions and representatives in every input order", () => {
    const seats = [
      record({ id: "seat-a", organizationUuid: PERSONAL }),
      record({ id: "seat-a2", organizationUuid: PERSONAL }),
      record({
        id: "seat-b",
        organizationUuid: TEAM,
        rateLimitTier: "default_claude_team",
      }),
      record({
        id: "seat-c",
        rateLimitTier: "default_claude_max_5x",
        signInExpired: true,
      }),
    ];
    const orders = (items: Record[]): Record[][] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, index) =>
            orders(items.filter((_, other) => other !== index)).map((rest) => [
              item,
              ...rest,
            ]),
          );
    const shape = (accounts: Record[]) =>
      seats.map(({ id }) => ({
        id,
        members: subscriptionMembers(accounts, id)
          .map((member) => member.id)
          .sort(),
        representative: subscriptionRepresentative(accounts, id)?.id,
      }));
    const all = orders(seats);
    expect(all).toHaveLength(24);
    const expected = shape(seats);
    for (const order of all) expect(shape(order)).toEqual(expected);
    expect(new Set(all.map((order) => ids(order).sort().join(","))).size).toBe(
      1,
    );
  });

  it("folds by account UUID without an email and never folds records with neither", () => {
    expect(
      ids([
        record({ id: "uuid-one", email: null }),
        record({ id: "uuid-two", email: null }),
        record({ id: "key-one", email: null, accountUuid: null }),
        record({ id: "key-two", email: null, accountUuid: null }),
      ]),
    ).toEqual(["uuid-one", "key-one", "key-two"]);
  });

  it("folds a record without an email into the login that shares its account UUID", () => {
    const named = record({ id: "named" });
    const unnamed = record({ id: "unnamed", email: null, enabled: false });
    const other = record({
      id: "other",
      email: null,
      accountUuid: "22222222-2222-4222-8222-222222222222",
    });
    expect(ids([unnamed, named, other])).toEqual(["named", "other"]);
    expect(
      subscriptionMembers([unnamed, named, other], "named").map(({ id }) => id),
    ).toEqual(["unnamed", "named"]);
    expect(
      subscriptionMembers([unnamed, named, other], "other").map(({ id }) => id),
    ).toEqual(["other"]);
    expect(subscriptionMembers([named], "missing")).toEqual([]);
  });

  it("folds Codex records by email and ChatGPT workspace only", () => {
    expect(
      ids([
        record({ id: "team", provider: "codex", codexAccountId: "team" }),
        record({
          id: "team-again",
          provider: "codex",
          email: "PERSON@example.com",
          codexAccountId: "team",
        }),
        record({
          id: "personal",
          provider: "codex",
          codexAccountId: "personal",
        }),
        record({ id: "claude" }),
      ]),
    ).toEqual(["team", "personal", "claude"]);
  });
});
