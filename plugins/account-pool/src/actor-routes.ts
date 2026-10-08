import { z } from "zod";
import { providerSchema, type PoolProvider } from "./contracts.js";
import {
  ActorRouteExistsError,
  actorGenerationSchema,
  actorIdSchema,
  type ActorRoute,
  type ActorRouteListing,
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
    generation: actorGenerationSchema.optional(),
  })
  .strict();

export interface LaunchEnvEntry {
  name: string;
  value: string;
}

export interface IssuedActorRoute {
  token: string;
  generation: string;
  route: ActorRoute;
  hubUrl: string;
  launchEnv: LaunchEnvEntry[];
}

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
  launchEnv: (provider: PoolProvider) => Promise<LaunchEnvEntry[]>;
  hubUrl: () => string;
  recordRouted: (
    threadId: string,
    hostId: string,
    provider: PoolProvider,
  ) => Promise<void>;
  lastRoutedAt: (route: ActorRoute) => Promise<number | null>;
  forgetRouted: (actorId: string, threadId: string | null) => Promise<void>;
  onIssued: (route: ActorRoute, rotated: boolean) => void;
  onRevoked: (actorId: string, threadId: string | null, count: number) => void;
}

export class ActorRouteError extends Error {}

export class ActorRouteIssuer {
  constructor(private readonly deps: ActorRouteDeps) {}

  async issue(
    raw: z.input<typeof actorRouteIssueInputSchema>,
  ): Promise<IssuedActorRoute> {
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
    let minted: { token: string; generation: string };
    try {
      minted = await this.deps.threadTokens.forActor(route, hostToken, {
        rotate: input.rotate,
        exclusive: !input.rotate,
      });
    } catch (error) {
      if (error instanceof ActorRouteExistsError)
        throw new ActorRouteError(
          `Actor ${input.actorId} already has a route on thread ${input.threadId}; pass --rotate to replace it.`,
        );
      throw error;
    }
    const revokeMinted = () =>
      this.deps.threadTokens.revokeActor({
        actorId: input.actorId,
        threadId: input.threadId,
        generation: minted.generation,
      });
    let refusal: string | null;
    try {
      refusal = await this.recheck(input, hostId);
    } catch (error) {
      await revokeMinted();
      throw error;
    }
    if (refusal !== null) {
      await revokeMinted();
      throw new ActorRouteError(refusal);
    }
    const launchEnv = await this.deps.launchEnv(input.provider);
    await this.deps.recordRouted(input.threadId, hostId, input.provider);
    this.deps.onIssued(route, input.rotate);
    return {
      token: minted.token,
      generation: minted.generation,
      route,
      hubUrl: this.deps.hubUrl(),
      launchEnv,
    };
  }

  private async recheck(
    input: z.output<typeof actorRouteIssueInputSchema>,
    hostId: string,
  ): Promise<string | null> {
    const after = await this.deps.getThread(input.threadId);
    if (after === null || after.archived)
      return `Thread ${input.threadId} was archived while the route was issued.`;
    if (after.hostId !== hostId)
      return `Thread ${input.threadId} moved to another machine while the route was issued.`;
    if (await this.deps.isBypassed(input.threadId))
      return `Pooled routing was bypassed for thread ${input.threadId} while the route was issued.`;
    if (!(await this.deps.canServe(input.provider)))
      return `Pooled ${input.provider} routing stopped being servable while the route was issued.`;
    return null;
  }

  async revoke(
    raw: z.input<typeof actorRouteRevokeInputSchema>,
  ): Promise<{ revoked: number }> {
    const input = actorRouteRevokeInputSchema.parse(raw);
    const revoked = await this.deps.threadTokens.revokeActor(input);
    if (revoked > 0 || input.generation === undefined)
      await this.deps.forgetRouted(input.actorId, input.threadId ?? null);
    this.deps.onRevoked(input.actorId, input.threadId ?? null, revoked);
    return { revoked };
  }

  async list(): Promise<Array<ActorRouteListing & { lastRoutedAt: number | null }>> {
    return Promise.all(
      this.deps.threadTokens.listActors().map(async (route) => ({
        ...route,
        lastRoutedAt: await this.deps.lastRoutedAt(route),
      })),
    );
  }
}
