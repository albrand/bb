import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { providerSchema } from "./contracts.js";
import type { HubTokenStore } from "./store.js";

const THREAD_ROUTE_PREFIX = "thread-route-";
const NESTED_ROUTE_PREFIX = "nested-route-";
const ARCHIVED_THREAD_PREFIX = "archived-thread-";

const identifierSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const archiveStateSchema = z
  .object({
    threadId: identifierSchema,
    epoch: z.number().int().nonnegative(),
    archived: z.boolean(),
  })
  .strict();

const routeSchema = z
  .object({
    hostId: identifierSchema,
    threadId: identifierSchema,
    provider: providerSchema,
    accountId: z.string().uuid().nullable(),
    token: tokenSchema,
    hostTokenDigest: digestSchema,
  })
  .strict();

const nestedRouteSchema = z
  .object({
    hostId: identifierSchema,
    threadId: identifierSchema,
    token: tokenSchema,
    hostTokenDigest: digestSchema,
  })
  .strict();

type RouteRecord = z.infer<typeof routeSchema>;
type NestedRouteRecord = z.infer<typeof nestedRouteSchema>;

export type ThreadRoute = Omit<RouteRecord, "token" | "hostTokenDigest">;
export type NestedRoute = Omit<NestedRouteRecord, "token" | "hostTokenDigest">;

