import {
  AI_TEXT_TASKS,
  aiServiceStatusSchema,
  type AiServiceStatus,
  type AiTask,
} from "@bb/domain";
import type { NormalizedPluginAiService } from "@get-bb/plugin-sdk/internal/host-policy";
import { aiServiceAlreadyRegisteredMessage } from "@get-bb/plugin-sdk/internal/host-policy";

const STATUS_TTL_MS = 10_000;
const STATUS_ANSWER_MS = 2_000;
const STATUS_SETTLE_MS = 30_000;
const NOT_RESPONDING: AiServiceStatus = {
  ready: false,
  message: "Not responding",
};
const CHECKING: AiServiceStatus = { ready: false, message: "Checking" };

export interface AiServiceRegistration extends NormalizedPluginAiService {
  pluginId: string;
  builtin: boolean;
}

export interface AiServiceKey {
  pluginId: string;
  serviceId: string;
}

interface CachedStatus {
  status: AiServiceStatus;
  checkedAt: number;
  startedAt: number;
}

interface StatusProbe {
  startedAt: number;
  request: Promise<AiServiceStatus>;
}

export interface AiServiceRegistry {
  register(registration: AiServiceRegistration): { dispose(): void };
  get(key: AiServiceKey): AiServiceRegistration | null;
  list(): AiServiceRegistration[];
  peekStatus(key: AiServiceKey): AiServiceStatus | null;
  status(key: AiServiceKey): Promise<AiServiceStatus>;
  taskStatus(key: AiServiceKey): Promise<AiServiceStatus>;
  settledStatus(key: AiServiceKey, maxWaitMs: number): Promise<AiServiceStatus>;
}

interface CreateAiServiceRegistryArgs {
  onStatusChange?: () => void;
  now?: () => number;
}

export function aiServiceTasks(service: NormalizedPluginAiService): AiTask[] {
  return [
    ...(service.complete === null ? [] : AI_TEXT_TASKS),
    ...(service.transcribe === null ? [] : (["voice"] as const)),
  ];
}

export function aiServiceSupportsTask(
  service: NormalizedPluginAiService,
  task: AiTask,
): boolean {
  return task === "voice"
    ? service.transcribe !== null
    : service.complete !== null;
}

export function aiServiceKey(service: AiServiceRegistration): AiServiceKey {
  return { pluginId: service.pluginId, serviceId: service.id };
}

function mapKey(key: AiServiceKey): string {
  return `${key.pluginId}/${key.serviceId}`;
}

