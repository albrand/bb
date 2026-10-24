import { describe, expect, it } from "vitest";
import { runTextAiTask } from "../../src/services/ai/ai-tasks.js";
import { registerFakeAiService } from "../helpers/ai-services.js";
import { withTestHarness } from "../helpers/test-app.js";

const PROMPT = "Write a title for: fix the flaky login test";

describe("existing AI task routing around a slow status check", () => {
  it.each(["thread-title", "commit-message"] as const)(
    "routes %s past a service whose status check outlasts 2 s, and keeps routing past it on a repeated call after the late Ready",
    async (task) => {
      await withTestHarness({}, async (harness) => {
        const cloud = registerFakeAiService(harness.deps.aiServices, {
          id: "bb",
          displayName: "Cloud",
          pluginId: "bb-ai",
          builtin: true,
          status: () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ ready: true }), 2_500),
            ),
          complete: async () => "Cloud title",
        });
        const codex = registerFakeAiService(harness.deps.aiServices, {
          id: "codex",
          displayName: "Codex",
          pluginId: "provider-codex",
          builtin: true,
          complete: async () => "Codex title",
        });

        const startedAt = Date.now();
        const first = await runTextAiTask(harness.deps, {
          task,
          label: "test",
          prompt: PROMPT,
        });
        const firstMs = Date.now() - startedAt;
        expect(first).toMatchObject({ ok: true, value: "Codex title" });
        expect(firstMs).toBeGreaterThanOrEqual(1_900);
        expect(firstMs).toBeLessThan(2_400);

        await new Promise((resolve) => setTimeout(resolve, 900));
        const againAt = Date.now();
        const again = await runTextAiTask(harness.deps, {
          task,
          label: "test",
          prompt: PROMPT,
        });
        const againMs = Date.now() - againAt;
        expect(again).toMatchObject({ ok: true, value: "Codex title" });
        expect(againMs).toBeLessThan(500);
        expect(cloud.completeCalls).toEqual([]);
        expect(codex.completeCalls).toHaveLength(2);
      });
    },
  );

  it.each(["thread-title", "commit-message"] as const)(
    "routes %s past a service whose status check, started by Settings, outlasted 2 s before the task arrived",
    async (task) => {
      await withTestHarness({}, async (harness) => {
        const cloud = registerFakeAiService(harness.deps.aiServices, {
          id: "bb",
          displayName: "Cloud",
          pluginId: "bb-ai",
          builtin: true,
          status: () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ ready: true }), 2_500),
            ),
          complete: async () => "Cloud title",
        });
        const codex = registerFakeAiService(harness.deps.aiServices, {
          id: "codex",
          displayName: "Codex",
          pluginId: "provider-codex",
          builtin: true,
          complete: async () => "Codex title",
        });

        const settings = harness.deps.aiServices.status({
          pluginId: "bb-ai",
          serviceId: "bb",
        });
        await new Promise((resolve) => setTimeout(resolve, 2_200));
        const taskAt = Date.now();
        const result = await runTextAiTask(harness.deps, {
          task,
          label: "test",
          prompt: PROMPT,
        });
        const taskMs = Date.now() - taskAt;
        expect(result).toMatchObject({ ok: true, value: "Codex title" });
        expect(taskMs).toBeLessThan(500);

        await settings;
        await new Promise((resolve) => setTimeout(resolve, 600));
        const afterLateReady = await runTextAiTask(harness.deps, {
          task,
          label: "test",
          prompt: PROMPT,
        });
        expect(afterLateReady).toMatchObject({
          ok: true,
          value: "Codex title",
        });
        expect(cloud.completeCalls).toEqual([]);
        expect(codex.completeCalls).toHaveLength(2);
      });
    },
  );

  it.each(["thread-title", "commit-message"] as const)(
    "routes %s past a service when it joins a status check that Settings started 1.5 s earlier, at that check's own 2 s",
    async (task) => {
      await withTestHarness({}, async (harness) => {
        const cloud = registerFakeAiService(harness.deps.aiServices, {
          id: "bb",
          displayName: "Cloud",
          pluginId: "bb-ai",
          builtin: true,
          status: () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ ready: true }), 2_500),
            ),
          complete: async () => "Cloud title",
        });
        const codex = registerFakeAiService(harness.deps.aiServices, {
          id: "codex",
          displayName: "Codex",
          pluginId: "provider-codex",
          builtin: true,
          complete: async () => "Codex title",
        });

        void harness.deps.aiServices.status({
          pluginId: "bb-ai",
          serviceId: "bb",
        });
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const taskAt = Date.now();
        const result = await runTextAiTask(harness.deps, {
          task,
          label: "test",
          prompt: PROMPT,
        });
        const taskMs = Date.now() - taskAt;
        expect(result).toMatchObject({ ok: true, value: "Codex title" });
        expect(taskMs).toBeGreaterThanOrEqual(300);
        expect(taskMs).toBeLessThan(900);
        expect(cloud.completeCalls).toEqual([]);
        expect(codex.completeCalls).toHaveLength(1);
      });
    },
  );
});
