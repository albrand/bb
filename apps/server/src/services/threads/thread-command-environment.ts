import { getProjectSourceByHost, reviveDestroyedEnvironment } from "@bb/db";
import type { EnvironmentRow } from "@bb/db";
import { isLocalPathProjectSource, type Thread } from "@bb/domain";
import type { DbConnection } from "@bb/db";
import type { WorkSessionDeps } from "../../types.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { assertEnvironmentPathAvailable } from "../environments/path-admission.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { DEFAULT_ENVIRONMENT_PROVIDER_ID } from "../environments/environment-provider-ids.js";
import { requireEnvironment } from "../lib/entity-lookup.js";
import {
  goneThreadEnvironmentDetails,
  threadEnvironmentUnavailableDetails,
  throwThreadEnvironmentUnavailable,
} from "../lib/lifecycle-api-errors.js";

type ThreadCommandEnvironmentSource = Pick<Thread, "environmentId">;

interface RequireThreadCommandEnvironmentArgs {
  thread: ThreadCommandEnvironmentSource & Pick<Thread, "id">;
}

interface RequireThreadHostCommandEnvironmentArgs {
  db: DbConnection;
  thread: ThreadCommandEnvironmentSource;
}

interface ThreadHostCommandEnvironment {
  hostId: string;
  id: string;
}

async function reviveDestroyedProjectEnvironment(
  deps: WorkSessionDeps,
  environment: EnvironmentRow,
  threadId: string,
): Promise<EnvironmentRow> {
  const canRevive =
    environment.environmentProviderId === null ||
    (environment.environmentProviderId ===
      DEFAULT_ENVIRONMENT_PROVIDER_ID.projectCheckout &&
      !environment.providerOwnsPath);
  if (environment.status !== "destroyed" || !canRevive) {
    return environment;
  }

  const source = getProjectSourceByHost(
    deps.db,
    environment.projectId,
    environment.hostId,
  );
  if (source === null || !isLocalPathProjectSource(source)) {
    return environment;
  }

  assertEnvironmentPathAvailable(deps, {
    ...environment,
    path: source.path,
    threadId,
  });

  try {
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId: environment.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: { type: "host.paths_exist", paths: [source.path] },
    });
    if (result.existence[source.path] !== true) {
      return environment;
    }
  } catch {
    return environment;
  }

  return (
    reviveDestroyedEnvironment(deps.db, deps.hub, {
      environmentId: environment.id,
      path: source.path,
      projectCheckoutProviderId:
        DEFAULT_ENVIRONMENT_PROVIDER_ID.projectCheckout,
    }) ?? requireEnvironment(deps.db, environment.id)
  );
}

export function resolveThreadHostCommandEnvironment(
  args: RequireThreadHostCommandEnvironmentArgs,
): ThreadHostCommandEnvironment | null {
  if (args.thread.environmentId === null) {
    return null;
  }
  const environment = requireEnvironment(args.db, args.thread.environmentId);
  return {
    id: environment.id,
    hostId: environment.hostId,
  };
}

export function requireThreadHostCommandEnvironment(
  args: RequireThreadHostCommandEnvironmentArgs,
): ThreadHostCommandEnvironment {
  const environment = resolveThreadHostCommandEnvironment(args);
  if (environment !== null) {
    return environment;
  }

  throwThreadEnvironmentUnavailable(
    threadEnvironmentUnavailableDetails("never_attached", null),
  );
}

export async function requireThreadCommandEnvironment(
  deps: WorkSessionDeps,
  args: RequireThreadCommandEnvironmentArgs,
): Promise<EnvironmentRow> {
  if (args.thread.environmentId !== null) {
    let environment = requireEnvironment(deps.db, args.thread.environmentId);
    if (environment.status === "destroyed") {
      environment = await reviveDestroyedProjectEnvironment(
        deps,
        environment,
        args.thread.id,
      );
    }
    const goneDetails = goneThreadEnvironmentDetails(environment);
    if (goneDetails) {
      throwThreadEnvironmentUnavailable(goneDetails);
    }
    assertEnvironmentPathAvailable(deps, {
      ...environment,
      threadId: args.thread.id,
    });
    return environment;
  }

  throwThreadEnvironmentUnavailable(
    threadEnvironmentUnavailableDetails("never_attached", null),
  );
}
