import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Fork (albrand/bb). A rebuilt app has a new signature, and macOS holds the
// first keychain read (`safeStorage`) on an "allow access" prompt. If that read
// comes before the local server starts, nothing runs until someone clicks, and
// an unattended install leaves every agent down. main.ts is not unit-testable
// as a whole, so this pins the order in its source.
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
