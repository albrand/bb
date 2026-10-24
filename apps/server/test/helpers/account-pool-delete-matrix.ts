import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { createConnection, getThread, type DbConnection } from "@bb/db";
import { createBbSdk } from "@bb/sdk/core";
import { createHttpTransport } from "@bb/sdk/node";
import type { BbPluginApi, PluginKvStorage } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setPluginThreadEventEmitter } from "../../src/services/plugins/plugin-thread-events.js";
import { toThreadResponseFromThread } from "../../src/services/threads/thread-runtime-display.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "./seed.js";
import { createTestAppHarness, type TestAppHarness } from "./test-app.js";

const API = "/api/v1";
const WORKSPACE_PATH = "/workspace/account-pool-delete-matrix";
const PARENT_TOKEN_ENV = "BB_ACCOUNT_POOL_PARENT_TOKEN";
const POOL_CREDENTIAL_ENV = ["ANTHROPIC_AUTH_TOKEN", PARENT_TOKEN_ENV];
const RECORD_PREFIXES = [
  "deleted-thread-",
  "archived-thread-",
  "archive-revocation-",
];
const CREDENTIAL_NAME =
  /^(?:suspended-)?(?:scoped-route-|scoped-process-route-|thread-route-|scoped-nested-route-|scoped-process-nested-route-|nested-route-)/u;

type Lifetime = "durable" | "process";
type FaultClass = "kv" | "content" | "rename" | "rm" | "mkdir";
const FAULT_CLASSES: readonly FaultClass[] = [
  "kv",
  "content",
  "rename",
  "rm",
  "mkdir",
];
type ContentPoint = "open" | "write" | "sync" | "dirsync";
const CONTENT_POINTS: readonly ContentPoint[] = [
  "open",
  "write",
  "sync",
  "dirsync",
];
type Mutation = {
  method: string;
  target: string;
  ok: boolean;
  refused: boolean;
};
type Injection = {
  mutations: Mutation[];
  crashedAt: number | null;
  crash: InjectedFault | null;
  crashed: Promise<never>;
  signalled: unknown;
};

function idleInjection(): Injection {
  return {
    mutations: [],
    crashedAt: null,
    crash: null,
    crashed: new Promise<never>(() => {}),
    signalled: null,
  };
}

async function settle(
  operation: Promise<unknown>,
  injection: () => Injection | null,
): Promise<{ errors: unknown[]; beforeCrash: boolean }> {
  return operation.then(
    () => ({ errors: [], beforeCrash: injection()?.signalled == null }),
    (error: unknown) => ({
      errors: [error],
      beforeCrash: injection()?.signalled == null,
    }),
  );
}
type Start = "delete" | "first" | "restart";
type CrashPoint = { during: Start; after: number };
type CrashStatus = "reached" | "beyond" | "missed";

class InjectedFault extends Error {
  readonly code: "EACCES" | "EIO";
  readonly mutation: number;

  constructor(message: string, code: "EACCES" | "EIO", mutation: number) {
    super(message);
    this.code = code;
    this.mutation = mutation;
  }
}

function carries(error: unknown, fault: InjectedFault): number {
  if (error === fault) return 1;
  if (error instanceof AggregateError)
    return error.errors.reduce<number>(
      (count, inner) => count + carries(inner, fault),
      0,
    );
  return error instanceof Error && error.cause !== undefined
    ? carries(error.cause, fault)
    : 0;
}

function injected(error: unknown): boolean {
  if (error instanceof InjectedFault) return true;
  if (error instanceof AggregateError)
    return error.errors.length > 0 && error.errors.every(injected);
  return (
    error instanceof Error && error.cause !== undefined && injected(error.cause)
  );
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

type Watch = {
  dataDir: string;
  directory: string;
  threadId: string;
  digest: string;
  kv: PluginKvStorage;
  violations: string[];
  unsynced: Set<string>;
  undurable: { from: string | null; to: string; previous: string | null }[];
};
type PoolRoute = {
  threadId: string;
  hostId: string;
  provider: "claude";
  accountId: null;
};
type NestedRoute = { threadId: string; hostId: string };
type PluginThreadTokens = {
  forThread(
    route: PoolRoute,
    hostToken: string,
    lifetime: Lifetime,
  ): Promise<string>;
  forNested(
    route: NestedRoute,
    hostToken: string,
    lifetime: Lifetime,
  ): Promise<string>;
};
type PluginHostTokens = { forHost(hostId: string): Promise<string> };
type Patchable = Record<string, (...args: unknown[]) => unknown>;
type Server = {
  db: DbConnection;
  harness: TestAppHarness | null;
  sdk: ReturnType<typeof createBbSdk>;
};
type Started = {
  pool: FakePluginHost;
  threadTokens: PluginThreadTokens;
  hostTokens: PluginHostTokens;
};
type Outcome = { token: boolean; mint: boolean; exported: boolean };

const pluginSource = (file: string) =>
  new URL(`../../../../plugins/account-pool/src/${file}`, import.meta.url).href;

const captured: {
  threadTokens: PluginThreadTokens | null;
  hostTokens: PluginHostTokens | null;
  sweep: Promise<unknown> | null;
} = { threadTokens: null, hostTokens: null, sweep: null };
const sweeping = () => captured.sweep;
const unpatch: (() => void)[] = [];
let plugin: (bb: BbPluginApi) => Promise<void>;

function patch(
  prototype: Patchable,
  method: string,
  record: (self: unknown, result: unknown) => void,
): void {
  const original = prototype[method];
  if (original === undefined) throw new Error(`no ${method} to observe`);
  prototype[method] = function (this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args);
    record(this, result);
    return result;
  };
  unpatch.push(() => {
    prototype[method] = original;
  });
}

