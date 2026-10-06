import { afterEach, describe, expect, it } from "vitest";
import {
  getCurrentEventLoopWorkLabel,
  resetEventLoopWorkForTests,
  runEventLoopWork,
  runEventLoopWorkSync,
} from "../../src/services/system/event-loop-work.js";

describe("getCurrentEventLoopWorkLabel", () => {
  afterEach(() => {
    resetEventLoopWorkForTests();
  });

  it("names the nested work running at the call site across awaits", async () => {
    expect(getCurrentEventLoopWorkLabel()).toBeNull();

    const labels = await runEventLoopWork(
      "GET /api/v1/threads/:id/spend-summary",
      async () => {
        await Promise.resolve();
        const outer = getCurrentEventLoopWorkLabel();
        const inner = runEventLoopWorkSync("timeline-build thr_a", () =>
          getCurrentEventLoopWorkLabel(),
        );
        return { afterInner: getCurrentEventLoopWorkLabel(), inner, outer };
      },
    );

    expect(labels).toEqual({
      afterInner: "GET /api/v1/threads/:id/spend-summary",
      inner: "GET /api/v1/threads/:id/spend-summary > timeline-build thr_a",
      outer: "GET /api/v1/threads/:id/spend-summary",
    });
    expect(getCurrentEventLoopWorkLabel()).toBeNull();
  });

  it("keeps the labels of interleaved requests apart", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstWaits = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runEventLoopWork("GET /first", async () => {
      await firstWaits;
      return getCurrentEventLoopWorkLabel();
    });
    const second = runEventLoopWork("GET /second", async () => {
      await Promise.resolve();
      const label = getCurrentEventLoopWorkLabel();
      releaseFirst();
      return label;
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      "GET /first",
      "GET /second",
    ]);
  });
});
