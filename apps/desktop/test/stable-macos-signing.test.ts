import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(__filename);
const stableMacosSigning = require("../scripts/stable-macos-signing.cjs") as {
  stableDesignatedRequirement: (appId?: string) => string;
  isAdhocSignature: (output: string) => boolean;
};

describe("stable macOS signing", () => {
  it("uses the bundle identifier as the designated requirement", () => {
    expect(
      stableMacosSigning.stableDesignatedRequirement("dev.bb.desktop"),
    ).toBe('designated => identifier "dev.bb.desktop"');
  });

  it("only rewrites ad-hoc signatures", () => {
    expect(stableMacosSigning.isAdhocSignature("Signature=adhoc")).toBe(true);
    expect(
      stableMacosSigning.isAdhocSignature("code object is not signed at all"),
    ).toBe(true);
    expect(
      stableMacosSigning.isAdhocSignature("Authority=Developer ID Application"),
    ).toBe(false);
  });
});