async function observePlugin(): Promise<void> {
  const tokens = await import(pluginSource("thread-tokens.ts"));
  const store = await import(pluginSource("store.ts"));
  const server = await import(pluginSource("server.ts"));
  patch(tokens.ThreadTokenStore.prototype, "initialize", (self) => {
    captured.threadTokens = self as PluginThreadTokens;
  });
  patch(tokens.ThreadTokenStore.prototype, "sweepThreads", (_, result) => {
    captured.sweep = result as Promise<unknown>;
  });
  patch(store.HubTokenStore.prototype, "initialize", (self) => {
    captured.hostTokens = self as PluginHostTokens;
  });
  const createAccountPoolPlugin: (options: {
    now: () => number;
    env: NodeJS.ProcessEnv;
    fetch: typeof fetch;
  }) => (bb: BbPluginApi) => Promise<void> = server.createAccountPoolPlugin;
  plugin = createAccountPoolPlugin({
    now: Date.now,
    env: {},
    fetch: async () => Response.json({}, { status: 200 }),
  });
}

function stopObserving(): void {
  for (const restore of unpatch.splice(0).reverse()) restore();
  setPluginThreadEventEmitter(undefined);
}

function realSdk(harness: TestAppHarness) {
  return createBbSdk({
    transport: createHttpTransport({
      baseUrl: "http://localhost",
      runtime: "node",
      fetch: async (input, init) => harness.app.fetch(new Request(input, init)),
    }),
  });
}

async function restartServer(previous: Server): Promise<Server> {
  const db = createConnection(previous.db.$client.serialize());
  const harness = await createTestAppHarness({ db });
  if (previous.harness !== null) {
    await previous.harness.cleanup();
    previous.db.$client.close();
  }
  return { db, harness, sdk: realSdk(harness) };
}

async function stopServer(server: Server): Promise<void> {
  if (server.harness === null) return;
  await server.harness.cleanup();
  server.db.$client.close();
}

function isCredential(watch: Watch, name: string): boolean {
  return CREDENTIAL_NAME.test(name) && name.includes(watch.threadId);
}

async function durableRecords(
  watch: Watch,
): Promise<{ other: boolean; pending: boolean }> {
  const names = existsSync(watch.directory) ? readdirSync(watch.directory) : [];
  const durable = (name: string) =>
    names.includes(name) &&
    !watch.unsynced.has(name) &&
    !watch.undurable.some((entry) => entry.to === name);
  const deletedMarker = (name: string, digest: boolean) => {
    if (!durable(name)) return false;
    try {
      const value = JSON.parse(
        readFileSync(path.join(watch.directory, name), "utf8"),
      );
      return (
        value.deleted === true &&
        (!digest || value.threadDigest === watch.digest)
      );
    } catch {
      return false;
    }
  };
  const row = `deleted-thread:${watch.digest}`;
  return {
    other:
      (await watch.kv.list(row)).includes(row) ||
      deletedMarker(`deleted-thread-${watch.digest}.json`, true) ||
      durable(`deleted-thread-${watch.digest}.d`) ||
      deletedMarker(`archived-thread-${watch.digest}.json`, false) ||
      deletedMarker(`archive-revocation-${watch.digest}.json`, false),
    pending: names.some(
      (name) =>
        name.startsWith(`deleted-pending-${watch.digest}-`) && durable(name),
    ),
  };
}

function losePower(watch: Watch): void {
  for (const entry of watch.undurable.reverse()) {
    const to = path.join(watch.directory, entry.to);
    if (entry.from === null) rmSync(to, { recursive: true, force: true });
    else if (existsSync(to)) {
      renameSync(to, path.join(watch.directory, entry.from));
      if (entry.previous !== null) writeFileSync(to, entry.previous);
    }
  }
  for (const name of watch.unsynced) {
    const file = path.join(watch.directory, name);
    if (existsSync(file) && statSync(file).isFile()) truncateSync(file, 0);
  }
  watch.undurable.length = 0;
  watch.unsynced.clear();
}

async function checkRemoval(
  watch: Watch,
  method: string,
  args: readonly unknown[],
): Promise<void> {
  const source = String(args[0]);
  if (!["rm", "unlink", "rename"].includes(method) || !existsSync(source))
    return;
  const name = path.basename(source);
  const target = method === "rename" ? path.basename(String(args[1])) : null;
  const removesPending = name.startsWith("deleted-pending-");
  const removesCredential =
    isCredential(watch, name) &&
    (target === null ||
      (!CREDENTIAL_NAME.test(target) &&
        !target.startsWith("deleted-pending-")));
  if (!removesPending && !removesCredential) return;
  const records = await durableRecords(watch);
  if (removesPending ? records.other : records.other || records.pending) return;
  watch.violations.push(
    `${method} ${name}${target === null ? "" : ` -> ${target}`} while no ${removesPending ? "other " : ""}deletion record was durable`,
  );
}

const overrides: (() => void)[] = [];

function override<T extends object, K extends keyof T>(
  target: T,
  method: K,
  implementation: T[K],
): void {
  const original = target[method];
  target[method] = implementation;
  overrides.push(() => {
    target[method] = original;
  });
}

function restoreFaults(): void {
  for (const restore of overrides.splice(0).reverse()) restore();
}

