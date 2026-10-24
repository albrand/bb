import type { EnvironmentReleaseActor } from "@bb/db";

export const RELEASE_ACTOR_THREAD_HEADER = "x-bb-actor-thread-id";

const ACTOR_THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function parseReleaseActorThreadId(
  headerValue: string | undefined,
): string | null {
  if (headerValue === undefined) return null;
  const trimmed = headerValue.trim();
  return ACTOR_THREAD_ID_PATTERN.test(trimmed) ? trimmed : null;
}

export function releaseActorFor(
  actorThreadId: string | null,
  threadId: string,
): EnvironmentReleaseActor {
  if (actorThreadId === null) return { kind: "user", threadId: null };
  return {
    kind: actorThreadId === threadId ? "self" : "coordinator",
    threadId: actorThreadId,
  };
}
