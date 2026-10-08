import { z } from "zod";
import { providerSchema, type PoolProvider } from "./contracts.js";
import {
  actorIdSchema,
  type ActorRoute,
  type ThreadTokenStore,
} from "./thread-tokens.js";
import type { HubTokenStore } from "./store.js";

const threadIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);

export const actorRouteIssueInputSchema = z
  .object({
    threadId: threadIdSchema,
    actorId: actorIdSchema,
    provider: providerSchema.default("claude"),
    rotate: z.boolean().default(false),
  })
  .strict();

export const actorRouteRevokeInputSchema = z
  .object({
    actorId: actorIdSchema,
    threadId: threadIdSchema.optional(),
  })
  .strict();

export interface ActorRouteThread {
  hostId: string | null;
  archived: boolean;
}

export interface ActorRouteDeps {
  threadTokens: ThreadTokenStore;
  hubTokens: HubTokenStore;
  getThread: (threadId: string) => Promise<ActorRouteThread | null>;
  enrolledHostIds: () => Promise<string[]>;
  isBypassed: (threadId: string) => Promise<boolean>;
  resolveAccountId: (
    threadId: string,
    provider: PoolProvider,
  ) => Promise<string | null>;
  canServe: (provider: PoolProvider) => Promise<boolean>;
  hubUrl: () => string;
  recordRouted: (
    threadId: string,
    hostId: string,
    provider: PoolProvider,
  ) => Promise<void>;
  onIssued: (route: ActorRoute, rotated: boolean) => void;
  onRevoked: (actorId: string, threadId: string | null, count: number) => void;
}

export class ActorRouteError extends Error {}

export class ActorRouteIssuer {
  constructor(private readonly deps: ActorRouteDeps) {}

  async issue(
    raw: z.input<typeof actorRouteIssueInputSchema>,
  ): Promise<{ token: string; route: ActorRoute; hubUrl: string }> {
    const input = actorRouteIssueInputSchema.parse(raw);
    const thread = await this.deps.getThread(input.threadId);
    if (thread === null)
      throw new ActorRouteError(`Thread ${input.threadId} does not exist.`);
    if (thread.archived)
      throw new ActorRouteError(
        `Thread ${input.threadId} is archived; no route can be issued for it.`,
      );
    if (thread.hostId === null)
      throw new ActorRouteError(
        `Thread ${input.threadId} has no environment, so its machine cannot be determined.`,
      );
    const hostId = thread.hostId;
    if (!(await this.deps.enrolledHostIds()).includes(hostId))
      throw new ActorRouteError(
        `Thread ${input.threadId} runs on a machine that is not enrolled in the Account Pooler.`,
      );
    if (await this.deps.isBypassed(input.threadId))
      throw new ActorRouteError(
        `Pooled routing is bypassed for thread ${input.threadId}.`,
      );
    if (!(await this.deps.canServe(input.provider)))
      throw new ActorRouteError(
        `Pooled ${input.provider} routing is disabled or has no usable account.`,
      );
    const route: ActorRoute = {
      hostId,
      threadId: input.threadId,
      actorId: input.actorId,
      provider: input.provider,
      accountId: await this.deps.resolveAccountId(
        input.threadId,
        input.provider,
      ),
    };
    const hostToken = await this.deps.hubTokens.forHost(hostId);
    const token = await this.deps.threadTokens.forActor(route, hostToken, {
      rotate: input.rotate,
    });
    const after = await this.deps.getThread(input.threadId);
    if (after === null || after.archived) {
      await this.deps.threadTokens.revokeActor({
        actorId: input.actorId,
        threadId: input.threadId,
      });
      throw new ActorRouteError(
        `Thread ${input.threadId} was archived while the route was issued.`,
      );
    }
    await this.deps.recordRouted(input.threadId, hostId, input.provider);
    this.deps.onIssued(route, input.rotate);
    return { token, route, hubUrl: this.deps.hubUrl() };
  }

  async revoke(
    raw: z.input<typeof actorRouteRevokeInputSchema>,
  ): Promise<{ revoked: number }> {
    const input = actorRouteRevokeInputSchema.parse(raw);
    const revoked = await this.deps.threadTokens.revokeActor(input);
    this.deps.onRevoked(input.actorId, input.threadId ?? null, revoked);
    return { revoked };
  }

  list(): ActorRoute[] {
    return this.deps.threadTokens.listActors();
  }
}