function injectFaults(
  watch: Watch,
  faults: ReadonlySet<FaultClass>,
  crashAfter = Number.POSITIVE_INFINITY,
  point: ContentPoint = "open",
): Injection {
  const mutations: Mutation[] = [];
  let signal: (fault: InjectedFault) => void = () => {};
  const injection: Injection = {
    mutations,
    crashedAt: null,
    crash: null,
    crashed: new Promise<never>((_, reject) => {
      signal = reject;
    }),
    signalled: null,
  };
  injection.crashed.catch((fault: unknown) => {
    injection.signalled = fault;
  });
  let crashed = false;
  const crash = () => {
    if (!crashed) {
      const fault = new InjectedFault(
        "simulated crash",
        "EIO",
        mutations.length - 1,
      );
      injection.crashedAt = fault.mutation;
      injection.crash = fault;
      crashed = true;
      signal(fault);
      throw fault;
    }
    throw new InjectedFault(
      "write after the crash",
      "EIO",
      mutations.length - 1,
    );
  };
  const attempt = async <T>(
    method: string,
    target: unknown,
    fault: FaultClass | null,
    run: () => Promise<T>,
    args: readonly unknown[] = [],
  ): Promise<T> => {
    const mutation = {
      method,
      target: path.basename(String(target)),
      ok: false,
      refused: false,
    };
    mutations.push(mutation);
    if (crashed || mutations.length > crashAfter) crash();
    if (fault !== null && faults.has(fault)) {
      mutation.refused = true;
      throw new InjectedFault("refused", "EACCES", mutations.length - 1);
    }
    await checkRemoval(watch, method, args);
    const result = await run();
    mutation.ok = true;
    return result;
  };
  const inside = (file: unknown) =>
    path.resolve(String(file)).startsWith(`${watch.dataDir}${path.sep}`);
  const watched = (file: unknown) =>
    path.dirname(path.resolve(String(file))) === path.resolve(watch.directory);
  const isRecord = (file: unknown) =>
    RECORD_PREFIXES.some((prefix) =>
      path.basename(String(file)).startsWith(prefix),
    );
  const contentFault = (file: unknown, at: ContentPoint) =>
    isRecord(file) && point === at ? "content" : null;
  const kv = watch.kv;
  const originalSet = kv.set.bind(kv);
  override(kv, "set", async (key, value) => {
    if (!key.startsWith("deleted-thread:")) {
      if (crashed) crash();
      return originalSet(key, value);
    }
    return attempt("kv", key, "kv", () => originalSet(key, value));
  });
  const originalDelete = kv.delete.bind(kv);
  override(kv, "delete", async (key) => {
    if (crashed) crash();
    return originalDelete(key);
  });
  const originalOpen = fs.open.bind(fs);
  const handled = (
    file: unknown,
    handle: Awaited<ReturnType<typeof fs.open>>,
    writing: boolean,
  ) => {
    const name = path.basename(String(file));
    const directory = !writing && statSync(String(file)).isDirectory();
    const writeFile = handle.writeFile.bind(handle);
    return Object.assign(handle, {
      writeFile: (async (data: string) =>
        attempt("write", file, contentFault(file, "write"), async () => {
          await writeFile(data);
          if (watched(file)) watch.unsynced.add(name);
        })) as typeof handle.writeFile,
      sync: async () => {
        await attempt(
          directory ? "dirsync" : "sync",
          file,
          directory
            ? point === "dirsync"
              ? "content"
              : null
            : contentFault(file, "sync"),
          async () => {
            if (!directory) watch.unsynced.delete(name);
            else if (
              path.resolve(String(file)) === path.resolve(watch.directory)
            )
              watch.undurable.length = 0;
          },
        );
      },
    });
  };
  override(fs, "open", async (file, flags, mode) => {
    if (!inside(file)) return originalOpen(file, flags, mode);
    if (flags === undefined || flags === "r")
      return handled(file, await originalOpen(file, flags, mode), false);
    const existed = existsSync(String(file));
    return attempt("open", file, contentFault(file, "open"), async () => {
      const handle = await originalOpen(file, flags, mode);
      if (watched(file)) {
        watch.unsynced.add(path.basename(String(file)));
        if (!existed)
          watch.undurable.push({
            from: null,
            to: path.basename(String(file)),
            previous: null,
          });
      }
      return handled(file, handle, true);
    });
  });
  for (const [method, fault] of [
    ["rename", "rename"],
    ["rm", "rm"],
    ["unlink", "rm"],
    ["mkdir", "mkdir"],
    ["chmod", null],
    ["writeFile", null],
  ] as const) {
    const original = (
      fs[method] as (...args: unknown[]) => Promise<unknown>
    ).bind(fs);
    override(fs, method, (async (...args: unknown[]) => {
      if (!inside(args[0]) && !(method === "rename" && inside(args[1])))
        return original(...args);
      return attempt(
        method,
        method === "rename" ? args[1] : args[0],
        method === "mkdir" &&
          !path.basename(String(args[0])).startsWith("deleted-thread-")
          ? null
          : fault,
        async () => {
          const target = String(method === "rename" ? args[1] : args[0]);
          const existed = existsSync(target);
          const previous =
            method === "rename" && existed && statSync(target).isFile()
              ? readFileSync(target, "utf8")
              : null;
          const result = await original(...args);
          if ((method === "rm" || method === "unlink") && watched(args[0]))
            watch.unsynced.delete(path.basename(String(args[0])));
          if (watched(target)) {
            const to = path.basename(target);
            if (method === "rename") {
              const from = path.basename(String(args[0]));
              if (watch.unsynced.delete(from)) watch.unsynced.add(to);
              else watch.unsynced.delete(to);
              watch.undurable.push({ from, to, previous });
            }
            if (method === "mkdir" && !existed)
              watch.undurable.push({ from: null, to, previous: null });
          }
          return result;
        },
        args,
      );
    }) as never);
  }
  return injection;
}

