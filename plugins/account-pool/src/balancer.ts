import type {
  Account,
  AccountBalance,
  AccountQuota,
  BalanceWindow,
  ModelFamily,
} from "./contracts.js";

const HOUR_MS = 60 * 60 * 1_000;
export const BALANCING_HYSTERESIS = 0.1;

interface Candidate {
  account: Account;
  quota: AccountQuota;
}

export interface BalancedCandidate extends Candidate {
  balance: AccountBalance;
}

export interface BalanceChoice {
  candidate: BalancedCandidate | null;
  reason: string;
}

function makeWindow(args: {
  kind: BalanceWindow["kind"];
  key: string;
  family: ModelFamily | null;
  utilization: number | null;
  status: string | null;
  resetAt: number | null;
  now: number;
}): BalanceWindow | null {
  if (
    args.utilization === null &&
    args.status === null &&
    args.resetAt === null
  )
    return null;
  if (args.resetAt !== null && args.resetAt <= args.now) {
    return {
      kind: args.kind,
      key: args.key,
      family: args.family,
      utilization: 0,
      headroom: 1,
      resetAt: args.resetAt,
      hoursUntilReset: 0,
      resetRecoveryPerHour: null,
    };
  }
  const hoursUntilReset =
    args.resetAt === null
      ? null
      : Math.max(0, (args.resetAt - args.now) / HOUR_MS);
  const utilization = args.utilization;
  const headroom =
    args.status?.toLowerCase() === "rejected"
      ? 0
      : utilization === null
        ? null
        : Math.max(0, 1 - utilization);
  return {
    kind: args.kind,
    key: args.key,
    family: args.family,
    utilization,
    headroom,
    resetAt: args.resetAt,
    hoursUntilReset,
    resetRecoveryPerHour:
      headroom === null || hoursUntilReset === null || hoursUntilReset <= 0
        ? null
        : Math.max(0, (1 - headroom) / hoursUntilReset),
  };
}

export function accountBalance(
  quota: AccountQuota,
  family: ModelFamily | null,
  now: number,
): AccountBalance {
  const windows = [
    makeWindow({
      kind: "five-hour",
      key: "five-hour",
      family: null,
      utilization: quota.fiveHourUtilization,
      status: quota.fiveHourStatus,
      resetAt: quota.fiveHourResetAt,
      now,
    }),
    makeWindow({
      kind: "weekly",
      key: "weekly",
      family: null,
      utilization: quota.sevenDayUtilization,
      status: quota.sevenDayStatus,
      resetAt: quota.sevenDayResetAt,
      now,
    }),
    ...quota.limitWindows.map((window) =>
      makeWindow({
        kind: "limit",
        key: `${window.slot}:${window.windowMinutes ?? "custom"}`,
        family: null,
        utilization: window.utilization,
        status: window.status,
        resetAt: window.resetAt,
        now,
      }),
    ),
    ...(family === null || quota.familyWeekly[family] === null
      ? []
      : [
          makeWindow({
            kind: "family",
            key: `family:${family}`,
            family,
            utilization: quota.familyWeekly[family]?.utilization ?? null,
            status: quota.familyWeekly[family]?.status ?? null,
            resetAt: quota.familyWeekly[family]?.resetAt ?? null,
            now,
          }),
        ]),
  ].filter((window): window is BalanceWindow => window !== null);
  const known = windows.filter(
    (window): window is BalanceWindow & { headroom: number } =>
      window.headroom !== null,
  );
  const binding = known.reduce<BalanceWindow | null>(
    (least, window) =>
      least === null ||
      window.headroom < (least.headroom ?? 1) ||
      (window.headroom === least.headroom &&
        (window.resetRecoveryPerHour ?? -1) >
          (least.resetRecoveryPerHour ?? -1))
        ? window
        : least,
    null,
  );
  return {
    bindingWindow: binding?.key ?? null,
    bindingHeadroom: binding?.headroom ?? null,
    resetRecoveryPerHour: binding?.resetRecoveryPerHour ?? null,
    windows,
  };
}

function compareCandidates(
  left: BalancedCandidate,
  right: BalancedCandidate,
): number {
  const leftHeadroom = left.balance.bindingHeadroom;
  const rightHeadroom = right.balance.bindingHeadroom;
  if (leftHeadroom === null && rightHeadroom !== null) return 1;
  if (leftHeadroom !== null && rightHeadroom === null) return -1;
  if (leftHeadroom !== null && rightHeadroom !== null) {
    const headroomDifference = rightHeadroom - leftHeadroom;
    if (headroomDifference !== 0) return headroomDifference;
  }
  const recoveryDifference =
    (right.balance.resetRecoveryPerHour ?? -1) -
    (left.balance.resetRecoveryPerHour ?? -1);
  if (recoveryDifference !== 0) return recoveryDifference;
  return (
    left.account.priority - right.account.priority ||
    left.account.createdAt - right.account.createdAt ||
    left.account.id.localeCompare(right.account.id)
  );
}

function topReason(
  best: BalancedCandidate,
  runnerUp: BalancedCandidate | undefined,
): string {
  if (best.balance.bindingHeadroom === null) {
    if (runnerUp === undefined) return "priority tie-break";
    if (
      best.balance.resetRecoveryPerHour !==
      runnerUp.balance.resetRecoveryPerHour
    )
      return "earliest reset";
    return "priority tie-break";
  }
  if (runnerUp === undefined) return "most headroom";
  if (best.balance.bindingHeadroom !== runnerUp.balance.bindingHeadroom)
    return "most headroom";
  if (
    best.balance.resetRecoveryPerHour !== runnerUp.balance.resetRecoveryPerHour
  )
    return "earliest reset";
  return "priority tie-break";
}

export function chooseBalancedCandidate(
  candidates: readonly Candidate[],
  family: ModelFamily,
  now: number,
  activeAccountId: string | null,
): BalanceChoice {
  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      balance: accountBalance(candidate.quota, family, now),
    }))
    .sort(compareCandidates);
  const best = ranked[0];
  if (best === undefined)
    return { candidate: null, reason: "no eligible account" };
  const incumbent = ranked.find(
    ({ account }) => account.id === activeAccountId,
  );
  if (
    incumbent !== undefined &&
    incumbent.account.id !== best.account.id &&
    (best.balance.bindingHeadroom === null ||
      (incumbent.balance.bindingHeadroom !== null &&
        best.balance.bindingHeadroom - incumbent.balance.bindingHeadroom <
          BALANCING_HYSTERESIS))
  ) {
    return { candidate: incumbent, reason: "hysteresis" };
  }
  return {
    candidate: best,
    reason: topReason(best, ranked[1]),
  };
}
