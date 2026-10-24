import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { DbConnection, DbTransaction } from "../connection.js";
import {
  environments,
  hosts,
  queuedThreadMessages,
  threads,
} from "../schema.js";

type Connection = DbConnection | DbTransaction;

const liveThreadCondition = or(
  and(isNull(threads.archivedAt), isNull(threads.deletedAt)),
  eq(threads.status, "stopping"),
  eq(threads.status, "active"),
  sql`exists (select 1 from ${queuedThreadMessages} where ${queuedThreadMessages.threadId} = ${threads.id} and ${queuedThreadMessages.state} = 'claimed')`,
);

export function listProviderMachines(db: Connection, providerId: string) {
  return db
    .select()
    .from(hosts)
    .where(
      and(
        eq(hosts.machineProviderId, providerId),
        isNull(hosts.destroyedAt),
        ne(hosts.phase, "destroyed"),
      ),
    )
    .all();
}

export function machineHasLiveThreads(db: Connection, hostId: string): boolean {
  return (
    db
      .select({ id: threads.id })
      .from(threads)
      .innerJoin(environments, eq(threads.environmentId, environments.id))
      .where(and(eq(environments.hostId, hostId), liveThreadCondition))
      .limit(1)
      .get() !== undefined
  );
}

function machineHasThreadLaunchWhere(
  db: Connection,
  hostId: string,
  threadCondition: SQL | undefined,
): boolean {
  return (
    db
      .select({ id: threads.id })
      .from(hosts)
      .innerJoin(threads, eq(hosts.launchKey, threads.id))
      .where(
        and(eq(hosts.id, hostId), isNull(hosts.destroyedAt), threadCondition),
      )
      .limit(1)
      .get() !== undefined
  );
}

export function machineHasLiveThreadLaunch(
  db: Connection,
  hostId: string,
): boolean {
  return machineHasThreadLaunchWhere(db, hostId, liveThreadCondition);
}

function selectMachinePendingThreads(db: Connection, hostId: string) {
  const intent = sql`case json_extract(${threads.startupContext}, '$.kind')
    when 'pending' then json_extract(${threads.startupContext}, '$.environmentIntent')
    when 'provisioning' then json_extract(${threads.startupContext}, '$.request.environmentIntent')
  end`;
  return db
    .select({ id: threads.id })
    .from(threads)
    .leftJoin(
      environments,
      or(
        and(
          eq(environments.ownerThreadId, threads.id),
          eq(threads.status, "starting"),
        ),
        and(
          sql`json_extract(${intent}, '$.type') = 'reuse'`,
          eq(environments.id, sql`json_extract(${intent}, '$.environmentId')`),
        ),
      ),
    )
    .where(
      and(
        inArray(threads.status, ["pending", "starting"]),
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
        or(
          and(
            eq(environments.hostId, hostId),
            inArray(environments.status, ["creating", "provisioning", "ready"]),
            isNull(environments.teardownStatus),
          ),
          sql`json_extract(${intent}, '$.type') = 'provider'
          and json_extract(${intent}, '$.machine.type') = 'existing'
          and json_extract(${intent}, '$.machine.hostId') = ${hostId}`,
        ),
      ),
    );
}

export function machineHasPendingThreads(
  db: Connection,
  hostId: string,
): boolean {
  return selectMachinePendingThreads(db, hostId).limit(1).get() !== undefined;
}

function selectExemptLauncherId(db: Connection, hostId: string): string | null {
  const launcher = db
    .select({ id: threads.id, status: threads.status })
    .from(hosts)
    .innerJoin(threads, eq(hosts.launchKey, threads.id))
    .where(eq(hosts.id, hostId))
    .get();
  if (
    launcher === undefined ||
    launcher.status === "active" ||
    launcher.status === "stopping"
  ) {
    return null;
  }
  const workspace = db
    .select({ id: environments.id })
    .from(environments)
    .leftJoin(threads, eq(threads.environmentId, environments.id))
    .where(
      and(
        eq(environments.hostId, hostId),
        or(
          eq(environments.ownerThreadId, launcher.id),
          eq(threads.id, launcher.id),
        ),
        or(eq(environments.status, "ready"), isNotNull(environments.path)),
      ),
    )
    .limit(1)
    .get();
  return workspace === undefined ? launcher.id : null;
}

export function listMachineBlockingThreadIds(
  db: Connection,
  hostId: string,
): string[] {
  const owning = db
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(and(eq(environments.hostId, hostId), liveThreadCondition))
    .all();
  const launching = db
    .select({ id: threads.id })
    .from(hosts)
    .innerJoin(threads, eq(hosts.launchKey, threads.id))
    .where(
      and(eq(hosts.id, hostId), isNull(hosts.destroyedAt), liveThreadCondition),
    )
    .all();
  const pending = selectMachinePendingThreads(db, hostId).all();
  const exempt = selectExemptLauncherId(db, hostId);
  return [
    ...new Set(
      [...owning, ...launching, ...pending].map((thread) => thread.id),
    ),
  ].filter((id) => id !== exempt);
}

export function machineHasProvisioningEnvironment(
  db: Connection,
  hostId: string,
): boolean {
  return (
    db
      .select({ id: environments.id })
      .from(environments)
      .where(
        and(
          eq(environments.hostId, hostId),
          inArray(environments.status, ["creating", "provisioning"]),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

export function machineHasStartingThreadLaunch(
  db: Connection,
  hostId: string,
): boolean {
  return machineHasThreadLaunchWhere(
    db,
    hostId,
    and(
      eq(threads.status, "starting"),
      isNull(threads.archivedAt),
      isNull(threads.deletedAt),
    ),
  );
}