function faultSubsets(): Set<FaultClass>[] {
  const subsets: Set<FaultClass>[] = [];
  for (let mask = 0; mask < 1 << FAULT_CLASSES.length; mask += 1)
    subsets.push(
      new Set(FAULT_CLASSES.filter((_, bit) => (mask & (1 << bit)) !== 0)),
    );
  return subsets;
}

function faultLabel(
  faults: ReadonlySet<FaultClass>,
  point: ContentPoint,
): string {
  return (
    [...faults]
      .map((fault) => (fault === "content" ? `content@${point}` : fault))
      .join("+") || "none"
  );
}

const yes = (value: boolean) => (value ? "yes" : "no");

const SAMPLED_CELLS = [1, 40, 80];
const MAX_RETAINED_GROWTH_MB = 64;
setFlagsFromString("--expose-gc");
const collectGarbage: () => void = runInNewContext("gc");

function retainedHeap(): number {
  collectGarbage();
  return Math.round(process.memoryUsage().heapUsed / 1_048_576);
}

type BbLink = { server: Server | null; lookups: string[] };
const STOPPED = "the deletion matrix stopped this plugin host";
const EXPORT_FAILED = "provider environment contribution failed: ";
const MINT_REFUSALS = [
  "Cannot mint a credential for a deleted thread.",
  "Cannot mint a credential for an archived thread.",
  "Cannot mint a credential for a thread bb has not confirmed live.",
];

function fakeBbSdk(host: World["host"], link: BbLink) {
  return {
    hosts: { list: async () => [host] },
    system: { providerStates: async () => ({ providers: [] }) },
    threads: {
      get: async (args: { threadId: string; signal?: AbortSignal }) => {
        link.lookups.push(args.threadId);
        if (link.server === null) throw new Error("bb's server is stopped");
        return link.server.sdk.threads.get(args);
      },
    },
    plugins: {
      list: async () => ({
        plugins: [{ id: "account-pool", enabled: true }],
      }),
    },
  };
}

type World = {
  base: TestAppHarness;
  hostId: string;
  projectId: string;
  environmentId: string;
  host: ReturnType<typeof seedHostSession>["host"];
  deliveries: Promise<{ errors: unknown[] }>[];
  current: { pool: FakePluginHost | null };
};

function deliverDeletes(world: World): void {
  const ignore = () => {};
  setPluginThreadEventEmitter({
    emitThreadEvents: ignore,
    emitTerminalInput: ignore,
    emitHostDeleted: ignore,
    emitEnvironmentRemoved: ignore,
    emitThreadCreated: ignore,
    emitThreadActive: ignore,
    emitThreadIdle: ignore,
    emitThreadFailed: ignore,
    emitThreadArchived: ignore,
    emitThreadDeleted: (deleted) => {
      const pool = world.current.pool;
      if (pool === null) throw new Error("no plugin host to deliver to");
      world.deliveries.push(
        pool.harness.behavior.emitThreadEvent("thread.deleted", {
          thread: toThreadResponseFromThread(
            {
              db: world.base.db,
              hub: world.base.deps.hub,
              providerRegistry: world.base.deps.providerRegistry,
            },
            { thread: deleted },
          ),
        }),
      );
    },
    emitInteractionPending: ignore,
    emitMessageQueued: ignore,
    emitMessageDispatched: ignore,
    emitMessageCancelled: ignore,
    emitThreadUnarchived: ignore,
    emitThreadParentChanged: ignore,
    emitTurnFailed: ignore,
  });
}

function seedWorld(base: TestAppHarness): World {
  const { host } = seedHostSession(base.deps, { id: "host-pool-matrix" });
  const { project } = seedProjectWithSource(base.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });
  const environment = seedEnvironment(base.deps, {
    hostId: host.id,
    projectId: project.id,
    path: WORKSPACE_PATH,
  });
  const world: World = {
    base,
    host,
    hostId: host.id,
    projectId: project.id,
    environmentId: environment.id,
    deliveries: [],
    current: { pool: null },
  };
  deliverDeletes(world);
  return world;
}

const DELETE_ROUTE_BUDGET_MS = 1_400;

