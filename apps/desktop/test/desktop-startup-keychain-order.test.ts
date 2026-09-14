import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(join(process.cwd(), "src/main.ts"), "utf8");

describe("desktop startup order", () => {
  it("starts the builtin runtime before reading the keychain credential", () => {
    const builtinBranch = mainSource.slice(
      mainSource.indexOf('if (serverTargetStore.getTarget().kind === "builtin") {'),
    );
    const runtimeAt = builtinBranch.indexOf("await initializeRuntime(");
    const credentialAt = builtinBranch.indexOf("await loadCachedConnectCredential()");

    expect(runtimeAt).toBeGreaterThan(-1);
    expect(credentialAt).toBeGreaterThan(runtimeAt);
  });

  it("reads the credential nowhere else before the runtime starts", () => {
    expect(mainSource).not.toMatch(
      /cachedConnectCredential = await connectCredentialCache\.read\(\)/u,
    );
  });
});
