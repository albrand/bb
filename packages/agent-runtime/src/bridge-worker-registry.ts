import { randomBytes } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { BRIDGE_SHUTDOWN_METHOD } from "@bb/provider-bridge-protocol/bridge-kit";
import { z } from "zod";

const bridgeWorkerRegistryEntrySchema = z.object({
  id: z.string().regex(/^[0-9a-f]+$/u),
  pid: z.number().int().positive(),
  socketPath: z.string().min(1),
  pluginId: z.string().min(1),
  providerId: z.string().min(1),
  processKey: z.string().min(1),
  environmentId: z.string().min(1),
  bridgeProtocolVersion: z.number().int(),
  transportVersion: z.number().int(),
  startedAt: z.string().min(1),
});

export type BridgeWorkerRegistryEntry = z.infer<
  typeof bridgeWorkerRegistryEntrySchema
>;

const ENTRY_SUFFIX = ".json";

function entryPath(dir: string, id: string): string {
  return join(dir, `${id}${ENTRY_SUFFIX}`);
}

export function writeBridgeWorkerEntry(
  dir: string,
  entry: BridgeWorkerRegistryEntry,
): void {
  const target = entryPath(dir, entry.id);
  const temporary = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600 });
  try {
    renameSync(temporary, target);
  } catch (error) {
    removeIfPresent(temporary);
    throw error;
  }
}

export function removeBridgeWorkerFiles(args: {
  dir: string;
  id: string;
  socketPath: string;
}): void {
  removeIfPresent(entryPath(args.dir, args.id));
  removeIfPresent(join(args.dir, `${args.id}.log`));
  removeIfPresent(join(args.dir, `${args.id}.buf`));
  if (!args.socketPath.startsWith("\\\\")) removeIfPresent(args.socketPath);
}

export function readBridgeWorkerEntries(dir: string): {
  entries: BridgeWorkerRegistryEntry[];
  invalidIds: string[];
} {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { entries: [], invalidIds: [] };
  }
  const entries: BridgeWorkerRegistryEntry[] = [];
  const invalidIds: string[] = [];
  for (const name of names) {
    if (!name.endsWith(ENTRY_SUFFIX)) continue;
    const id = name.slice(0, -ENTRY_SUFFIX.length);
    try {
      const parsed = bridgeWorkerRegistryEntrySchema.safeParse(
        JSON.parse(readFileSync(join(dir, name), "utf8")),
      );
      if (parsed.success && parsed.data.id === id) {
        entries.push(parsed.data);
        continue;
      }
    } catch {}
    invalidIds.push(id);
  }
  return { entries, invalidIds };
}

export function isBridgeWorkerPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && Reflect.get(error, "code") === "EPERM";
  }
}

export function reapDeadBridgeWorkers(
  dir: string,
  isAlive: (pid: number) => boolean = isBridgeWorkerPidAlive,
): { live: BridgeWorkerRegistryEntry[]; reaped: BridgeWorkerRegistryEntry[] } {
  const { entries, invalidIds } = readBridgeWorkerEntries(dir);
  for (const id of invalidIds) {
    removeIfPresent(entryPath(dir, id));
  }
  const live: BridgeWorkerRegistryEntry[] = [];
  const reaped: BridgeWorkerRegistryEntry[] = [];
  for (const entry of entries) {
    if (isAlive(entry.pid)) {
      live.push(entry);
      continue;
    }
    removeBridgeWorkerFiles({
      dir,
      id: entry.id,
      socketPath: entry.socketPath,
    });
    reaped.push(entry);
  }
  return { live, reaped };
}

export async function retireBridgeWorker(args: {
  dir: string;
  entry: BridgeWorkerRegistryEntry;
  timeoutMs: number;
}): Promise<"retired" | "unreachable"> {
  const outcome = await new Promise<"retired" | "unreachable">((resolve) => {
    const socket = connect(args.entry.socketPath);
    let requested = false;
    const timer = setTimeout(() => socket.destroy(), args.timeoutMs);
    socket.once("connect", () => {
      requested = true;
      socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: BRIDGE_SHUTDOWN_METHOD })}\n`,
      );
    });
    socket.on("error", () => undefined);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(requested ? "retired" : "unreachable");
    });
  });
  removeBridgeWorkerFiles({
    dir: args.dir,
    id: args.entry.id,
    socketPath: args.entry.socketPath,
  });
  return outcome;
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}
