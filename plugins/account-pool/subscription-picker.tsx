import { useEffect, useState } from "react";
import { useComposer, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import {
  draftSelectionSchema,
  type AccountSummary,
  type PoolProvider,
  type PoolStatus,
} from "./src/contracts.js";
import {
  accountPoolBypassReadRpcContract,
  accountPoolRpcContract,
} from "./src/rpc.js";
import {
  ACCOUNT_POOL_ACCOUNTS_CHANGED,
  ACCOUNT_POOL_CONFIG_CHANGED,
} from "./src/realtime.js";
import { foldSubscriptions } from "./src/subscriptions.js";

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
  const rpc = useRpc<
    typeof accountPoolRpcContract & typeof accountPoolBypassReadRpcContract
  >();
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
  const [loadedBypass, setLoadedBypass] = useState<{
    key: string;
    value: boolean;
  } | null>(null);
  const bypassed = loadedBypass?.key === lookupKey ? loadedBypass.value : false;
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const actualProvider = composer.selection?.providerId;

  useRealtime(ACCOUNT_POOL_ACCOUNTS_CHANGED, () =>
    setRefresh((value) => value + 1),
  );
  useRealtime(ACCOUNT_POOL_CONFIG_CHANGED, () =>
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
      const [nextStatus, selection, nextBypassed] = await Promise.all([
        rpc.call("status.get", null),
        threadId === null
          ? Promise.resolve(null)
          : rpc.call("routing.selection.get", { threadId, provider }),
        threadId === null
          ? Promise.resolve(false)
          : rpc
              .call("bypass.get", { threadId })
              .then((result) => result.bypassed),
      ]);
      if (!mounted) return;
      setLoadedStatus({ key: lookupKey, value: nextStatus });
      setLoadedBypass({ key: lookupKey, value: nextBypassed });
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
    };
    void load().catch((failure: unknown) => {
      if (mounted)
        setError(
          failure instanceof Error
            ? failure.message
            : "Unable to load subscriptions.",
        );
    });
    return () => {
      mounted = false;
    };
  }, [composer, lookupKey, provider, refresh, rpc, threadId]);

  if (provider === null) return null;
  const records =
    status?.accounts.filter((account) => account.provider === provider) ?? [];
  const shown = new Set(
    foldSubscriptions(records).map((account) => account.id),
  );
  const accounts = records.filter(
    (account) => shown.has(account.id) || account.id === selected,
  );
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
  const selectedInUse =
    selected !== null &&
    status !== null &&
    status.routing[provider] &&
    status.parent?.mode !== "proxy" &&
    !bypassed;
  const inactiveReason =
    status?.parent?.mode === "proxy"
      ? "A parent pool decides which subscription to use."
      : status !== null && !status.routing[provider]
        ? `${provider === "claude" ? "Claude" : "Codex"} routing is off.`
        : bypassed
          ? "Pool routing is bypassed for this conversation."
          : null;
  const newThreadInactiveMessage =
    scope.kind === "new-thread" && selected !== null && inactiveReason !== null
      ? status?.parent?.mode === "proxy"
        ? "This new conversation can't use the selected subscription while a parent pool is in proxy mode. Choose Automatic or switch the parent to local mode before sending."
        : status !== null && !status.routing[provider]
          ? `This new conversation can't use the selected subscription while ${provider === "claude" ? "Claude" : "Codex"} routing is off. Choose Automatic or turn routing back on before sending.`
          : null
      : null;
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
          className="w-full text-ellipsis rounded-md border border-border bg-background px-2 py-1 text-sm pointer-coarse:min-h-11"
          value={selected ?? "automatic"}
          disabled={disabled}
          onChange={(event) => {
            void choose(event.target.value).catch((failure: unknown) => {
              setError(
                failure instanceof Error
                  ? failure.message
                  : "Unable to select this subscription.",
              );
            });
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
      {selectedInUse ? (
        <p className="mt-1 text-xs text-muted-foreground">
          This conversation uses only the selected subscription.
        </p>
      ) : newThreadInactiveMessage !== null ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {newThreadInactiveMessage}
        </p>
      ) : selected !== null && status !== null && inactiveReason !== null ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Saved preference not in use right now. {inactiveReason}
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