async function readStatus(
  service: AiServiceRegistration,
): Promise<AiServiceStatus> {
  if (service.status === null) return { ready: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      service.status(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), STATUS_SETTLE_MS);
        timer.unref();
      }),
    ]);
    if (raw === null) return NOT_RESPONDING;
    const parsed = aiServiceStatusSchema.safeParse(raw);
    return parsed.success
      ? parsed.data
      : { ready: false, message: "Reported an invalid status" };
  } catch (error) {
    const message = error instanceof Error ? error.message.trim() : "";
    return {
      ready: false,
      message: message.length > 0 ? message : "Status check failed",
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createAiServiceRegistry(
  args: CreateAiServiceRegistryArgs = {},
): AiServiceRegistry {
  const now = args.now ?? Date.now;
  const services = new Map<string, AiServiceRegistration>();
  const statuses = new Map<AiServiceRegistration, CachedStatus>();
  const inFlight = new Map<AiServiceRegistration, StatusProbe>();
  const taskTimeouts = new Map<AiServiceRegistration, number>();

  function refresh(service: AiServiceRegistration): Promise<AiServiceStatus> {
    return probeFor(service).request;
  }

  function probeFor(service: AiServiceRegistration): StatusProbe {
    const pending = inFlight.get(service);
    if (pending !== undefined && now() - pending.startedAt < STATUS_ANSWER_MS) {
      return pending;
    }
    const startedAt = now();
    let answered = false;
    const routingTimeout = setTimeout(() => {
      if (answered) return;
      if (services.get(mapKey(aiServiceKey(service))) !== service) return;
      taskTimeouts.set(service, now());
    }, STATUS_ANSWER_MS);
    routingTimeout.unref();
    const probe: StatusProbe = {
      startedAt,
      request: readStatus(service)
        .then((status) => {
          const cached = statuses.get(service);
          if (cached !== undefined && cached.startedAt > startedAt) {
            return status;
          }
          if (services.get(mapKey(aiServiceKey(service))) === service) {
            statuses.set(service, { status, checkedAt: now(), startedAt });
          }
          if (cached === undefined || cached.status.ready !== status.ready) {
            args.onStatusChange?.();
          }
          return status;
        })
        .finally(() => {
          answered = true;
          clearTimeout(routingTimeout);
          if (inFlight.get(service) === probe) inFlight.delete(service);
        }),
    };
    inFlight.set(service, probe);
    return probe;
  }

  function supersededNegative(
    service: AiServiceRegistration,
    cached: CachedStatus,
  ): boolean {
    const pending = inFlight.get(service);
    return (
      !cached.status.ready &&
      pending !== undefined &&
      pending.startedAt > cached.startedAt
    );
  }

  function freshStatus(
    service: AiServiceRegistration,
  ): AiServiceStatus | undefined {
    const cached = statuses.get(service);
    if (cached === undefined || now() - cached.checkedAt > STATUS_TTL_MS) {
      return undefined;
    }
    if (supersededNegative(service, cached)) return undefined;
    return cached.status;
  }

  function statusAfterWait(service: AiServiceRegistration): AiServiceStatus {
    const cached = statuses.get(service);
    if (cached === undefined) return CHECKING;
    if (supersededNegative(service, cached)) return NOT_RESPONDING;
    return cached.status;
  }

  function answerWithin(
    probe: Promise<AiServiceStatus>,
    waitMs: number,
    fallback: () => AiServiceStatus,
  ): Promise<AiServiceStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      probe,
      new Promise<AiServiceStatus>((resolve) => {
        timer = setTimeout(() => resolve(fallback()), waitMs);
        timer.unref();
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  return {
    register(registration) {
      const key = mapKey(aiServiceKey(registration));
      if (services.has(key)) {
        throw new Error(aiServiceAlreadyRegisteredMessage(registration.id));
      }
      services.set(key, registration);
      args.onStatusChange?.();
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          if (services.get(key) === registration) {
            services.delete(key);
            statuses.delete(registration);
            taskTimeouts.delete(registration);
            args.onStatusChange?.();
          }
        },
      };
    },
    get(key) {
      return services.get(mapKey(key)) ?? null;
    },
    list() {
      return [...services.values()];
    },
    peekStatus(key) {
      const service = services.get(mapKey(key));
      if (service === undefined) return null;
      const cached = statuses.get(service);
      if (cached === undefined || now() - cached.checkedAt > STATUS_TTL_MS) {
        void refresh(service);
      }
      return cached?.status ?? null;
    },
    async status(key) {
      const service = services.get(mapKey(key));
      if (service === undefined) {
        return { ready: false, message: "Plugin not loaded" };
      }
      const fresh = freshStatus(service);
      if (fresh !== undefined) return fresh;
      return answerWithin(refresh(service), STATUS_ANSWER_MS, () =>
        statusAfterWait(service),
      );
    },
    async taskStatus(key) {
      const service = services.get(mapKey(key));
      if (service === undefined) {
        return { ready: false, message: "Plugin not loaded" };
      }
      const timedOutAt = taskTimeouts.get(service);
      if (timedOutAt !== undefined && now() - timedOutAt <= STATUS_TTL_MS) {
        return NOT_RESPONDING;
      }
      const fresh = freshStatus(service);
      if (fresh !== undefined) return fresh;
      const probe = probeFor(service);
      return answerWithin(
        probe.request,
        Math.max(0, probe.startedAt + STATUS_ANSWER_MS - now()),
        () => NOT_RESPONDING,
      );
    },
    async settledStatus(key, maxWaitMs) {
      const service = services.get(mapKey(key));
      if (service === undefined) {
        return { ready: false, message: "Plugin not loaded" };
      }
      const fresh = freshStatus(service);
      if (fresh !== undefined) return fresh;
      return answerWithin(
        refresh(service),
        maxWaitMs,
        () => freshStatus(service) ?? NOT_RESPONDING,
      );
    },
  };
}
