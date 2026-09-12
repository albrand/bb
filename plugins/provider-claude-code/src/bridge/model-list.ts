import fs from "node:fs/promises";
import path from "node:path";
import { type AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";
import {
  query,
  type ModelInfo,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { buildClaudeCodeModels } from "../model-list.js";
import { afterClaudeRenewalSettles } from "./claude-refresh-lock.js";
import { translateMissingClaudeCliError } from "./missing-cli-error.js";
import { resolveClaudeCodeExecutable } from "./session-options.js";

function buildModelProbeOptions(env: NodeJS.ProcessEnv): Options {
  const pathToClaudeCodeExecutable = resolveClaudeCodeExecutable({ env });
  return {
    cwd: process.cwd(),
    maxTurns: 0,
    persistSession: false,
    allowDangerouslySkipPermissions: true,
    permissionMode: "bypassPermissions",
    settingSources: [],
    ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
  };
}

export async function probeClaudeCodeDiscoveredModels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ModelInfo[]> {
  let session: ReturnType<typeof query>;
  try {
    session = query({
      prompt: ".",
      options: buildModelProbeOptions(env),
    });
  } catch (error) {
    throw translateMissingClaudeCliError(error);
  }

  try {
    const initialization = await session.initializationResult();
    return initialization.models;
  } catch (error) {
    throw translateMissingClaudeCliError(error);
  } finally {
    await afterClaudeRenewalSettles(env);
    session.close();
  }
}

export async function listClaudeCodeBridgeModels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}> {
  return buildClaudeCodeModels(await probeClaudeCodeDiscoveredModels(env));
}

type ClaudeCodeModelCatalog = Awaited<
  ReturnType<typeof listClaudeCodeBridgeModels>
>;

const sharedCatalogEntrySchema = z.object({
  savedAt: z.number(),
  discoveredModels: z.array(
    z.object({
      value: z.string(),
      resolvedModel: z.string().optional(),
      displayName: z.string(),
      description: z.string(),
      supportedEffortLevels: z
        .array(z.enum(["low", "medium", "high", "xhigh", "max"]))
        .optional(),
    }),
  ),
});

export type SharedClaudeCodeModelCatalogEntry = z.infer<
  typeof sharedCatalogEntrySchema
>;

export interface SharedClaudeCodeModelCatalog {
  read: () => Promise<SharedClaudeCodeModelCatalogEntry | null>;
  write: (entry: SharedClaudeCodeModelCatalogEntry) => Promise<void>;
}

export const UNSHARED_CLAUDE_CODE_MODEL_CATALOG: SharedClaudeCodeModelCatalog = {
  read: () => Promise.resolve(null),
  write: () => Promise.resolve(),
};

export function createSharedClaudeCodeModelCatalogFile(
  filePath: string,
): SharedClaudeCodeModelCatalog {
  return {
    read: async () => {
      try {
        const parsed = sharedCatalogEntrySchema.safeParse(
          JSON.parse(await fs.readFile(filePath, "utf8")),
        );
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    write: async (entry) => {
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(temporaryPath, JSON.stringify(entry), "utf8");
      await fs.rename(temporaryPath, filePath);
    },
  };
}

interface ClaudeCodeBridgeModelListMemoOptions {
  probe: () => Promise<ModelInfo[]>;
  now: () => number;
  ttlMs: number;
  shared: () => SharedClaudeCodeModelCatalog;
  renewalDue: () => Promise<boolean>;
}

export function createClaudeCodeBridgeModelListMemo({
  probe,
  now,
  ttlMs,
  shared,
  renewalDue,
}: ClaudeCodeBridgeModelListMemoOptions): () => Promise<ClaudeCodeModelCatalog> {
  let settled: SharedClaudeCodeModelCatalogEntry | null = null;
  let pending: Promise<ClaudeCodeModelCatalog> | null = null;
  const isFresh = (entry: SharedClaudeCodeModelCatalogEntry) =>
    entry.savedAt + ttlMs > now();
  const resolveCatalog = async (): Promise<ClaudeCodeModelCatalog> => {
    const cache = shared();
    const stored = await cache.read();
    if (stored !== null && isFresh(stored)) {
      settled = stored;
      return buildClaudeCodeModels(stored.discoveredModels);
    }
    if (await renewalDue()) {
      const lastGood =
        settled !== null && (stored === null || settled.savedAt >= stored.savedAt)
          ? settled
          : stored;
      return buildClaudeCodeModels(lastGood?.discoveredModels ?? []);
    }
    const entry = { savedAt: now(), discoveredModels: await probe() };
    settled = entry;
    await cache.write(entry).catch(() => undefined);
    return buildClaudeCodeModels(entry.discoveredModels);
  };
  return () => {
    if (settled !== null && isFresh(settled)) {
      return Promise.resolve(buildClaudeCodeModels(settled.discoveredModels));
    }
    if (pending !== null) {
      return pending;
    }
    const resolving = resolveCatalog().finally(() => {
      if (pending === resolving) {
        pending = null;
      }
    });
    pending = resolving;
    return resolving;
  };
}
