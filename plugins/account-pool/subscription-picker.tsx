import { useEffect, useState } from "react";
import { useComposer, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import {
  draftSelectionSchema,
  type AccountSummary,
  type PoolProvider,
  type PoolStatus,
} from "./src/contracts.js";
import type { accountPoolRpcContract } from "./src/rpc.js";
import { ACCOUNT_POOL_ACCOUNTS_CHANGED } from "./src/realtime.js";

function percentage(value: number | null): string {
  return value === null ? "unknown" : `${Math.round(value * 100)}%`;
}

function label(account: AccountSummary): string {
  const usage =
    account.provider === "claude"
      ? `5h ${percentage(account.fiveHourUtilization)} · weekly ${percentage(account.sevenDayUtilization)}`
      : account.limitWindows
          .map((window) => `${window.slot} ${percentage(window.utilization)}`)
          .join(" · ");
  const state = !account.enabled
    ? "Disabled"
    : account.error !== null
      ? "Login needs repair"
      : account.status;
  return `${account.label} · ${usage || "usage unknown"} · ${state}`;
}

export function SubscriptionPicker({ providerId }: { providerId: string }) {
  const composer = useComposer();
  const rpc = useRpc<typeof accountPoolRpcContract>();
  const provider: PoolProvider | null =
    providerId === "claude-code"
      ? "claude"
      : providerId === "codex"
        ? "codex"
        : null;
  const scope = composer.scope;
  const threadId = scope.kind === "new-thread" ? null : scope.threadId;
  const lookupKey = `${provider}:${threadId ?? composer.key}`;
  const [loadedStatus, setLoadedStatus] = useState<{
    key: string;
    value: PoolStatus;
  } | null>(null);
  const status = loadedStatus?.key === lookupKey ? loadedStatus.value : null;
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const actualProvider = composer.selection?.providerId;

  useRealtime(ACCOUNT_POOL_ACCOUNTS_CHANGED, () =>
    setRefresh((value) => value + 1),
  );
  useEffect(() => {
    if (scope.kind !== "new-thread") return;
    const data = draftSelectionSchema.safeParse(
      composer.experimental_createData,
    );
    if (
      data.success &&
      actualProvider !==
        (data.data.provider === "claude" ? "claude-code" : "codex")
    ) {
      composer.experimental_setCreateData(null);
    }
  }, [actualProvider, composer, scope.kind]);

  useEffect(() => {
    let mounted = true;
    if (provider === null) return;
    const load = async () => {
      try {
        const [nextStatus, selection] = await Promise.all([
          rpc.call("status.get", null),
          threadId === null
            ? Promise.resolve(null)
            : rpc.call("routing.selection.get", { threadId, provider }),
        ]);
        if (!mounted) return;
        setLoadedStatus({ key: lookupKey, value: nextStatus });
        setError(null);
        const draft = draftSelectionSchema.safeParse(
          composer.experimental_createData,
        );
        setSelected(
          selection?.accountId ??
            (draft.success && draft.data.provider === provider
              ? draft.data.accountId
              : null),
        );
      } catch (failure) {
        if (mounted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Unable to load subscriptions.",
          );
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, [composer, lookupKey, provider, refresh, rpc, threadId]);

  if (provider === null) return null;
  const accounts =
    status?.accounts.filter((account) => account.provider === provider) ?? [];
  if (status !== null && accounts.length === 0 && selected === null)
    return null;
  const choose = async (value: string) => {
    const accountId = value === "automatic" ? null : value;
    const previous = selected;
    setSelected(accountId);
    setPending(true);
    setError(null);
    try {
      if (scope.kind === "new-thread") {
        if (actualProvider !== providerId)
          await composer.setSelection({ providerId });
        composer.experimental_setCreateData(
          accountId === null ? null : { provider, accountId },
        );
      } else {
        await rpc.call("routing.selection.set", {
          threadId: scope.threadId,
          provider,
          accountId,
        });
      }
    } catch (failure) {
      setSelected(previous);
      setError(
        failure instanceof Error
          ? failure.message
          : "Unable to select this subscription.",
      );
    } finally {
      setPending(false);
    }
  };
  const unavailable =
    selected !== null && !accounts.some((account) => account.id === selected);
  const disabled =
    pending || status === null || composer.isRunning || composer.isSubmitting;
  return (
    <div
      className="border-b border-border px-2 py-2"
      onKeyDown={(event) => {
        if (
          [
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
            " ",
            "Enter",
          ].includes(event.key)
        )
          event.stopPropagation();
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Subscription</span>
        <select
          aria-label="Subscription"
          className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
          value={selected ?? "automatic"}
          disabled={disabled}
          onChange={(event) => {
            void choose(event.target.value);
          }}
        >
          <option value="automatic">
            Automatic · use available subscriptions
          </option>
          {unavailable ? (
            <option value={selected}>Selected subscription unavailable</option>
          ) : null}
          {accounts.map((account) => (
            <option
              key={account.id}
              value={account.id}
              disabled={
                !account.enabled ||
                account.error !== null ||
                status?.parent?.mode === "proxy" ||
                !status?.routing[provider]
              }
            >
              {label(account)}
            </option>
          ))}
        </select>
      </label>
      {composer.isRunning ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Change subscriptions after this turn finishes.
        </p>
      ) : null}
      {selected !== null ? (
        <p className="mt-1 text-xs text-muted-foreground">
          This conversation uses only the selected subscription.
        </p>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