export class ThreadTokenStore {
  private readonly routes = new Map<string, RouteRecord>();
  private readonly tokenIndex = new Map<string, RouteRecord>();
  private readonly nestedRoutes = new Map<string, NestedRouteRecord>();
  private readonly nestedTokenIndex = new Map<string, NestedRouteRecord>();
  private readonly archivedThreads = new Set<string>();
  private readonly activeArchiveMarkers = new Set<string>();
  private readonly archiveEpochs = new Map<string, number>();
  private readonly unreadableArchiveMarkers = new Set<string>();
  private readonly archiveVersions = new Map<string, number>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly hosts: HubTokenStore,
  ) {}

  async initialize(hostIds: readonly string[]): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const enrolled = new Set(hostIds);
    const names = await fs.readdir(this.directory);
    for (const name of names) {
      if (name.startsWith(ARCHIVED_THREAD_PREFIX) && name.endsWith(".json"))
        await this.loadArchiveMarker(name);
    }
    for (const name of names) {
      await this.loadFile(name, enrolled).catch(() => undefined);
    }
  }

  private async loadArchiveMarker(name: string): Promise<void> {
    try {
      const parsed = archiveStateSchema.safeParse(
        JSON.parse(await fs.readFile(path.join(this.directory, name), "utf8")),
      );
      if (
        !parsed.success ||
        name !== `${ARCHIVED_THREAD_PREFIX}${digest(parsed.data.threadId)}.json`
      ) {
        this.unreadableArchiveMarkers.add(name);
        return;
      }
      this.archiveEpochs.set(parsed.data.threadId, parsed.data.epoch);
      if (parsed.data.archived) this.archivedThreads.add(parsed.data.threadId);
      else this.activeArchiveMarkers.add(parsed.data.threadId);
    } catch {
      this.unreadableArchiveMarkers.add(name);
    }
  }

  private async loadFile(
    name: string,
    enrolled: ReadonlySet<string>,
  ): Promise<void> {
    if (!name.endsWith(".json")) return;
    const file = path.join(this.directory, name);
    if (name.startsWith(ARCHIVED_THREAD_PREFIX)) return;
    if (name.startsWith(THREAD_ROUTE_PREFIX)) {
      const record = await readRecord(file, routeSchema);
      if (
        record !== null &&
        !(await this.isArchived(record.threadId)) &&
        this.fileEpoch(name) === this.archiveEpoch(record.threadId) &&
        (await this.isLive(record, enrolled))
      ) {
        this.routes.set(this.key(record, record.hostTokenDigest), record);
        this.tokenIndex.set(digest(record.token), record);
      } else await fs.rm(file, { force: true });
    } else if (name.startsWith(NESTED_ROUTE_PREFIX)) {
      const record = await readRecord(file, nestedRouteSchema);
      if (
        record !== null &&
        !(await this.isArchived(record.threadId)) &&
        this.fileEpoch(name) === this.archiveEpoch(record.threadId) &&
        (await this.isLive(record, enrolled))
      ) {
        this.nestedRoutes.set(
          this.nestedKey(record, record.hostTokenDigest),
          record,
        );
        this.nestedTokenIndex.set(digest(record.token), record);
      } else await fs.rm(file, { force: true });
    }
  }

  async forThread(route: ThreadRoute, hostToken: string): Promise<string> {
    const parsed = routeSchema
      .omit({ token: true, hostTokenDigest: true })
      .parse(route);
    const hostTokenDigest = digest(hostToken);
    return this.serialize(async () => {
      if (await this.isArchived(parsed.threadId))
        throw new Error("Cannot mint a credential for an archived thread.");
      const key = this.key(parsed, hostTokenDigest);
      const existing = this.routes.get(key);
      if (existing !== undefined) return existing.token;
      const record = {
        ...parsed,
        hostTokenDigest,
        token: randomBytes(32).toString("base64url"),
      };
      await this.persist(this.file(record), record);
      this.routes.set(key, record);
      this.tokenIndex.set(digest(record.token), record);
      await this.reclaimDead(record);
      return record.token;
    });
  }

  async forNested(route: NestedRoute, hostToken: string): Promise<string> {
    const parsed = nestedRouteSchema
      .omit({ token: true, hostTokenDigest: true })
      .parse(route);
    const hostTokenDigest = digest(hostToken);
    return this.serialize(async () => {
      if (await this.isArchived(parsed.threadId))
        throw new Error("Cannot mint a credential for an archived thread.");
      const key = this.nestedKey(parsed, hostTokenDigest);
      const existing = this.nestedRoutes.get(key);
      if (existing !== undefined) return existing.token;
      const record = {
        ...parsed,
        hostTokenDigest,
        token: randomBytes(32).toString("base64url"),
      };
      await this.persist(this.nestedFile(record), record);
      this.nestedRoutes.set(key, record);
      this.nestedTokenIndex.set(digest(record.token), record);
      await this.reclaimDead(record);
      return record.token;
    });
  }

  async authenticate(
    token: string | null,
    provider?: ThreadRoute["provider"],
  ): Promise<ThreadRoute | null> {
    const record = lookup(this.tokenIndex, token);
    if (record === null) return null;
    if (await this.isArchived(record.threadId)) return null;
    if (provider !== undefined && provider !== record.provider) return null;
    if (
      !(await this.hosts.authenticateGeneration(
        record.hostId,
        record.hostTokenDigest,
      ))
    )
      return null;
    return {
      hostId: record.hostId,
      threadId: record.threadId,
      provider: record.provider,
      accountId: record.accountId,
    };
  }

  async authenticateNested(token: string | null): Promise<NestedRoute | null> {
    const record = lookup(this.nestedTokenIndex, token);
    if (record === null) return null;
    if (await this.isArchived(record.threadId)) return null;
    if (
      !(await this.hosts.authenticateGeneration(
        record.hostId,
        record.hostTokenDigest,
      ))
    )
      return null;
    return { hostId: record.hostId, threadId: record.threadId };
  }

  async removeThread(threadId: string): Promise<void> {
    this.archiveVersions.set(threadId, this.archiveVersion(threadId) + 1);
    const advanceEpoch = !this.archivedThreads.has(threadId);
    this.archivedThreads.add(threadId);
    this.activeArchiveMarkers.delete(threadId);
    await this.serialize(async () => {
      const epoch = this.archiveEpoch(threadId);
      const nextEpoch = advanceEpoch ? epoch + 1 : epoch;
      this.archiveEpochs.set(threadId, nextEpoch);
      await this.persist(this.archivedFile(threadId), {
        threadId,
        epoch: nextEpoch,
        archived: true,
      });
      for (const [key, record] of this.routes) {
        if (record.threadId !== threadId) continue;
        await fs.rm(this.fileAtEpoch(record, Math.max(0, nextEpoch - 1)), {
          force: true,
        });
        this.routes.delete(key);
        this.tokenIndex.delete(digest(record.token));
      }
      for (const [key, record] of this.nestedRoutes) {
        if (record.threadId !== threadId) continue;
        await fs.rm(
          this.nestedFileAtEpoch(record, Math.max(0, nextEpoch - 1)),
          { force: true },
        );
        this.nestedRoutes.delete(key);
        this.nestedTokenIndex.delete(digest(record.token));
      }
    });
  }

  archiveVersion(threadId: string): number {
    return this.archiveVersions.get(threadId) ?? 0;
  }

  async restoreThread(threadId: string, expectedVersion: number): Promise<void> {
    await this.serialize(async () => {
      if (this.archiveVersion(threadId) !== expectedVersion) return;
      if (this.unreadableArchiveMarkers.has(this.archivedName(threadId))) return;
      if (this.activeArchiveMarkers.has(threadId)) return;
      const epoch = this.archiveEpoch(threadId);
      if (epoch === 0 && !this.archivedThreads.has(threadId)) return;
      await this.persist(this.archivedFile(threadId), {
        threadId,
        epoch,
        archived: false,
      });
      this.archivedThreads.delete(threadId);
      this.activeArchiveMarkers.add(threadId);
    });
  }

  private async reclaimDead(minted: {
    hostId: string;
    threadId: string;
    hostTokenDigest: string;
  }): Promise<void> {
    const stale = (record: {
      hostId: string;
      threadId: string;
      hostTokenDigest: string;
    }) =>
      record.hostId === minted.hostId &&
      record.threadId === minted.threadId &&
      record.hostTokenDigest !== minted.hostTokenDigest;
    for (const [key, record] of this.routes) {
      if (!stale(record) || (await this.isGenerationLive(record))) continue;
      await fs.rm(this.file(record), { force: true }).catch(() => undefined);
      this.routes.delete(key);
      this.tokenIndex.delete(digest(record.token));
    }
    for (const [key, record] of this.nestedRoutes) {
      if (!stale(record) || (await this.isGenerationLive(record))) continue;
      await fs
        .rm(this.nestedFile(record), { force: true })
        .catch(() => undefined);
      this.nestedRoutes.delete(key);
      this.nestedTokenIndex.delete(digest(record.token));
    }
  }

  private isGenerationLive(record: {
    hostId: string;
    hostTokenDigest: string;
  }): Promise<boolean> {
    return this.hosts.isGenerationLive(record.hostId, record.hostTokenDigest);
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async isLive(
    record: { hostId: string; hostTokenDigest: string },
    enrolled: ReadonlySet<string>,
  ): Promise<boolean> {
    return enrolled.has(record.hostId) && (await this.isGenerationLive(record));
  }

  private async persist(file: string, record: object): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(temporary, file);
  }

  private key(route: ThreadRoute, hostTokenDigest: string): string {
    return `${route.hostId}-${route.provider}-${route.threadId}-${route.accountId ?? "automatic"}-${hostTokenDigest}`;
  }

  private file(route: ThreadRoute & { hostTokenDigest: string }): string {
    return this.fileAtEpoch(route, this.archiveEpoch(route.threadId));
  }

  private fileAtEpoch(
    route: ThreadRoute & { hostTokenDigest: string },
    epoch: number,
  ): string {
    return path.join(
      this.directory,
      `${THREAD_ROUTE_PREFIX}${this.key(route, route.hostTokenDigest)}-v${epoch}.json`,
    );
  }

  private nestedKey(route: NestedRoute, hostTokenDigest: string): string {
    return `${route.hostId}-${route.threadId}-${hostTokenDigest}`;
  }

  private nestedFile(route: NestedRoute & { hostTokenDigest: string }): string {
    return this.nestedFileAtEpoch(route, this.archiveEpoch(route.threadId));
  }

  private nestedFileAtEpoch(
    route: NestedRoute & { hostTokenDigest: string },
    epoch: number,
  ): string {
    return path.join(
      this.directory,
      `${NESTED_ROUTE_PREFIX}${this.nestedKey(route, route.hostTokenDigest)}-v${epoch}.json`,
    );
  }

  private archivedFile(threadId: string): string {
    return path.join(this.directory, this.archivedName(threadId));
  }

  private archivedName(threadId: string): string {
    return `${ARCHIVED_THREAD_PREFIX}${digest(threadId)}.json`;
  }

  private archiveEpoch(threadId: string): number {
    return this.archiveEpochs.get(threadId) ?? 0;
  }

  private fileEpoch(name: string): number {
    const match = /-v([0-9]+)\.json$/u.exec(name);
    return match === null ? 0 : Number(match[1]);
  }

  private async isArchived(threadId: string): Promise<boolean> {
    if (this.archivedThreads.has(threadId)) return true;
    if (this.activeArchiveMarkers.has(threadId)) return false;
    const name = this.archivedName(threadId);
    if (this.unreadableArchiveMarkers.has(name)) return true;
    try {
      const parsed = archiveStateSchema.safeParse(
        JSON.parse(await fs.readFile(this.archivedFile(threadId), "utf8")),
      );
      if (!parsed.success || parsed.data.threadId !== threadId) {
        this.unreadableArchiveMarkers.add(name);
        return true;
      }
      this.archiveEpochs.set(threadId, parsed.data.epoch);
      if (parsed.data.archived) this.archivedThreads.add(threadId);
      else this.activeArchiveMarkers.add(threadId);
      return parsed.data.archived;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      this.unreadableArchiveMarkers.add(name);
      return true;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function lookup<T extends { token: string }>(
  index: ReadonlyMap<string, T>,
  token: string | null,
): T | null {
  if (token === null || token.length !== 43) return null;
  const record = index.get(digest(token));
  if (
    record === undefined ||
    !timingSafeEqual(Buffer.from(token), Buffer.from(record.token))
  )
    return null;
  return record;
}

async function readRecord<T>(
  file: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const text = await fs.readFile(file, "utf8");
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