async function deletionOutcome(
  world: World,
  lifetime: Lifetime,
  faults: ReadonlySet<FaultClass>,
  point: ContentPoint,
  files: 1 | 2,
  crash: CrashPoint | null,
) {
  const thread = seedThread(world.base.deps, {
    environmentId: world.environmentId,
    projectId: world.projectId,
  });
  const root = existsSync("/dev/shm") ? "/dev/shm" : tmpdir();
  const dataDir = await fs.mkdtemp(path.join(root, "bb-pool-matrix-"));
  let server: Server = {
    db: world.base.db,
    harness: null,
    sdk: realSdk(world.base),
  };
  const link: BbLink = { server, lookups: [] };
  const services: AbortController[] = [];
  const stopServices = () => {
    for (const controller of services.splice(0)) controller.abort(STOPPED);
  };
  const pool0 = createFakePluginHost({
    pluginId: "account-pool",
    dataDir,
    sdk: fakeBbSdk(world.host, link),
  });
  const watch: Watch = {
    dataDir,
    directory: path.join(
      dataDir,
      "plugins",
      "account-pool",
      "secrets",
      "accounts",
    ),
    threadId: thread.id,
    digest: createHash("sha256").update(thread.id).digest("hex"),
    kv: pool0.bb.storage.kv,
    violations: [],
    unsynced: new Set(),
    undurable: [],
  };
  const replaced = new WeakSet<object>();
  const capture = (pool: FakePluginHost): Started => {
    if (captured.threadTokens === null || captured.hostTokens === null)
      throw new Error("the plugin's token stores were not observed");
    if (
      replaced.has(pool) ||
      replaced.has(captured.threadTokens) ||
      replaced.has(captured.hostTokens)
    )
      throw new Error("the start reused a replaced plugin instance");
    return {
      pool,
      threadTokens: captured.threadTokens,
      hostTokens: captured.hostTokens,
    };
  };
  const retire = (pool: FakePluginHost) => {
    replaced.add(pool);
    if (captured.threadTokens !== null) replaced.add(captured.threadTokens);
    if (captured.hostTokens !== null) replaced.add(captured.hostTokens);
  };
  const unexpected: string[] = [];
  const expectInjected = (at: string, errors: readonly unknown[]) => {
    for (const error of errors)
      if (!injected(error)) unexpected.push(`${at}: ${describeError(error)}`);
  };
  const expectNone = (at: string, errors: readonly unknown[]) => {
    for (const error of errors)
      unexpected.push(`${at}: ${describeError(error)}`);
  };
  const crashDefects: string[] = [];
  let carriedByPlugin = false;
  const crashStatus = (
    during: Start,
    injection: Injection,
    beforeCrash: boolean,
    errors: readonly unknown[],
  ) => {
    if (crash?.during !== during) return null;
    const at = `${during}@${crash.after}`;
    const status: CrashStatus =
      injection.crashedAt === crash.after
        ? "reached"
        : injection.crashedAt === null &&
            injection.mutations.length <= crash.after
          ? "beyond"
          : "missed";
    if (status === "missed")
      crashDefects.push(
        `${at}: the crash fired at mutation ${injection.crashedAt ?? "none"} of ${injection.mutations.length}`,
      );
    if (status !== "reached") return status;
    const fault = injection.crash;
    if (
      fault === null ||
      injection.signalled !== fault ||
      fault.code !== "EIO" ||
      fault.mutation !== crash.after
    )
      crashDefects.push(
        `${at}: the operation did not end with the injected EIO crash at mutation ${crash.after}`,
      );
    if (beforeCrash)
      crashDefects.push(`${at}: the operation settled before its crash fired`);
    const survived = injection.mutations.findIndex(
      (mutation, index) => index >= crash.after && mutation.ok,
    );
    if (survived !== -1)
      crashDefects.push(
        `${at}: mutation ${survived} (${injection.mutations[survived]?.method} ${injection.mutations[survived]?.target}) succeeded after the crash`,
      );
    if (fault !== null && errors.some((error) => carries(error, fault) > 0))
      carriedByPlugin = true;
    return status;
  };
  const route: PoolRoute = {
    threadId: thread.id,
    hostId: world.hostId,
    provider: "claude",
    accountId: null,
  };
  const nestedRoute: NestedRoute = {
    threadId: thread.id,
    hostId: world.hostId,
  };
  const context = {
    threadId: thread.id,
    projectId: thread.projectId,
    hostId: world.hostId,
    ...(lifetime === "process"
      ? { experimental_runtimeKind: "native" as const }
      : {}),
  };
  const exportEntries = async (pool: FakePluginHost) =>
    (await pool.harness.behavior.resolveProviderEnv("claude-code", context))
      .filter((entry) => POOL_CREDENTIAL_ENV.includes(entry.name))
      .filter(
        (entry) => typeof entry.value === "string" && entry.value.length > 0,
      );
  const threadTokenAccepted = async (pool: FakePluginHost, token: string) =>
    (
      await pool.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: "claude-opus-4-1", messages: [] }),
      })
    ).status !== 401;
  const nestedTokenAccepted = async (pool: FakePluginHost, token: string) =>
    (
      await pool.harness.behavior.fetchHttp("GET", "/availability", {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status !== 401;
  const credentialFiles = () =>
    (existsSync(watch.directory) ? readdirSync(watch.directory) : []).filter(
      (name) => isCredential(watch, name),
    );
  let live: FakePluginHost = pool0;
  let started: Started | null = null;
  const sweepNow = async (pool: FakePluginHost): Promise<unknown[]> => {
    captured.sweep = null;
    services.push(pool.harness.behavior.runService("hub").controller);
    const sweep = sweeping();
    if (sweep === null)
      return [new Error("the start did not sweep the thread credentials")];
    return sweep.then(
      () => [],
      (error: unknown) => [error],
    );
  };
  const start = async (crashAt: number | undefined, sweep: boolean) => {
    stopServices();
    server = await restartServer(server);
    link.server = server;
    retire(live);
    started = null;
    const holder: { injection: Injection | null } = { injection: null };
    let atFactoryEnd = 0;
    const errors: unknown[] = [];
    captured.sweep = null;
    const operation = (async () => {
      const pool = await live.harness.lifecycle.reload(async (bb) => {
        restoreFaults();
        losePower(watch);
        watch.kv = bb.storage.kv;
        captured.threadTokens = null;
        captured.hostTokens = null;
        holder.injection = injectFaults(watch, new Set(), crashAt);
        await plugin(bb);
        atFactoryEnd = holder.injection.mutations.length;
      });
      const injection = holder.injection;
      if (injection !== null && injection.mutations.length !== atFactoryEnd)
        watch.violations.push(
          "the previous plugin instance mutated its data directory while it was being replaced",
        );
      live = pool;
      world.current.pool = pool;
      if (crashAt === undefined) started = capture(pool);
      if (sweep) errors.push(...(await sweepNow(pool)));
      else if (sweeping() !== null)
        errors.push(new Error("the start swept before it was probed"));
    })();
    const ended = await settle(operation, () => holder.injection);
    errors.push(...ended.errors);
    if (crashAt === undefined) restoreFaults();
    return {
      ...(holder.injection ?? idleInjection()),
      errors,
      beforeCrash: ended.beforeCrash,
    };
  };
  const probe = async (at: string): Promise<Outcome & { lookups: number }> => {
    if (started === null)
      throw new Error(`${at}: no fresh plugin instance to probe`);
    const { pool, threadTokens, hostTokens } = started;
    injectFaults(watch, new Set());
    link.lookups = [];
    const hostToken = await hostTokens.forHost(world.hostId);
    const refused = (mint: string) => (error: unknown) => {
      if (!(error instanceof Error && MINT_REFUSALS.includes(error.message)))
        unexpected.push(`${at}: ${mint} ${describeError(error)}`);
      return false;
    };
    const minted = [
      await threadTokens
        .forThread(route, hostToken, lifetime)
        .then(() => true, refused("forThread")),
      await threadTokens
        .forNested(nestedRoute, hostToken, lifetime)
        .then(() => true, refused("forNested")),
    ];
    const logged = pool.harness.inspection.logEntries.length;
    const exported = (await exportEntries(pool)).length > 0;
    for (const entry of pool.harness.inspection.logEntries.slice(logged))
      if (
        entry.message.startsWith(EXPORT_FAILED) &&
        !MINT_REFUSALS.includes(entry.message.slice(EXPORT_FAILED.length))
      )
        unexpected.push(`${at}: env export ${entry.message}`);
    const token =
      (await threadTokenAccepted(pool, tokens.token)) ||
      (tokens.nested !== null &&
        (await nestedTokenAccepted(pool, tokens.nested)));
    const rows = link.lookups.filter(
      (threadId) => threadId === thread.id,
    ).length;
    restoreFaults();
    return { token, mint: minted.some(Boolean), exported, lookups: rows };
  };
  const tokens: { token: string; nested: string | null } = {
    token: "",
    nested: null,
  };
  try {
    captured.threadTokens = null;
    captured.hostTokens = null;
    await plugin(pool0.bb);
    started = capture(pool0);
    world.current.pool = pool0;
    await pool0.harness.behavior.callRpc("account.add", {
      provider: "claude",
      source: { kind: "api-key", apiKey: "test-account" },
      label: null,
      priority: 1,
    });
    if (files === 2) {
      const entries = await exportEntries(pool0);
      const token = entries.find(
        (entry) => entry.name === "ANTHROPIC_AUTH_TOKEN",
      )?.value;
      const nested = entries.find(
        (entry) => entry.name === PARENT_TOKEN_ENV,
      )?.value;
      if (typeof token !== "string" || typeof nested !== "string")
        throw new Error("the env export did not mint both tokens");
      tokens.token = token;
      tokens.nested = nested;
    } else {
      tokens.token = await started.threadTokens.forThread(
        route,
        await started.hostTokens.forHost(world.hostId),
        lifetime,
      );
    }
    expect(credentialFiles()).toHaveLength(files);
    expect(await threadTokenAccepted(pool0, tokens.token)).toBe(true);
    if (tokens.nested !== null)
      expect(await nestedTokenAccepted(pool0, tokens.nested)).toBe(true);

    watch.kv = pool0.bb.storage.kv;
    deliverDeletes(world);
    const deleteInjection = injectFaults(
      watch,
      faults,
      crash?.during === "delete" ? crash.after : undefined,
      point,
    );
    const deleteMutations = deleteInjection.mutations;
    const requestedAt = Date.now();
    const deleted = await world.base.app.request(
      `${API}/threads/${thread.id}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ childThreadsConfirmed: false }),
      },
    );
    const waitedMs = Date.now() - requestedAt;
    if (waitedMs >= DELETE_ROUTE_BUDGET_MS)
      throw new Error(
        `The delete route took ${waitedMs} ms; it waits for the host's answer about the thread's storage for up to 1500 ms, so a host that is not answered makes every cell of this matrix that slow`,
      );
    const deliveries = world.deliveries.splice(0);
    const delivery = await settle(
      Promise.all(deliveries),
      () => deleteInjection,
    );
    const delivered = await Promise.all(deliveries);
    if (crash?.during !== "delete") restoreFaults();
    expect(deleted.status).toBe(200);
    const faulted =
      deleteInjection.crashedAt !== null ||
      deleteMutations.some((mutation) => mutation.refused);
    const unrecorded = `Account Pooler could not record the deletion of thread ${thread.id};`;
    let explained = 0;
    expectInjected(
      "thread.deleted",
      delivered
        .flatMap((result) => result.errors)
        .filter((error) => {
          const reported =
            faulted &&
            error instanceof Error &&
            error.message.startsWith(unrecorded);
          if (reported) explained += 1;
          return !reported;
        }),
    );
    const crashes: Partial<Record<Start, CrashStatus | null>> = {
      delete: crashStatus(
        "delete",
        deleteInjection,
        delivery.beforeCrash,
        delivered.flatMap((result) => result.errors),
      ),
    };
    const durable = await durableRecords(watch);
    const probes: (Outcome & { lookups: number })[] = [];

    const first = await start(
      crash?.during === "first" ? crash.after : undefined,
      false,
    );
    const committed = getThread(server.db, thread.id)?.deletedAt ?? null;
    if (crash?.during === "first") {
      crashes.first = crashStatus(
        "first",
        first,
        first.beforeCrash,
        first.errors,
      );
      expectInjected("first start", first.errors);
    } else {
      expectNone("first start", first.errors);
      probes.push(await probe("first start"));
    }
    let restartMutations: Mutation[] = [];
    if (crash === null || crash.during === "restart") {
      const second = await start(crash?.after, true);
      restartMutations = second.mutations;
      if (crash === null) expectNone("second start", second.errors);
      else {
        crashes.restart = crashStatus(
          "restart",
          second,
          second.beforeCrash,
          second.errors,
        );
        expectInjected("crash restart", second.errors);
      }
    }
    const recovery = await start(undefined, false);
    expectNone("recovery start", recovery.errors);
    probes.push(await probe("recovery start before its sweep"));
    if (started === null) throw new Error("the recovery start did not start");
    injectFaults(watch, new Set());
    expectNone("recovery sweep", await sweepNow(started.pool));
    restoreFaults();
    probes.push(await probe("recovery start after its sweep"));
    return {
      outcome: {
        token: probes.some((p) => p.token),
        mint: probes.some((p) => p.mint),
        exported: probes.some((p) => p.exported),
      },
      committed: committed !== null,
      delivered: deliveries.length,
      asked: probes.every((p) => p.lookups > 0),
      probes: probes.length,
      recorded: durable.other || durable.pending,
      kvRefused: deleteMutations.some(
        (mutation) => mutation.method === "kv" && mutation.refused,
      ),
      deleteMutations,
      firstMutations: first.mutations,
      restartMutations,
      crash: crash === null ? null : (crashes[crash.during] ?? "missed"),
      unexpected,
      crashDefects,
      carriedByPlugin,
      explained,
      violations: watch.violations,
    };
  } finally {
    restoreFaults();
    world.current.pool = null;
    stopServices();
    await live.harness.lifecycle.dispose();
    await stopServer(server);
    link.server = null;
    link.lookups = [];
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

export function describeDeletionMatrix(lifetime: Lifetime, files: 1 | 2): void {
  describe(`Account Pooler deletion matrix through bb's real delete route (${lifetime} credentials, ${files} credential file${files === 1 ? "" : "s"})`, () => {
    beforeAll(observePlugin);
    afterAll(stopObserving);
    it("refuses every old token, mint and env export for every subset of refused plugin kv, content, rename, rm and directory mutations, content refused at its open, write, file sync or directory sync, and every crash point of the delete, of the first start and of the next start, each one the injected EIO at exactly its mutation while the crashing operation still runs, with no mutation at or after it succeeding, losing every unsynced change at each restart, minting first on a start that has not swept yet, probing a fresh recovery instance before and after its sweep after every crash, with every lookup after the delete read by the real SDK from the thread row of a bb server restarted on its serialized database", async () => {
      const base = await createTestAppHarness();
      const rows: string[] = [];
      const runs: number[] = [];
      const violations: string[] = [];
      const failures: string[] = [];
      const retained: { cell: number; megabytes: number }[] = [];
      const unexpected: string[] = [];
      const beyond: string[] = [];
      const crashDefects: string[] = [];
      const ended: Record<Start, number> = { delete: 0, first: 0, restart: 0 };
      const carried: Record<Start, number> = {
        delete: 0,
        first: 0,
        restart: 0,
      };
      const exercised: Record<Start, Record<CrashStatus, number>> = {
        delete: { reached: 0, beyond: 0, missed: 0 },
        first: { reached: 0, beyond: 0, missed: 0 },
        restart: { reached: 0, beyond: 0, missed: 0 },
      };
      let recoveries = 0;
      let cleanFinals = 0;
      let probed = 0;
      let explained = 0;
      try {
        const world = seedWorld(base);
        for (const faults of faultSubsets())
          for (const point of faults.has("content")
            ? CONTENT_POINTS
            : (["open"] as const)) {
            const cell = `${lifetime} | ${files} file${files === 1 ? "" : "s"} | refused: ${faultLabel(faults, point)}`;
            const outcomes: Outcome[] = [];
            const note = (
              at: string,
              run: Awaited<ReturnType<typeof deletionOutcome>>,
            ) => {
              violations.push(
                ...run.violations.map((v) => `${cell} ${at}: ${v}`),
              );
              unexpected.push(
                ...run.unexpected.map((u) => `${cell} ${at}: ${u}`),
              );
              outcomes.push(run.outcome);
              if (run.crash === null) cleanFinals += 1;
              else recoveries += 1;
              probed += run.probes;
              explained += run.explained;
              const during = at.split("@")[0];
              if (
                run.crash !== null &&
                (during === "delete" ||
                  during === "first" ||
                  during === "restart")
              ) {
                exercised[during][run.crash] += 1;
                crashDefects.push(
                  ...run.crashDefects.map((d) => `${cell} ${at}: ${d}`),
                );
                if (run.crash === "reached" && run.crashDefects.length === 0)
                  ended[during] += 1;
                if (run.carriedByPlugin) carried[during] += 1;
                if (run.crash === "beyond")
                  beyond.push(
                    `${cell} | ${at} | crash point beyond this start's mutations`,
                  );
              }
              if (
                run.outcome.token ||
                run.outcome.mint ||
                run.outcome.exported ||
                !run.committed ||
                run.delivered !== 1 ||
                !run.asked ||
                run.crash === "missed" ||
                run.unexpected.length > 0 ||
                run.crashDefects.length > 0
              )
                failures.push(
                  `${cell} | ${at} | crash point: ${run.crash ?? "none"} | crash defects: ${run.crashDefects.length} | unexpected errors: ${run.unexpected.length} | durable record before the crash: ${yes(run.recorded)} | kv write refused before the crash: ${yes(run.kvRefused)} | deletedAt committed in the restarted database: ${yes(run.committed)} | thread.deleted deliveries: ${run.delivered} | bb asked at every probe: ${yes(run.asked)} | old token accepted: ${yes(run.outcome.token)} | mint succeeds: ${yes(run.outcome.mint)} | export carries a pool credential: ${yes(run.outcome.exported)}`,
                );
            };
            const first = await deletionOutcome(
              world,
              lifetime,
              faults,
              point,
              files,
              null,
            );
            note("completed", first);
            expect(first.deleteMutations.length).toBeGreaterThan(0);
            for (
              let after = 0;
              after < first.deleteMutations.length;
              after += 1
            )
              note(
                `delete@${after}`,
                await deletionOutcome(world, lifetime, faults, point, files, {
                  during: "delete",
                  after,
                }),
              );
            for (let after = 0; after < first.firstMutations.length; after += 1)
              note(
                `first@${after}`,
                await deletionOutcome(world, lifetime, faults, point, files, {
                  during: "first",
                  after,
                }),
              );
            for (
              let after = 0;
              after < first.restartMutations.length;
              after += 1
            )
              note(
                `restart@${after}`,
                await deletionOutcome(world, lifetime, faults, point, files, {
                  during: "restart",
                  after,
                }),
              );
            rows.push(
              `${cell} | durable record: ${yes(first.recorded)} | old token accepted: ${yes(outcomes.some((o) => o.token))} | mint succeeds: ${yes(outcomes.some((o) => o.mint))} | export carries a pool credential: ${yes(outcomes.some((o) => o.exported))} | runs: ${outcomes.length}`,
            );
            runs.push(outcomes.length);
            if (SAMPLED_CELLS.includes(rows.length))
              retained.push({ cell: rows.length, megabytes: retainedHeap() });
          }
      } finally {
        await base.cleanup();
      }
      const label = `${lifetime}, ${files} file${files === 1 ? "" : "s"}`;
      process.stdout.write(
        `${[
          `deletion matrix through bb's real delete route (${label}); every unsynced change is lost at each restart, the first start mints, exports and authenticates before any sweep, and every lookup after the delete reads bb's restarted database through the real SDK:`,
          ...rows,
          "",
          `runs that accepted an old token, minted, exported a pool credential, lost the committed delete, did not receive exactly one thread.deleted, never asked bb, missed its crash point or hit an error that was not injected (${label}: ${failures.length}):`,
          ...failures,
          "",
          `invariant violations (${label}: ${violations.length}):`,
          ...violations,
          "",
          `crash points (${label}): ${(["delete", "first", "restart"] as const).map((during) => `${during === "delete" ? "delete" : during === "first" ? "first start" : "crash restart"} ${exercised[during].reached + exercised[during].beyond + exercised[during].missed} exercised, ${exercised[during].reached} reached, ${exercised[during].beyond} beyond, ${exercised[during].missed} missed`).join("; ")}; final start: 0 crash points, ${recoveries} recovery starts after a crash point, each a fresh plugin instance over the crashed data directory and the restarted database, and ${cleanFinals} final starts after a run without a crash, every one probed before and after its sweep (${probed} probes in all)`,
          `thread.deleted reported the deletion unrecorded after an injected refusal or crash of that delete (${label}: ${explained})`,
          `crash points beyond this start's mutations (${label}: ${beyond.length}):`,
          ...beyond,
          "",
          `crash runs that ended the world at their crash point: the operation was still running when its EIO fired, and no mutation at or after it succeeded (${label}): ${(["delete", "first", "restart"] as const).map((during) => `${during} ${ended[during]} of ${exercised[during].reached + exercised[during].beyond + exercised[during].missed}`).join(", ")}`,
          `crash runs whose injected EIO also came out through the plugin's own error path (${label}): ${(["delete", "first", "restart"] as const).map((during) => `${during} ${carried[during]}`).join(", ")}`,
          `crash defects (${label}: ${crashDefects.length}):`,
          ...crashDefects,
          "",
          `unexpected errors (${label}: ${unexpected.length}):`,
          ...unexpected,
          "",
          `retained heap after a full GC (${label}): ${retained.map(({ cell, megabytes }) => `cell ${cell} ${megabytes} MB`).join(", ")}`,
          `worker memory (${label}): heap used ${Math.round(process.memoryUsage().heapUsed / 1_048_576)} MB at the end, heap limit ${Math.round(getHeapStatistics().heap_size_limit / 1_048_576)} MB, peak resident ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`,
        ].join("\n")}\n`,
      );
      expect(violations).toEqual([]);
      expect(unexpected).toEqual([]);
      expect(crashDefects).toEqual([]);
      expect(beyond).toEqual([]);
      expect(failures).toEqual([]);
      expect(exercised.restart.reached).toBeGreaterThan(0);
      expect(exercised.delete.reached).toBeGreaterThan(0);
      expect(rows).toHaveLength(80);
      expect(retained.map(({ cell }) => cell)).toEqual(SAMPLED_CELLS);
      const growth =
        (retained.at(-1)?.megabytes ?? 0) - (retained[0]?.megabytes ?? 0);
      expect(growth).toBeLessThan(MAX_RETAINED_GROWTH_MB);
      expect(runs.every((count) => count > 1)).toBe(true);
    }, 1_800_000);
  });
}
