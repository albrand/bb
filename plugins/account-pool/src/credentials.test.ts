import { describe, expect, it } from "vitest";
import {
  parseClaudeAccountIdentity,
  parseCodexCredentials,
} from "./credentials.js";

function token(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("Codex credential import", () => {
  it("reads account identity, email, token material, and access expiry", () => {
    const expiresAtSeconds = 2_000_000_000;
    expect(
      parseCodexCredentials(
        JSON.stringify({
          tokens: {
            access_token: token({ exp: expiresAtSeconds }),
            refresh_token: "refresh-token",
            account_id: "account-123",
            id_token: token({
              "https://api.openai.com/profile": { email: "codex@example.com" },
            }),
          },
          last_refresh: "2026-09-04T00:00:00Z",
        }),
      ),
    ).toEqual({
      accessToken: token({ exp: expiresAtSeconds }),
      refreshToken: "refresh-token",
      idToken: token({
        "https://api.openai.com/profile": { email: "codex@example.com" },
      }),
      accountId: "account-123",
      email: "codex@example.com",
      expiresAt: expiresAtSeconds * 1_000,
    });
  });

  it("rejects credentials that cannot identify the ChatGPT account", () => {
    expect(() =>
      parseCodexCredentials(
        JSON.stringify({
          tokens: {
            access_token: token({ exp: 2_000_000_000 }),
            refresh_token: "refresh-token",
          },
        }),
      ),
    ).toThrow("ChatGPT account id");
  });
});

describe("Claude account identity", () => {
  const login = {
    emailAddress: "person@example.com",
    accountUuid: "11111111-1111-4111-8111-111111111111",
  };

  it("reads the organization of the signed-in Claude login", () => {
    expect(
      parseClaudeAccountIdentity({
        oauthAccount: {
          ...login,
          organizationUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          organizationName: "Personal",
        },
      }),
    ).toEqual({
      email: "person@example.com",
      accountUuid: "11111111-1111-4111-8111-111111111111",
      organizationUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
  });

  it("keeps the login when the organization is missing or malformed", () => {
    for (const organizationUuid of [undefined, null, "not-a-uuid", 7]) {
      expect(
        parseClaudeAccountIdentity({
          oauthAccount: { ...login, organizationUuid },
        }),
      ).toEqual({
        email: "person@example.com",
        accountUuid: "11111111-1111-4111-8111-111111111111",
        organizationUuid: null,
      });
    }
    expect(parseClaudeAccountIdentity({})).toEqual({
      email: null,
      accountUuid: null,
      organizationUuid: null,
    });
  });
});
