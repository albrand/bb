import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildClaudeCodeModels } from "../../model-list.js";
import {
  type SharedClaudeCodeModelCatalog,
  type SharedClaudeCodeModelCatalogEntry,
  UNSHARED_CLAUDE_CODE_MODEL_CATALOG,
  createClaudeCodeBridgeModelListMemo,
  createSharedClaudeCodeModelCatalogFile,
} from "../model-list.js";

function discovered(resolvedModel: string): ModelInfo[] {
  return [
    {
      value: "default",
      resolvedModel,
      displayName: "Default",
      description: resolvedModel,
    },
  ];
}

function memoryCatalog(): SharedClaudeCodeModelCatalog & {
  entry: SharedClaudeCodeModelCatalogEntry | null;
} {
  const catalog = {
    entry: null as SharedClaudeCodeModelCatalogEntry | null,
    read: () => Promise.resolve(catalog.entry),
    write: (entry: SharedClaudeCodeModelCatalogEntry) => {
      catalog.entry = entry;
      return Promise.resolve();
    },
  };
  return catalog;
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("createClaudeCodeBridgeModelListMemo", () => {
  it("shares one probe between concurrent asks and reuses it until the window ends", async () => {
    let currentTime = 0;
    let resolveProbe: (value: ModelInfo[]) => void = () => {};
    const probe = vi.fn(
      () =>
        new Promise<ModelInfo[]>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const listModels = createClaudeCodeBridgeModelListMemo({
      probe,
      now: () => currentTime,
      ttlMs: 1_000,
      shared: () => UNSHARED_CLAUDE_CODE_MODEL_CATALOG,
      renewalDue: () => Promise.resolve(false),
    });

    const first = listModels();
    const second = listModels();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    resolveProbe(discovered("claude-opus-5[1m]"));
    await expect(first).resolves.toEqual(
      buildClaudeCodeModels(discovered("claude-opus-5[1m]")),
    );
    await expect(second).resolves.toEqual(
      buildClaudeCodeModels(discovered("claude-opus-5[1m]")),
    );

    currentTime = 999;
    await listModels();
    expect(probe).toHaveBeenCalledTimes(1);

    currentTime = 1_000;
    const refreshed = listModels();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    resolveProbe(discovered("claude-sonnet-5"));
    await expect(refreshed).resolves.toEqual(
      buildClaudeCodeModels(discovered("claude-sonnet-5")),
    );
  });

  it("does not keep a failed probe", async () => {
    const probe = vi
      .fn<() => Promise<ModelInfo[]>>()
      .mockRejectedValueOnce(new Error("temporary discovery failure"))
      .mockResolvedValueOnce(discovered("claude-opus-5[1m]"));
    const listModels = createClaudeCodeBridgeModelListMemo({
      probe,
      now: Date.now,
      ttlMs: 60_000,
      shared: () => UNSHARED_CLAUDE_CODE_MODEL_CATALOG,
      renewalDue: () => Promise.resolve(false),
    });

    await expect(listModels()).rejects.toThrow("temporary discovery failure");
    await expect(listModels()).resolves.toEqual(
      buildClaudeCodeModels(discovered("claude-opus-5[1m]")),
    );
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("serves a catalog another bridge worker probed within the window instead of probing again", async () => {
    const shared = memoryCatalog();
    const firstWorkerProbe = vi.fn(() =>
      Promise.resolve(discovered("claude-opus-5[1m]")),
    );
    const secondWorkerProbe = vi.fn(() =>
      Promise.resolve(discovered("claude-sonnet-5")),
    );
    const options = {
      now: () => 10_000,
      ttlMs: 120_000,
      shared: () => shared,
      renewalDue: () => Promise.resolve(false),
    };

    await createClaudeCodeBridgeModelListMemo({
      ...options,
      probe: firstWorkerProbe,
    })();
    const fromSecondWorker = await createClaudeCodeBridgeModelListMemo({
      ...options,
      probe: secondWorkerProbe,
    })();

    expect(secondWorkerProbe).not.toHaveBeenCalled();
    expect(fromSecondWorker).toEqual(
      buildClaudeCodeModels(discovered("claude-opus-5[1m]")),
    );
  });

  it("does not start a probe while the sign-in is due for renewal", async () => {
    const shared = memoryCatalog();
    shared.entry = { savedAt: 0, discoveredModels: discovered("claude-sonnet-5") };
    const probe = vi.fn(() => Promise.resolve(discovered("claude-opus-5[1m]")));
    const listModels = createClaudeCodeBridgeModelListMemo({
      probe,
      now: () => 10_000_000,
      ttlMs: 120_000,
      shared: () => shared,
      renewalDue: () => Promise.resolve(true),
    });

    await expect(listModels()).resolves.toEqual(
      buildClaudeCodeModels(discovered("claude-sonnet-5")),
    );
    expect(probe).not.toHaveBeenCalled();
  });

  it("serves the built-in catalog without persisting it when renewal is due and nothing was probed", async () => {
    const shared = memoryCatalog();
    const probe = vi.fn(() => Promise.resolve(discovered("claude-opus-5[1m]")));
    const listModels = createClaudeCodeBridgeModelListMemo({
      probe,
      now: Date.now,
      ttlMs: 120_000,
      shared: () => shared,
      renewalDue: () => Promise.resolve(true),
    });

    await expect(listModels()).resolves.toEqual(buildClaudeCodeModels([]));
    expect(probe).not.toHaveBeenCalled();
    expect(shared.entry).toBeNull();
  });
});

describe("createSharedClaudeCodeModelCatalogFile", () => {
  it("round-trips a probed catalog and ignores a malformed file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-claude-model-catalog-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "nested", "catalog.json");
    const catalog = createSharedClaudeCodeModelCatalogFile(filePath);

    await expect(catalog.read()).resolves.toBeNull();
    await catalog.write({
      savedAt: 42,
      discoveredModels: discovered("claude-opus-5[1m]"),
    });
    await expect(catalog.read()).resolves.toEqual({
      savedAt: 42,
      discoveredModels: discovered("claude-opus-5[1m]"),
    });

    writeFileSync(filePath, "{ not json");
    await expect(catalog.read()).resolves.toBeNull();
  });
});
