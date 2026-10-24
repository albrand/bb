import { createNodeBbSdk, type BbSdk } from "@bb/sdk/node";
import type { Dispatcher } from "undici";

type CliRequestInit = RequestInit & { dispatcher?: Dispatcher };

export const ACTOR_THREAD_HEADER = "x-bb-actor-thread-id";

export function cliFetch(
  input: RequestInfo | URL,
  init?: CliRequestInit,
): Promise<Response> {
  return fetch(input, init);
}

export function withActorThread(
  fetchFn: typeof cliFetch,
  env: NodeJS.ProcessEnv,
): typeof cliFetch {
  const threadId = env.BB_THREAD_ID?.trim();
  if (threadId === undefined || threadId === "") return fetchFn;
  return (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set(ACTOR_THREAD_HEADER, threadId);
    return fetchFn(input, { ...init, headers });
  };
}

export function createCliBbSdk(baseUrl: string): BbSdk {
  return createNodeBbSdk({
    baseUrl,
    fetch: withActorThread(cliFetch, process.env),
  });
}
