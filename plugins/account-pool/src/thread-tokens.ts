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

const routeSchema = z
  .object({
    hostId: z.string().regex(/^[A-Za-z0-9_-]+$/u),
    threadId: z.string().regex(/^[A-Za-z0-9_-]+$/u),
    provider: providerSchema,
    accountId: z.string().uuid().nullable(),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    hostTokenDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type ThreadRoute = Omit<
  z.infer<typeof routeSchema>,
  "token" | "hostTokenDigest"
>;

export class ThreadTokenStore {
  private readonly routes = new Map<string, z.infer<typeof routeSchema>>();
  private readonly tokenIndex = new Map<string, z.infer<typeof routeSchema>>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly hosts: HubTokenStore,
  ) {}

  async initialize(hostIds: readonly string[]): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    const hosts = new Set(hostIds);
    for (const file of await fs.readdir(this.directory)) {
      if (!file.startsWith("thread-route-") || !file.endsWith(".json"))
        continue;
      const record = routeSchema.parse(
        JSON.parse(await fs.readFile(path.join(this.directory, file), "utf8")),
      );
      if (hosts.has(record.hostId)) {
        this.routes.set(this.key(record, record.hostTokenDigest), record);
        this.tokenIndex.set(this.digest(record.token), record);
      } else await fs.rm(path.join(this.directory, file));
    }
  }

  async forThread(route: ThreadRoute, hostToken: string): Promise<string> {
    const parsed = routeSchema
      .omit({ token: true, hostTokenDigest: true })
      .parse(route);
    const hostTokenDigest = this.digest(hostToken);
    const result = this.tail.then(async () => {
      const key = this.key(parsed, hostTokenDigest);
      const existing = this.routes.get(key);
      if (existing !== undefined) return existing.token;
      const record = {
        ...parsed,
        hostTokenDigest,
        token: randomBytes(32).toString("base64url"),
      };
      const destination = this.file(record);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await fs.rename(temporary, destination);
      this.routes.set(key, record);
      this.tokenIndex.set(this.digest(record.token), record);
      return record.token;
    });
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async authenticate(
    token: string | null,
    provider?: ThreadRoute["provider"],
  ): Promise<ThreadRoute | null> {
    if (token === null || token.length !== 43) return null;
    const presented = Buffer.from(token);
    const record = this.tokenIndex.get(this.digest(token));
    if (
      record === undefined ||
      !timingSafeEqual(presented, Buffer.from(record.token))
    )
      return null;
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

  async removeThread(threadId: string): Promise<void> {
    const result = this.tail.then(async () => {
      for (const [key, record] of this.routes) {
        if (record.threadId !== threadId) continue;
        await fs.rm(this.file(record), { force: true });
        this.routes.delete(key);
        this.tokenIndex.delete(this.digest(record.token));
      }
    });
    this.tail = result.catch(() => {});
    await result;
  }

  private key(route: ThreadRoute, hostTokenDigest: string): string {
    return `${route.hostId}-${route.provider}-${route.threadId}-${route.accountId ?? "automatic"}-${hostTokenDigest}`;
  }

  private file(route: ThreadRoute & { hostTokenDigest: string }): string {
    return path.join(
      this.directory,
      `thread-route-${this.key(route, route.hostTokenDigest)}.json`,
    );
  }

  private digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}
