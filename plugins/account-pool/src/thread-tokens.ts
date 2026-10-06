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

const identifierSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

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
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly hosts: HubTokenStore,
  ) {}

  async initialize(hostIds: readonly string[]): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const enrolled = new Set(hostIds);
    for (const name of await fs.readdir(this.directory)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.directory, name);
      if (name.startsWith(THREAD_ROUTE_PREFIX)) {
        const record = await readRecord(file, routeSchema);
        if (record !== null && (await this.isLive(record, enrolled))) {
          this.routes.set(this.key(record, record.hostTokenDigest), record);
          this.tokenIndex.set(digest(record.token), record);
        } else await fs.rm(file, { force: true });
      } else if (name.startsWith(NESTED_ROUTE_PREFIX)) {
        const record = await readRecord(file, nestedRouteSchema);
        if (record !== null && (await this.isLive(record, enrolled))) {
          this.nestedRoutes.set(
            this.nestedKey(record, record.hostTokenDigest),
            record,
          );
          this.nestedTokenIndex.set(digest(record.token), record);
        } else await fs.rm(file, { force: true });
      }
    }
  }

  async forThread(route: ThreadRoute, hostToken: string): Promise<string> {
    const parsed = routeSchema
      .omit({ token: true, hostTokenDigest: true })
      .parse(route);
    const hostTokenDigest = digest(hostToken);
    return this.serialize(async () => {
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
    await this.serialize(async () => {
      for (const [key, record] of this.routes) {
        if (record.threadId !== threadId) continue;
        await fs.rm(this.file(record), { force: true });
        this.routes.delete(key);
        this.tokenIndex.delete(digest(record.token));
      }
      for (const [key, record] of this.nestedRoutes) {
        if (record.threadId !== threadId) continue;
        await fs.rm(this.nestedFile(record), { force: true });
        this.nestedRoutes.delete(key);
        this.nestedTokenIndex.delete(digest(record.token));
      }
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
      await fs.rm(this.file(record), { force: true });
      this.routes.delete(key);
      this.tokenIndex.delete(digest(record.token));
    }
    for (const [key, record] of this.nestedRoutes) {
      if (!stale(record) || (await this.isGenerationLive(record))) continue;
      await fs.rm(this.nestedFile(record), { force: true });
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
    return path.join(
      this.directory,
      `${THREAD_ROUTE_PREFIX}${this.key(route, route.hostTokenDigest)}.json`,
    );
  }

  private nestedKey(route: NestedRoute, hostTokenDigest: string): string {
    return `${route.hostId}-${route.threadId}-${hostTokenDigest}`;
  }

  private nestedFile(route: NestedRoute & { hostTokenDigest: string }): string {
    return path.join(
      this.directory,
      `${NESTED_ROUTE_PREFIX}${this.nestedKey(route, route.hostTokenDigest)}.json`,
    );
  }
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
  try {
    const parsed = schema.safeParse(
      JSON.parse(await fs.readFile(file, "utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
