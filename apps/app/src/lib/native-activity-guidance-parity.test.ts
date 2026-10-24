import { nativeActivityRecoveryText } from "@bb/client-core";
import { describe, expect, it } from "vitest";

interface PluginGuidanceModule {
  nativeActivityGuidanceText(thread: {
    experimental_nativeActivity: {
      confirmation: "unconfirmed";
      evidenceKind: "unknown";
      freshForMs: number;
      lastEvidenceAt: null;
    };
    host: { id: string; name: string } | null;
    id: string;
  }): string | null;
}

const plugin: PluginGuidanceModule = await import(
  new URL(
    "../../../../plugins/thread-list/app/model/thread-activity.ts",
    import.meta.url,
  ).href
);

const unconfirmed = {
  confirmation: "unconfirmed" as const,
  evidenceKind: "unknown" as const,
  freshForMs: 90_000,
  lastEvidenceAt: null,
};

describe("recovery guidance text", () => {
  it.each([
    ["a named host", { id: "host_1", name: "Build box" }],
    ["an unknown host", null],
  ])(
    "is identical in the header text and the sidebar row for %s",
    (_name, host) => {
      expect(
        plugin.nativeActivityGuidanceText({
          experimental_nativeActivity: unconfirmed,
          host,
          id: "thr_parity",
        }),
      ).toBe(
        nativeActivityRecoveryText({
          hostName: host?.name ?? null,
          threadId: "thr_parity",
        }),
      );
    },
  );
});
