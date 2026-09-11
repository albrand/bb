import { rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPluginProcessTempDir } from "@bb/process-utils";
import { readBoundedLines } from "./bridge-kit/bounded-line-reader.js";
import {
  createRecordingLineSplitter,
  getBridgeRecorder,
} from "./bridge-kit/bridge-recorder.js";
import { createDescendantPauser } from "./bridge-kit/bridge-descendants.js";
import {
  BRIDGE_REATTACH_TTL_MS,
  BRIDGE_REPLAY_HARD_CAP_BYTES,
  BRIDGE_REPLAY_MEMORY_CAP_BYTES,
  BRIDGE_SOCKET_ENV,
  createBridgeSocketServer,
} from "./bridge-kit/bridge-socket-server.js";
import {
  PROVIDER_BRIDGE_EXPORT_NAME,
  parseProviderBridgeEntry,
  type ProviderBridgeEntry,
} from "./bridge-kit/provider-bridge-entry.js";

const [bridgeModulePath, pluginId, dataDir] = process.argv.slice(2);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (
  bridgeModulePath === undefined ||
  !isAbsolute(bridgeModulePath) ||
  pluginId === undefined ||
  pluginId === "" ||
  dataDir === undefined ||
  !isAbsolute(dataDir)
) {
  fail(
    "provider bridge bootstrap usage: <bridgeModulePath> <pluginId> <pluginDataDir> (absolute paths)",
  );
}

const tempDir = await createPluginProcessTempDir({
  pluginId,
  prefix: "bb-provider-bridge",
});

let removedTempDir = false;
function removeTempDir(): void {
  if (removedTempDir) return;
  removedTempDir = true;
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
}
process.once("exit", removeTempDir);

function reportOversizedLine(bytes: number): void {
  process.stderr.write(
    `Discarded an oversized JSON-RPC line from the runtime (${bytes} bytes).\n`,
  );
}

const providerPauser = createDescendantPauser();
const bridgeSocketPath = process.env[BRIDGE_SOCKET_ENV] ?? "";
delete process.env[BRIDGE_SOCKET_ENV];
const socketServer =
  bridgeSocketPath === ""
    ? null
    : createBridgeSocketServer({
        socketPath: bridgeSocketPath,
        spillPath: bridgeSocketPath.endsWith(".sock")
          ? `${bridgeSocketPath.slice(0, -".sock".length)}.buf`
          : join(tempDir, "replay.buf"),
        reattachTtlMs: BRIDGE_REATTACH_TTL_MS,
        memoryCapBytes: BRIDGE_REPLAY_MEMORY_CAP_BYTES,
        hardCapBytes: BRIDGE_REPLAY_HARD_CAP_BYTES,
        onOverflow: reportOversizedLine,
        onBackpressure: (paused, retainedBytes) => {
          const pids = paused ? providerPauser.stop() : providerPauser.resume();
          process.stderr.write(
            `${paused ? "Paused" : "Resumed"} provider processes [${pids.join(", ")}] with ${retainedBytes} unacknowledged bridge bytes.\n`,
          );
        },
      });
if (socketServer !== null) {
  process.stdout.write = ((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ): boolean => {
    const callback = rest.find(
      (value): value is (error?: Error) => void => typeof value === "function",
    );
    socketServer.write(chunk, callback);
    return true;
  }) as typeof process.stdout.write;
  process.once("exit", () => socketServer.close());
}

const recorder = getBridgeRecorder();
if (recorder !== null) {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const outbound = createRecordingLineSplitter((line) =>
    recorder.recordRuntimeLine("bridge→runtime", line),
  );
  process.stdout.write = ((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ): boolean => {
    outbound.push(chunk);
    return (originalStdoutWrite as (...args: unknown[]) => boolean)(
      chunk,
      ...rest,
    );
  }) as typeof process.stdout.write;
  process.once("exit", () => recorder.close());
}

let entry: ProviderBridgeEntry;
try {
  const imported: unknown = await import(pathToFileURL(bridgeModulePath).href);
  const parsed = parseProviderBridgeEntry(
    typeof imported === "object" && imported !== null
      ? Reflect.get(imported, PROVIDER_BRIDGE_EXPORT_NAME)
      : undefined,
  );
  if (parsed.entry === null) {
    fail(
      `plugin "${pluginId}" cannot run as a provider bridge: its host artifact ${parsed.problem} (${bridgeModulePath})`,
    );
  }
  entry = parsed.entry;
} catch (error) {
  removeTempDir();
  fail(
    `plugin "${pluginId}" failed to load its provider bridge: ${error instanceof Error ? error.message : String(error)}`,
  );
}

entry.start?.({ pluginId, dataDir, tempDir });

function resumeProviderBeforeSignal(handler: () => void): () => void {
  if (socketServer === null) return handler;
  return () => {
    providerPauser.resume();
    handler();
  };
}

if (entry.onSigterm) {
  process.once("SIGTERM", resumeProviderBeforeSignal(entry.onSigterm));
}
if (entry.onSigint) {
  process.once("SIGINT", resumeProviderBeforeSignal(entry.onSigint));
}

const onRuntimeLine =
  recorder === null
    ? entry.handleLine
    : (line: string) => {
        recorder.recordRuntimeLine("runtime→bridge", line);
        entry.handleLine(line);
      };

const BRIDGE_CLOSE_EXIT_GRACE_MS = 10_000;

function closeBridge(): void {
  removeTempDir();
  setTimeout(() => process.exit(0), BRIDGE_CLOSE_EXIT_GRACE_MS).unref();
  entry.onClose?.();
}

if (socketServer === null) {
  readBoundedLines({
    input: process.stdin,
    onLine: onRuntimeLine,
    onOverflow: reportOversizedLine,
    onClose: closeBridge,
  });
} else {
  await socketServer
    .listen({ onLine: onRuntimeLine, onShutdown: closeBridge })
    .catch((error: unknown) => {
      fail(
        `provider bridge could not listen on ${bridgeSocketPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}
