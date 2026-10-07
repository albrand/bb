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

const THREAD_ROUTE_PREFIX = "scoped-route-";
const LEGACY_THREAD_ROUTE_PREFIX = "thread-route-";
const NESTED_ROUTE_PREFIX = "scoped-nested-route-";
const LEGACY_NESTED_ROUTE_PREFIX = "nested-route-";
const ARCHIVED_THREAD_PREFIX = "archived-thread-";
const ARCHIVE_FALLBACK_PREFIX = "archive-revocation-";
const REVOKED_ROUTE_PREFIX = "revoked-route-";

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

export type ThreadLookup = (
  threadId: string,
  signal?: AbortSignal,
) => Promise<"live" | "gone">;
export type ThreadSweepResult = {
  checked: number;
  revoked: number;
  failed: number;
};

export class ThreadTokenStore {
  private readonly routes = new Map<string, RouteRecord>();
  private readonly tokenIndex = new Map<string, RouteRecord>();
  private readonly nestedRoutes = new Map<string, NestedRouteRecord>();
  private readonly nestedTokenIndex = new Map<string, NestedRouteRecord>();
  private readonly archivedThreads = new Set<string>();
  private readonly activeArchiveMarkers = new Set<string>();
  private readonly archiveEpochs = new Map<string, number>();
  private readonly seenArchiveMarkers = new Set<string>();
  private readonly transientArchiveReadFailures = new Set<string>();
  private readonly corruptArchiveMarkers = new Set<string>();
  private readonly archiveDurabilityFailures = new Set<string>();
  private archiveMarkersLoaded = false;
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
      if (
        (name.startsWith(ARCHIVED_THREAD_PREFIX) ||
          name.startsWith(ARCHIVE_FALLBACK_PREFIX)) &&
        name.endsWith(".json")
      )
        await this.loadArchiveMarker(name);
    }
    this.archiveMarkersLoaded = true;
    for (const name of names) {
      await this.loadFile(name, enrolled).catch(() => undefined);
    }
  }

  private async loadArchiveMarker(name: string): Promise<void> {
    this.seenArchiveMarkers.add(name);
    let text: string;
    try {
      text = await fs.readFile(path.join(this.directory, name), "utf8");
    } catch {
      this.transientArchiveReadFailures.add(name);
      return;
    }
    this.applyArchiveState(name, text);
  }

  private async loadFile(
    name: string,
    enrolled: ReadonlySet<string>,
  ): Promise<void> {
    if (!name.endsWith(".json")) return;
    const file = path.join(this.directory, name);
    if (name.startsWith(REVOKED_ROUTE_PREFIX)) {
      await fs.rm(file, { force: true }).catch(() => undefined);
      return;
    }
    if (name.startsWith(ARCHIVED_THREAD_PREFIX)) return;
    if (
      name.startsWith(THREAD_ROUTE_PREFIX) ||
      name.startsWith(LEGACY_THREAD_ROUTE_PREFIX)
    ) {
      const record = await readRecord(file, routeSchema);
      const archived =
        record === null ? false : await this.isArchived(record.threadId);
      if (
        record !== null &&
        archived &&
        this.hasTransientArchiveReadFailure(record.threadId)
      ) return;
      if (
        record !== null &&
        !archived &&
        this.fileEpoch(name) === this.archiveEpoch(record.threadId) &&
        (await this.isLive(record, enrolled))
      ) {
        this.routes.set(this.key(record, record.hostTokenDigest), record);
        this.tokenIndex.set(digest(record.token), record);
      } else await fs.rm(file, { force: true });
    } else if (
      name.startsWith(NESTED_ROUTE_PREFIX) ||
      name.startsWith(LEGACY_NESTED_ROUTE_PREFIX)
    ) {
      const record = await readRecord(file, nestedRouteSchema);
      const archived =
        record === null ? false : await this.isArchived(record.threadId);
      if (
        record !== null &&
        archived &&
        this.hasTransientArchiveReadFailure(record.threadId)
      ) return;
      if (
        record !== null &&
        !archived &&
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
      let names: string[] = [];
      let directoryReadFailed = false;
      try {
        names = await fs.readdir(this.directory);
      } catch {
        directoryReadFailed = true;
      }
      const shouldPersist =
        directoryReadFailed ||
        this.archiveMarkerNames(threadId).some((name) =>
          this.seenArchiveMarkers.has(name),
        ) ||
        [...this.routes.values()].some((record) => record.threadId === threadId) ||
        [...this.nestedRoutes.values()].some((record) => record.threadId === threadId) ||
        this.hasCredentialFile(threadId, names);
      let markerError: unknown;
      if (shouldPersist) {
        try {
          await this.persist(this.archivedFile(threadId), {
            threadId,
            epoch: nextEpoch,
            archived: true,
          });
          this.seenArchiveMarkers.add(this.archivedName(threadId));
          this.clearMarkerFailures(threadId);
          this.archiveDurabilityFailures.delete(threadId);
        } catch (error) {
          try {
            await this.persist(this.archiveFallbackFile(threadId), {
              threadId,
              epoch: nextEpoch,
              archived: true,
            });
            this.seenArchiveMarkers.add(this.archiveFallbackName(threadId));
            this.clearMarkerFailures(threadId);
            this.archiveDurabilityFailures.delete(threadId);
          } catch {
            markerError = error;
            this.archiveDurabilityFailures.add(threadId);
          }
        }
      }
      for (const [key, record] of this.routes) {
        if (record.threadId !== threadId) continue;
        this.routes.delete(key);
        this.tokenIndex.delete(digest(record.token));
        await this.removeProviderFiles(
          record,
          Math.max(0, nextEpoch - 1),
        ).catch(() => undefined);
      }
      for (const [key, record] of this.nestedRoutes) {
        if (record.threadId !== threadId) continue;
        this.nestedRoutes.delete(key);
        this.nestedTokenIndex.delete(digest(record.token));
        await this.removeNestedFiles(
          record,
          Math.max(0, nextEpoch - 1),
        ).catch(() => undefined);
      }
      await this.quarantineUnreadableLegacyFiles(threadId, names).catch(() => undefined);
      if (markerError !== undefined) throw markerError;
    });
  }

  async sweepThreads(
    lookup: ThreadLookup,
    signal?: AbortSignal,
  ): Promise<ThreadSweepResult> {
    const threadIds = new Set<string>();
    for (const record of this.routes.values()) threadIds.add(record.threadId);
    for (const record of this.nestedRoutes.values())
      threadIds.add(record.threadId);
    const result: ThreadSweepResult = {
      checked: threadIds.size,
      revoked: 0,
      failed: 0,
    };
    for (const threadId of threadIds) {
      if (signal?.aborted === true) {
        result.failed += 1;
        continue;
      }
      const version = this.archiveVersion(threadId);
      try {
        if ((await untilAborted(lookup(threadId, signal), signal)) === "live")
          continue;
        if (await this.removeThreadIfVersion(threadId, version))
          result.revoked += 1;
      } catch {
        result.failed += 1;
      }
    }
    return result;
  }

  async removeThreadIfVersion(
    threadId: string,
    expectedVersion: number,
  ): Promise<boolean> {
    if (this.archiveVersion(threadId) !== expectedVersion)
      return this.archivedThreads.has(threadId);
    await this.removeThread(threadId);
    return true;
  }

  archiveVersion(threadId: string): number {
    return this.archiveVersions.get(threadId) ?? 0;
  }

  async restoreThread(threadId: string, expectedVersion: number): Promise<void> {
    await this.serialize(async () => {
      if (this.archiveVersion(threadId) !== expectedVersion) return;
      if (this.activeArchiveMarkers.has(threadId)) return;
      if (
        this.archiveEpoch(threadId) === 0 &&
        !this.archivedThreads.has(threadId) &&
        !this.hasMarkerFailure(threadId) &&
        !this.archiveDurabilityFailures.has(threadId)
      ) return;
      const epoch = (await this.maxFileEpoch(threadId)) + 1;
      await this.persist(this.archivedFile(threadId), {
        threadId,
        epoch,
        archived: false,
      });
      if (this.seenArchiveMarkers.has(this.archiveFallbackName(threadId))) {
        await this.persist(this.archiveFallbackFile(threadId), {
          threadId,
          epoch,
          archived: false,
        });
      }
      this.archivedThreads.delete(threadId);
      this.activeArchiveMarkers.add(threadId);
      this.archiveEpochs.set(threadId, epoch);
      this.seenArchiveMarkers.add(this.archivedName(threadId));
      if (this.seenArchiveMarkers.has(this.archiveFallbackName(threadId)))
        this.seenArchiveMarkers.add(this.archiveFallbackName(threadId));
      this.clearMarkerFailures(threadId);
      this.archiveDurabilityFailures.delete(threadId);
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
      await this.removeProviderFiles(record, this.archiveEpoch(record.threadId)).catch(() => undefined);
      this.routes.delete(key);
      this.tokenIndex.delete(digest(record.token));
    }
    for (const [key, record] of this.nestedRoutes) {
      if (!stale(record) || (await this.isGenerationLive(record))) continue;
      await this.removeNestedFiles(record, this.archiveEpoch(record.threadId)).catch(() => undefined);
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

  private applyArchiveState(name: string, text: string): boolean {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.corruptArchiveMarkers.add(name);
      return true;
    }
    const parsed = archiveStateSchema.safeParse(value);
    if (
      !parsed.success ||
      !this.archiveMarkerNames(parsed.data.threadId).includes(name)
    ) {
      this.corruptArchiveMarkers.add(name);
      return true;
    }
    this.corruptArchiveMarkers.delete(name);
    this.transientArchiveReadFailures.delete(name);
    const threadId = parsed.data.threadId;
    const currentEpoch = this.archiveEpoch(threadId);
    const currentArchived = this.archivedThreads.has(threadId);
    if (parsed.data.epoch < currentEpoch) return currentArchived;
    if (parsed.data.epoch === currentEpoch && currentArchived) return true;
    this.archiveEpochs.set(threadId, parsed.data.epoch);
    if (parsed.data.archived) {
      this.archivedThreads.add(threadId);
      this.activeArchiveMarkers.delete(threadId);
    } else {
      this.archivedThreads.delete(threadId);
      this.activeArchiveMarkers.add(threadId);
    }
    return parsed.data.archived;
  }

  private hasCredentialFile(threadId: string, names: readonly string[]): boolean {
    for (const name of names) {
      if (
        !name.startsWith(THREAD_ROUTE_PREFIX) &&
        !name.startsWith(LEGACY_THREAD_ROUTE_PREFIX) &&
        !name.startsWith(NESTED_ROUTE_PREFIX) &&
        !name.startsWith(LEGACY_NESTED_ROUTE_PREFIX)
      ) continue;
      if (name.includes(threadId)) return true;
    }
    return false;
  }

  private async maxFileEpoch(threadId: string): Promise<number> {
    let epoch = this.archiveEpoch(threadId);
    const names = await fs.readdir(this.directory);
    for (const name of names) {
      if (
        !name.startsWith(THREAD_ROUTE_PREFIX) &&
        !name.startsWith(LEGACY_THREAD_ROUTE_PREFIX) &&
        !name.startsWith(NESTED_ROUTE_PREFIX) &&
        !name.startsWith(LEGACY_NESTED_ROUTE_PREFIX)
      ) continue;
      if (name.includes(threadId))
        epoch = Math.max(epoch, this.fileEpoch(name));
    }
    return epoch;
  }

  private async removeNestedFiles(
    route: NestedRoute & { hostTokenDigest: string },
    epoch: number,
  ): Promise<void> {
    await Promise.all([
      this.removeCredentialFile(this.nestedFileAtEpoch(route, epoch)),
      this.removeCredentialFile(this.legacyNestedFile(route)),
    ]);
  }

  private legacyNestedFile(route: NestedRoute & { hostTokenDigest: string }): string {
    return path.join(
      this.directory,
      `${LEGACY_NESTED_ROUTE_PREFIX}${this.nestedKey(route, route.hostTokenDigest)}.json`,
    );
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

  private async removeProviderFiles(
    route: ThreadRoute & { hostTokenDigest: string },
    epoch: number,
  ): Promise<void> {
    await Promise.all([
      this.removeCredentialFile(this.fileAtEpoch(route, epoch)),
      this.removeCredentialFile(this.legacyFile(route)),
    ]);
  }

  private async removeCredentialFile(file: string): Promise<void> {
    try {
      await fs.rm(file, { force: true });
    } catch {
      await fs.rename(
        file,
        path.join(this.directory, `revoked-route-${randomUUID()}.json`),
      );
    }
  }

  private async quarantineUnreadableLegacyFiles(
    threadId: string,
    names: readonly string[],
  ): Promise<void> {
    const hostIds = (await this.hosts.list()).map((host) => host.hostId);
    for (const name of names) {
      if (
        !name.startsWith(LEGACY_THREAD_ROUTE_PREFIX) &&
        !name.startsWith(LEGACY_NESTED_ROUTE_PREFIX)
      ) continue;
      const file = path.join(this.directory, name);
      for (const hostId of hostIds) {
        if (name.startsWith(LEGACY_NESTED_ROUTE_PREFIX)) continue;
        for (const provider of ["claude", "codex"] as const) {
          const prefix = `${LEGACY_THREAD_ROUTE_PREFIX}${hostId}-${provider}-`;
          if (!name.startsWith(prefix)) continue;
          const routeKey = name.slice(prefix.length);
          const suffix = /-(?:automatic|[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})-[a-f0-9]{64}\.json$/u.exec(
            routeKey,
          );
          if (suffix === null || routeKey.slice(0, suffix.index) !== threadId)
            continue;
          const candidateCount = hostIds.filter((candidateHostId) => {
            const candidatePrefix = `${LEGACY_THREAD_ROUTE_PREFIX}${candidateHostId}-${provider}-`;
            if (!name.startsWith(candidatePrefix)) return false;
            const candidateKey = name.slice(candidatePrefix.length);
            const candidateSuffix = /-(?:automatic|[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})-[a-f0-9]{64}\.json$/u.exec(
              candidateKey,
            );
            return candidateSuffix !== null;
          }).length;
          if (candidateCount === 1) await this.quarantineFile(file);
          break;
        }
      }
      const nestedMatches = hostIds.flatMap((candidateHostId) => {
        const prefix = `${LEGACY_NESTED_ROUTE_PREFIX}${candidateHostId}-`;
        if (!name.startsWith(prefix)) return [];
        const candidate = /^(.+)-([a-f0-9]{64})\.json$/u.exec(
          name.slice(prefix.length),
        );
        return candidate === null
          ? []
          : [{ threadId: candidate[1] }];
      });
      if (
        name.startsWith(LEGACY_NESTED_ROUTE_PREFIX) &&
        nestedMatches.length === 1 &&
        nestedMatches[0]?.threadId === threadId
      ) await this.quarantineFile(file);
    }
  }

  private async quarantineFile(file: string): Promise<void> {
    try {
      await fs.rename(
        file,
        path.join(this.directory, `revoked-route-${randomUUID()}.json`),
      );
    } catch {
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
  }

  private legacyFile(
    route: ThreadRoute & { hostTokenDigest: string },
  ): string {
    return path.join(
      this.directory,
      `${LEGACY_THREAD_ROUTE_PREFIX}${this.key(route, route.hostTokenDigest)}.json`,
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

  private archiveFallbackFile(threadId: string): string {
    return path.join(this.directory, this.archiveFallbackName(threadId));
  }

  private archivedName(threadId: string): string {
    return `${ARCHIVED_THREAD_PREFIX}${digest(threadId)}.json`;
  }

  private archiveFallbackName(threadId: string): string {
    return `${ARCHIVE_FALLBACK_PREFIX}${digest(threadId)}.json`;
  }

  private archiveMarkerNames(threadId: string): string[] {
    const threadDigest = digest(threadId);
    return [
      `${ARCHIVED_THREAD_PREFIX}${threadDigest}.json`,
      `${ARCHIVE_FALLBACK_PREFIX}${threadDigest}.json`,
    ];
  }

  private hasMarkerFailure(threadId: string): boolean {
    return this.archiveMarkerNames(threadId).some(
      (name) =>
        this.corruptArchiveMarkers.has(name) ||
        this.transientArchiveReadFailures.has(name),
    );
  }

  private hasTransientArchiveReadFailure(threadId: string): boolean {
    return this.archiveMarkerNames(threadId).some((name) =>
      this.transientArchiveReadFailures.has(name),
    );
  }

  private clearMarkerFailures(threadId: string): void {
    for (const name of this.archiveMarkerNames(threadId)) {
      this.transientArchiveReadFailures.delete(name);
      this.corruptArchiveMarkers.delete(name);
    }
  }

  private archiveEpoch(threadId: string): number {
    return this.archiveEpochs.get(threadId) ?? 0;
  }

  private fileEpoch(name: string): number {
    const match = /-v([0-9]+)\.json$/u.exec(name);
    return match === null ? 0 : Number(match[1]);
  }

  private async isArchived(threadId: string): Promise<boolean> {
    const names = this.archiveMarkerNames(threadId);
    if (names.some((name) => this.corruptArchiveMarkers.has(name))) return true;
    if (names.some((name) => this.transientArchiveReadFailures.has(name))) {
      for (const name of names) {
        if (!this.transientArchiveReadFailures.has(name)) continue;
        try {
          const text = await fs.readFile(path.join(this.directory, name), "utf8");
          this.seenArchiveMarkers.add(name);
          this.applyArchiveState(name, text);
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") {
            this.transientArchiveReadFailures.delete(name);
            continue;
          }
          this.transientArchiveReadFailures.add(name);
          return true;
        }
      }
    }
    if (this.archivedThreads.has(threadId)) return true;
    if (this.activeArchiveMarkers.has(threadId)) return false;
    if (
      this.archiveMarkersLoaded &&
      !names.some((name) => this.seenArchiveMarkers.has(name))
    ) return false;
    if (this.archiveMarkersLoaded && !this.hasMarkerFailure(threadId)) return false;
    return this.hasMarkerFailure(threadId);
  }
}

function untilAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
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
