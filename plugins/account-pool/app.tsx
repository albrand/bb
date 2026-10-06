import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import type {
  AccountSummary,
  AccountPoolConfig,
  AccountPoolConfigSetInput,
  FamilyQuota,
  LimitWindow,
  LocalLogin,
  ModelFamily,
  PoolAvailability,
  PoolProvider,
  PoolStatus,
} from "./src/contracts.js";
import type {
  accountPoolBindingReadRpcContract,
  accountPoolRpcContract,
} from "./src/rpc.js";
import type { OAuthLoginStart } from "./src/oauth-login.js";
import type { CodexDeviceLoginStart } from "./src/codex-device-login.js";
import {
  DEFAULT_ACCOUNT_POOL_CONFIG,
  modelFamilySchema,
  statusSchema,
} from "./src/contracts.js";
import { blockingResetAt } from "./src/quota.js";
import {
  foldSubscriptions,
  subscriptionMembers,
  subscriptionRepresentative,
} from "./src/subscriptions.js";
import { SubscriptionPicker } from "./subscription-picker.js";
import {
  ACCOUNT_POOL_ACCOUNTS_CHANGED,
  ACCOUNT_POOL_CONFIG_CHANGED,
} from "./src/realtime.js";

type DialogState =
  | { kind: "account" | "priority" | "remove" | "turn-off"; accountId: string }
  | { kind: "claude-login" | "codex-login"; accountId: string | null }
  | { kind: "api-key" }
  | null;

type ConfigField = Exclude<keyof AccountPoolConfig, "parentMode">;

const PROVIDERS: Array<{ id: PoolProvider; title: string }> = [
  { id: "claude", title: "Claude" },
  { id: "codex", title: "Codex" },
];
const FAMILY_LABELS: Record<ModelFamily, string> = {
  fable: "Fable 7 day",
  sonnet: "Sonnet 7 day",
  opus: "Opus 7 day",
  haiku: "Haiku 7 day",
  other: "Other 7 day",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function httpUrlError(value: string): string | null {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:"
      ? null
      : "Must be an HTTP or HTTPS URL.";
  } catch {
    return "Must be a valid URL.";
  }
}

function configDrafts(config: AccountPoolConfig): Record<ConfigField, string> {
  return {
    anthropicUpstreamBaseUrl: config.anthropicUpstreamBaseUrl,
    codexUpstreamBaseUrl: config.codexUpstreamBaseUrl,
    switchThreshold: String(config.switchThreshold),
  };
}
function parentHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function parentBannerBody(parent: NonNullable<PoolStatus["parent"]>): string {
  const host = parentHost(parent.baseUrl);
  if (parent.mode !== "proxy") {
    return `This server was started from a thread on ${host}. Turn this on to send Claude and Codex requests to its pool instead of using the accounts below.`;
  }
  const served = PROVIDERS.filter(
    (provider) => parent.availability[provider.id],
  ).map((provider) => provider.title);
  if (served.length === 0) {
    return `${host} has no accounts available right now, so nothing is being sent there. Requests fall back to each provider's own credentials.`;
  }
  const missing = PROVIDERS.filter(
    (provider) => !parent.availability[provider.id],
  ).map((provider) => provider.title);
  const routed = `${served.join(" and ")} requests are sent to the pool on ${host}.`;
  return missing.length === 0
    ? `${routed} Accounts on this server are not used while this is on.`
    : `${routed} ${missing.join(" and ")} has no accounts there, so those requests fall back to their own credentials.`;
}
function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}
function relative(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
function windowLongLabel(window: LimitWindow): string {
  if (window.windowMinutes === null)
    return window.slot === "primary" ? "Usage limit" : "Secondary limit";
  if (window.windowMinutes === 7 * 24 * 60) return "Weekly";
  if (window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440} day`;
  if (window.windowMinutes % 60 === 0)
    return `${window.windowMinutes / 60} hour`;
  return `${window.windowMinutes} minute`;
}
function resetLabel(timestamp: number | null): string {
  if (timestamp === null) return "";
  const minutes = Math.max(1, Math.round((timestamp - Date.now()) / 60_000));
  if (minutes < 1_440)
    return `resets in ${minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`}`;
  return `resets ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp)}`;
}
const STATUS_CACHE_KEY = "account-pool:status";

function readCachedStatus(): PoolStatus | null {
  try {
    const raw = window.localStorage.getItem(STATUS_CACHE_KEY);
    if (raw === null) return null;
    const parsed = statusSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeCachedStatus(status: PoolStatus): void {
  try {
    window.localStorage.setItem(STATUS_CACHE_KEY, JSON.stringify(status));
  } catch {
    return;
  }
}

type SubscriptionState = {
  label: string;
  detail: string | null;
  icon: string | null;
  tone: string;
};

function untilLabel(timestamp: number): string {
  const minutes = Math.max(1, Math.round((timestamp - Date.now()) / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 1_440)
    return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `in ${Math.floor(minutes / 1_440)}d ${Math.floor((minutes % 1_440) / 60)}h`;
}

function subscriptionState(
  account: AccountSummary,
  threshold: number,
  nextAccountId: string | null,
): SubscriptionState {
  if (account.signInExpired)
    return {
      label: "Sign-in expired",
      detail: null,
      icon: "AlertCircle",
      tone: "text-warning-text",
    };
  if (!account.enabled)
    return {
      label: "Off",
      detail: null,
      icon: null,
      tone: "text-subtle-foreground",
    };
  if (account.status === "error")
    return {
      label: "Can't read usage",
      detail: null,
      icon: "AlertTriangle",
      tone: "text-warning-text",
    };
  if (account.status === "held")
    return {
      label: "Held",
      detail:
        account.heldUntil === null
          ? null
          : `retry at ${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(account.heldUntil)}`,
      icon: "Clock",
      tone: "text-warning-text",
    };
  if (account.status === "exhausted") {
    const resetAt = blockingResetAt(account, null, threshold, Date.now());
    return {
      label: "Used up",
      detail: resetAt === null ? null : `back ${untilLabel(resetAt)}`,
      icon: "Circle",
      tone: "text-subtle-foreground",
    };
  }
  if (account.id === nextAccountId)
    return {
      label: "Next",
      detail: "most headroom",
      icon: "ArrowRight",
      tone: "text-foreground",
    };
  return {
    label: "Ready",
    detail: null,
    icon: null,
    tone: "text-subtle-foreground",
  };
}

function StateWord({ state }: { state: SubscriptionState }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-xs",
        state.tone,
      )}
    >
      {state.icon === null ? null : (
        <Icon name={state.icon} className="size-3.5 shrink-0" aria-hidden />
      )}
      <span className="shrink-0">{state.label}</span>
      {state.detail === null ? null : (
        <span className="truncate text-subtle-foreground">
          · {state.detail}
        </span>
      )}
    </span>
  );
}

function planBadge(
  account: Pick<AccountSummary, "kind" | "subscriptionType" | "rateLimitTier">,
): string | null {
  if (account.kind === "api-key") return "API key";
  const max = account.rateLimitTier?.match(/max_(\d+)x/u);
  if (max) return `Max ${max[1]}x`;
  const plan = account.subscriptionType;
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null;
}

function secondaryEmail(account: AccountSummary): string | null {
  return account.email === null || account.email === account.label
    ? null
    : account.email;
}

function SettingsBadge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 whitespace-nowrap rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none text-subtle-foreground">
      {children}
    </span>
  );
}

function providerTitle(provider: PoolProvider): string {
  return provider === "claude" ? "Claude" : "Codex";
}

function removeCopy(account: AccountSummary): string {
  const name = providerTitle(account.provider);
  return `bb deletes its saved ${account.kind === "api-key" ? "key" : "sign-in"}. Conversations on Automatic move to your other ${name} subscriptions; conversations set to this one stop until you choose another. ${account.kind === "api-key" ? "To use it again, add the key again." : "To use it again, sign in again."}`;
}

function turnOffCopy(
  account: AccountSummary,
  twins: readonly AccountSummary[],
): string {
  const names = twins.map((twin) => twin.label).join(", ");
  const one = twins.length === 1;
  return `${names} ${one ? "is" : "are"} also on for this login, so ${account.label} would keep sending through ${one ? "it" : "them"}. Turning it off turns ${one ? "both" : "all of them"} off; they stay in the pool, and turning it on again uses ${account.label} only.`;
}

const restrictAccountDragToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});
const accountDragModifiers: Modifier[] = [restrictAccountDragToVerticalAxis];

const LEDGER_ROW_CLASS =
  "grid grid-cols-[auto_minmax(0,1fr)_auto_auto] grid-rows-[auto_auto_auto] items-center gap-x-2 border-t border-border py-2 pl-1 pr-1 text-sm @[40rem]:grid-cols-[auto_minmax(0,1fr)_14rem_7rem_auto] @[40rem]:grid-rows-[auto_auto] @[40rem]:gap-x-3 @[40rem]:pr-2";

type SubscriptionAction =
  | "toggle"
  | "priority"
  | "refresh"
  | "remove"
  | "details"
  | "sign-in";

function SubscriptionRow({
  account,
  state,
  pending,
  refreshing,
  reorderDisabled,
  onAction,
  onRename,
}: {
  account: AccountSummary;
  state: SubscriptionState;
  pending: boolean;
  refreshing: boolean;
  reorderDisabled: boolean;
  onAction: (action: SubscriptionAction) => void;
  onRename: (label: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(account.label);
  const plan = planBadge(account);
  const email = secondaryEmail(account);
  const signInAgain = account.signInExpired && account.kind === "oauth";
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: account.id, disabled: pending || reorderDisabled });
  function commit(): void {
    const label = draft.trim();
    setRenaming(false);
    if (label.length > 0 && label !== account.label) onRename(label);
  }
  function cancel(): void {
    setDraft(account.label);
    setRenaming(false);
  }
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        LEDGER_ROW_CLASS,
        isDragging && "relative z-10 rounded-md bg-card opacity-90 shadow-lift",
      )}
    >
      <Button
        ref={setActivatorNodeRef}
        type="button"
        variant="ghost"
        size="icon"
        className="col-start-1 row-span-full row-start-1 size-8 shrink-0 touch-none text-muted-foreground enabled:cursor-grab enabled:active:cursor-grabbing pointer-coarse:size-11"
        disabled={pending || reorderDisabled}
        aria-label={`Reorder ${account.label}`}
        {...attributes}
        {...listeners}
      >
        <Icon name="DragDropVertical" aria-hidden="true" />
      </Button>
      <div className="col-start-2 row-start-1 flex min-w-0 items-start gap-2">
        {renaming ? (
          <div
            className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
            onBlur={(event) => {
              if (
                !(event.relatedTarget instanceof Node) ||
                !event.currentTarget.contains(event.relatedTarget)
              )
                commit();
            }}
          >
            <Input
              autoFocus
              aria-label="Subscription name"
              className="h-7 min-w-0 flex-1 basis-48 @[40rem]:max-w-80 pointer-coarse:h-10"
              value={draft}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commit();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  cancel();
                }
              }}
            />
            <Button
              type="button"
              size="sm"
              className="h-7 pointer-coarse:h-10"
              onMouseDown={(event) => event.preventDefault()}
              onClick={commit}
            >
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 pointer-coarse:h-10"
              onMouseDown={(event) => event.preventDefault()}
              onClick={cancel}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <>
            <button
              type="button"
              aria-label={`Rename ${account.label}`}
              disabled={pending}
              className={cn(
                "inline-flex min-h-6 min-w-0 items-start gap-1.5 rounded-sm text-left font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-7",
                !account.enabled && "text-foreground/75",
              )}
              onClick={() => {
                setDraft(account.label);
                setRenaming(true);
              }}
            >
              <span className="line-clamp-2 min-w-0 break-words @[40rem]:line-clamp-1">
                {account.label}
              </span>
              <Icon
                name="Pencil"
                aria-hidden="true"
                className="mt-1 size-3 shrink-0 text-muted-foreground opacity-70"
              />
            </button>
            {plan === null ? null : (
              <span className="mt-0.5 shrink-0">
                <SettingsBadge>{plan}</SettingsBadge>
              </span>
            )}
          </>
        )}
      </div>
      {renaming ? (
        <p className="col-start-2 row-start-2 text-xs text-subtle-foreground">
          Enter to save · Esc to cancel
        </p>
      ) : (
        <>
          <div className="col-start-2 row-start-2 hidden min-w-0 items-center gap-x-1 truncate text-xs text-subtle-foreground @[40rem]:flex">
            {email === null ? null : <span className="truncate">{email}</span>}
            {account.lastUsedAt === null ? null : (
              <span className="shrink-0">
                {email === null ? "" : "· "}used {relative(account.lastUsedAt)}
              </span>
            )}
            {refreshing ? (
              <span className="shrink-0">refreshing usage…</span>
            ) : null}
          </div>
          <div className="col-start-2 row-start-2 min-w-0 @[40rem]:col-start-3 @[40rem]:row-span-full @[40rem]:row-start-1">
            <StateWord state={state} />
          </div>
        </>
      )}
      {signInAgain ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          aria-label={`Sign in again to ${account.label}`}
          className="col-start-2 row-start-3 mt-1.5 justify-self-start pointer-coarse:h-9 @[40rem]:col-start-4 @[40rem]:row-span-full @[40rem]:row-start-1 @[40rem]:mt-0 @[40rem]:justify-self-end"
          onClick={() => onAction("sign-in")}
        >
          <Icon name="UserRound" className="size-3.5" />
          Sign in again
        </Button>
      ) : (
        <Switch
          checked={account.enabled}
          disabled={pending}
          aria-label={`Use ${account.label}`}
          className="col-start-3 row-span-full row-start-1 justify-self-end @[40rem]:col-start-4"
          onCheckedChange={() => onAction("toggle")}
        />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="col-start-4 row-span-full row-start-1 size-8 shrink-0 data-[state=open]:bg-state-active pointer-coarse:size-11 @[40rem]:col-start-5"
            aria-label={`${account.label} actions`}
          >
            <Icon name="MoreHorizontal" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => onAction("details")}>
            <Icon name="ChartColumn" />
            Usage details
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={pending}
            onSelect={() => onAction("refresh")}
          >
            <Icon name="RotateCcw" />
            Refresh usage
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={pending}
            onSelect={() => onAction("priority")}
          >
            <Icon name="ListView" />
            Set priority…
          </DropdownMenuItem>
          {account.kind === "oauth" ? (
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("sign-in")}
            >
              <Icon name="UserRound" />
              Sign in again…
            </DropdownMenuItem>
          ) : null}
          {signInAgain ? (
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("toggle")}
            >
              <Icon name={account.enabled ? "Circle" : "CircleCheck"} />
              {account.enabled ? "Turn off" : "Turn on"}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={pending}
            onSelect={() => onAction("remove")}
          >
            <Icon name="Trash2" />
            Remove…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function LocalLoginRow({
  login,
  pending,
  onAdd,
}: {
  login: LocalLogin;
  pending: boolean;
  onAdd: (provider: PoolProvider) => void;
}) {
  const note = [
    login.email ?? `This Mac's ${login.displayName} login`,
    login.poolProvider === null ? "can't be pooled" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const state: SubscriptionState =
    login.status === "expired"
      ? {
          label: "Sign-in expired",
          detail: null,
          icon: "AlertCircle",
          tone: "text-warning-text",
        }
      : {
          label: "Ready",
          detail: null,
          icon: null,
          tone: "text-subtle-foreground",
        };
  const poolProvider = login.poolProvider;
  return (
    <div className={LEDGER_ROW_CLASS}>
      <span
        aria-hidden="true"
        className="col-start-1 row-span-full row-start-1 size-8 pointer-coarse:size-11"
      />
      <div className="col-start-2 row-start-1 flex min-w-0 items-start gap-2">
        <span className="line-clamp-2 min-w-0 break-words font-medium text-foreground @[40rem]:line-clamp-1">
          {login.displayName}
        </span>
        {login.planLabel === null ? null : (
          <span className="mt-0.5 shrink-0">
            <SettingsBadge>{login.planLabel}</SettingsBadge>
          </span>
        )}
      </div>
      <p className="col-start-2 row-start-2 min-w-0 truncate text-xs text-subtle-foreground">
        {note}
      </p>
      <div className="col-start-2 row-start-3 min-w-0 @[40rem]:col-start-3 @[40rem]:row-span-full @[40rem]:row-start-1">
        <StateWord state={state} />
      </div>
      {poolProvider === null ? null : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          aria-label={`Add this Mac's ${login.displayName} login to the pool`}
          className="col-start-3 row-span-full row-start-1 justify-self-end pointer-coarse:h-9 @[40rem]:col-start-4"
          onClick={() => onAdd(poolProvider)}
        >
          <Icon name="Plus" className="size-3.5" />
          Add to pool
        </Button>
      )}
    </div>
  );
}

type AddChoice = "login" | "import" | "api-key";

function AddSubscriptionMenu({
  onChoose,
}: {
  onChoose: (provider: PoolProvider, choice: AddChoice) => void;
}) {
  const item = (
    provider: PoolProvider,
    choice: AddChoice,
    icon: string,
    title: string,
    detail: string,
  ) => (
    <DropdownMenuItem
      className="items-start py-2"
      onSelect={() => onChoose(provider, choice)}
    >
      <Icon name={icon} className="mt-0.5" />
      <span>
        <span className="block">{title}</span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Icon name="Plus" className="size-3.5" />
          Add subscription
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Claude</DropdownMenuLabel>
        {item(
          "claude",
          "login",
          "UserRound",
          "Sign in to Claude",
          "Opens claude.ai, paste the code back",
        )}
        {item(
          "claude",
          "import",
          "Download",
          "Import this Mac's Claude login",
          "The ~/.claude login, if it isn't pooled yet",
        )}
        {item(
          "claude",
          "api-key",
          "Lock",
          "Add Anthropic API key…",
          "Billed per use; subscriptions with headroom go first",
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Codex</DropdownMenuLabel>
        {item(
          "codex",
          "login",
          "UserRound",
          "Sign in to Codex",
          "Opens ChatGPT with a device code",
        )}
        {item(
          "codex",
          "import",
          "Download",
          "Import this Mac's Codex login",
          "The ~/.codex login, if it isn't pooled yet",
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StepIndicator({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="flex gap-1.5" aria-label={`Step ${step} of 3`}>
      {[1, 2, 3].map((value) => (
        <span
          key={value}
          className={cn(
            "h-1 flex-1 rounded-full",
            value <= step ? "bg-primary" : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}
function QuotaDetail({
  label,
  quota,
  threshold,
}: {
  label: string;
  quota: FamilyQuota | null;
  threshold: number;
}) {
  const utilization = quota?.utilization ?? null;
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-3 text-sm">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0">
        <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full",
              utilization !== null && utilization >= 1
                ? "bg-destructive"
                : utilization !== null && utilization >= threshold - 0.1
                  ? "bg-warning"
                  : "bg-primary",
            )}
            style={{
              width: `${Math.min(100, Math.max(0, (utilization ?? 0) * 100))}%`,
            }}
          />
        </div>
        <div className="text-xs text-muted-foreground">
          {percent(utilization)}
          {quota?.resetAt === null || quota === null
            ? ""
            : ` · ${resetLabel(quota.resetAt)}`}{" "}
          · will be skipped at {Math.round(threshold * 100)}%
        </div>
      </div>
    </div>
  );
}

type CopyState = "idle" | "copied" | "manual";

function useCopyToClipboard(text: string, selectFallback: () => void) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setCopyState("idle");
  }, [text]);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopyState("copied");
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopyState("idle"), 1500);
      },
      () => {
        selectFallback();
        setCopyState("manual");
      },
    );
  }, [text, selectFallback]);

  return { copyState, copy };
}

function UserCodeBlock({ userCode }: { userCode: string }) {
  const codeRef = useRef<HTMLSpanElement>(null);
  const selectCode = useCallback(() => {
    const element = codeRef.current;
    if (element === null) return;
    const selection = window.getSelection();
    if (selection === null) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);
  const { copyState, copy } = useCopyToClipboard(userCode, selectCode);

  return (
    <div className="rounded-lg border border-border bg-surface-recessed px-4 py-4">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center">
        <span
          ref={codeRef}
          className="col-start-2 select-all text-center font-mono text-2xl font-semibold tracking-widest"
          aria-label="Codex user code"
        >
          {userCode}
        </span>
        <Button
          type="button"
          variant="ghost"
          aria-label="Copy Codex sign-in code"
          className="col-start-3 size-11 justify-self-start text-muted-foreground hover:text-foreground sm:size-9"
          onClick={copy}
        >
          <Icon name={copyState === "copied" ? "Check" : "Copy"} />
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copyState === "copied"
          ? "Sign-in code copied"
          : copyState === "manual"
            ? "Your browser blocked copying. The code is selected; copy it manually."
            : ""}
      </span>
    </div>
  );
}

function AuthorizationUrlRow({
  name,
  url,
  openUrl,
}: {
  name: string;
  url: string;
  openUrl: (url: string) => boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const selectUrl = useCallback(() => {
    inputRef.current?.select();
  }, []);
  const { copyState, copy } = useCopyToClipboard(url, selectUrl);

  return (
    <div>
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          readOnly
          value={url}
          aria-label={`${name} authorization URL`}
        />
        <Button
          variant="outline"
          className="shrink-0"
          aria-label={`Copy ${name} authorization URL`}
          onClick={copy}
        >
          {copyState === "copied" ? "Copied" : "Copy"}
        </Button>
        <Button className="shrink-0" onClick={() => openUrl(url)}>
          Open
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copyState === "copied"
          ? "Authorization URL copied"
          : copyState === "manual"
            ? "Your browser blocked copying. The URL is selected; copy it manually."
            : ""}
      </span>
    </div>
  );
}

function DialogFrame({
  title,
  children,
  footer,
  className,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  className?: string;
}) {
  return (
    <DialogContent
      hideCloseButton
      className={cn(
        "max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto]",
        className,
      )}
    >
      <DialogHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <DialogTitle>{title}</DialogTitle>
        <DialogClose className="-mr-1 shrink-0 cursor-pointer rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
          <Icon name="X" className="size-4" />
          <span className="sr-only">Close</span>
        </DialogClose>
      </DialogHeader>
      <div className="min-h-0 space-y-5 overflow-y-auto">{children}</div>
      {footer === null ? null : (
        <DialogFooter className="flex-row items-center gap-2 sm:space-x-0">
          {footer}
        </DialogFooter>
      )}
    </DialogContent>
  );
}

function ConfigFieldRow({
  label,
  description,
  error,
  children,
}: {
  label: string;
  description: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {description}
        </div>
      </div>
      <div className="w-80 max-w-[50%] shrink-0">
        {children}
        {error === null ? null : (
          <p className="mt-1 text-xs text-destructive-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function AccountPoolSettings() {
  const rpc = useRpc<
    typeof accountPoolRpcContract & typeof accountPoolBindingReadRpcContract
  >();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<PoolStatus | null>(readCachedStatus);
  const [statusIsCached, setStatusIsCached] = useState(status !== null);
  const [config, setConfig] = useState<AccountPoolConfig | null>(null);
  const [drafts, setDrafts] = useState<Record<ConfigField, string>>({
    anthropicUpstreamBaseUrl: "",
    codexUpstreamBaseUrl: "",
    switchThreshold: "",
  });
  const [configErrors, setConfigErrors] = useState<
    Record<ConfigField, string | null>
  >({
    anthropicUpstreamBaseUrl: null,
    codexUpstreamBaseUrl: null,
    switchThreshold: null,
  });
  const [dialog, setDialog] = useState<DialogState>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [optimisticOrder, setOptimisticOrder] = useState<{
    provider: PoolProvider;
    ids: string[];
  } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const [loginStep, setLoginStep] = useState<OAuthLoginStart | null>(null);
  const [codexStep, setCodexStep] = useState<CodexDeviceLoginStart | null>(
    null,
  );
  const [loginDone, setLoginDone] = useState<string | null>(null);
  const [pastedCode, setPastedCode] = useState("");
  const [accountLabel, setAccountLabel] = useState("");
  const [nextAccountId, setNextAccountId] = useState<string | null>(null);
  const [localLogins, setLocalLogins] = useState<LocalLogin[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [priority, setPriority] = useState("100");
  const [countdown, setCountdown] = useState(0);
  const mounted = useRef(true);
  const threshold =
    config?.switchThreshold ?? DEFAULT_ACCOUNT_POOL_CONFIG.switchThreshold;
  const applyConfig = useCallback((next: AccountPoolConfig) => {
    setConfig(next);
    setDrafts(configDrafts(next));
  }, []);
  const refresh = useCallback(async () => {
    try {
      const next = await rpc.call("status.get", null);
      writeCachedStatus(next);
      if (!mounted.current) return;
      setStatus(next);
      setStatusIsCached(false);
      const pick =
        next.routing.claude &&
        next.accounts.some(
          (account) => account.provider === "claude" && account.enabled,
        )
          ? await rpc.call("routing.binding.next", { provider: "claude" }).then(
              (result) => result.nextAccountId,
              () => null,
            )
          : null;
      if (mounted.current) setNextAccountId(pick);
    } catch (loadError) {
      if (mounted.current) setError(errorText(loadError));
    }
  }, [rpc]);
  const refreshLocalLogins = useCallback(async () => {
    const logins = await rpc
      .call("local.logins", null)
      .catch((): LocalLogin[] => []);
    if (mounted.current) setLocalLogins(logins);
  }, [rpc]);
  const refreshConfig = useCallback(async () => {
    try {
      const next = await rpc.call("config.get", null);
      if (mounted.current) applyConfig(next);
    } catch (loadError) {
      if (mounted.current) setError(errorText(loadError));
    }
  }, [applyConfig, rpc]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    void refreshConfig();
    void refreshLocalLogins();
    return () => {
      mounted.current = false;
    };
  }, [refresh, refreshConfig, refreshLocalLogins]);
  useRealtime(ACCOUNT_POOL_ACCOUNTS_CHANGED, () => {
    void refresh();
    void refreshLocalLogins();
  });
  useRealtime(ACCOUNT_POOL_CONFIG_CHANGED, () => {
    void refreshConfig();
  });
  useEffect(() => {
    if (codexStep === null || loginDone !== null) return;
    const update = () =>
      setCountdown(
        Math.max(0, Math.ceil((codexStep.expiresAt - Date.now()) / 1_000)),
      );
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [codexStep, loginDone]);
  useEffect(() => {
    if (codexStep === null || loginDone !== null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const result = await rpc.call("codexLogin.poll", {
          sessionId: codexStep.sessionId,
          ...(accountLabel.trim() === "" ? {} : { label: accountLabel.trim() }),
        });
        if (cancelled) return;
        if (result.status === "complete") {
          setLoginDone(result.account.label);
          setCodexStep(null);
          await refresh();
        } else if (result.status === "error") {
          setCodexStep(null);
          setError(result.message);
        } else timer = setTimeout(poll, codexStep.intervalMs);
      } catch (pollError) {
        if (!cancelled) setError(errorText(pollError));
      }
    };
    timer = setTimeout(poll, codexStep.intervalMs);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [accountLabel, codexStep, loginDone, refresh, rpc]);
  const accounts = status?.accounts ?? [];
  const nextSubscriptionId =
    nextAccountId === null
      ? null
      : (subscriptionRepresentative(accounts, nextAccountId)?.id ?? null);
  const enabledTwins = (account: AccountSummary) =>
    subscriptionMembers(accounts, account.id).filter(
      (member) => member.id !== account.id && member.enabled,
    );
  const selectedAccount =
    dialog === null || dialog.kind === "api-key" || dialog.accountId === null
      ? null
      : (accounts.find((account) => account.id === dialog.accountId) ?? null);
  async function run(key: string, action: () => Promise<void>): Promise<void> {
    if (pending !== null) return;
    setPending(key);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (actionError) {
      setError(errorText(actionError));
    } finally {
      setPending(null);
    }
  }
  function updateConfigDraft(field: ConfigField, value: string): void {
    setDrafts((current) => ({ ...current, [field]: value }));
    setConfigErrors((current) => ({ ...current, [field]: null }));
  }
  async function saveConfigField(field: ConfigField): Promise<void> {
    if (config === null || pending !== null) return;
    let update: AccountPoolConfigSetInput;
    if (field === "switchThreshold") {
      const raw = drafts.switchThreshold.trim();
      const value = Number(raw);
      if (
        raw.length === 0 ||
        !Number.isFinite(value) ||
        value <= 0 ||
        value > 1
      ) {
        setConfigErrors((current) => ({
          ...current,
          switchThreshold: "Must be greater than 0 and at most 1.",
        }));
        return;
      }
      if (value === config.switchThreshold) return;
      update = { switchThreshold: value };
    } else {
      const value = drafts[field].trim();
      const validationError = httpUrlError(value);
      if (validationError !== null) {
        setConfigErrors((current) => ({
          ...current,
          [field]: validationError,
        }));
        return;
      }
      if (value === config[field]) return;
      update =
        field === "anthropicUpstreamBaseUrl"
          ? { anthropicUpstreamBaseUrl: value }
          : { codexUpstreamBaseUrl: value };
    }
    setPending(`config-${field}`);
    setConfigErrors((current) => ({ ...current, [field]: null }));
    try {
      applyConfig(await rpc.call("config.set", update));
    } catch (saveError) {
      setConfigErrors((current) => ({
        ...current,
        [field]: errorText(saveError),
      }));
    } finally {
      setPending(null);
    }
  }
  async function startClaude(
    target: AccountSummary | null = null,
  ): Promise<void> {
    setDialog({ kind: "claude-login", accountId: target?.id ?? null });
    setLoginDone(null);
    setLoginStep(null);
    await run("claude-login", async () => {
      const started = await rpc.call(
        "login.start",
        target === null ? null : { accountId: target.id },
      );
      setLoginStep(started);
      setPastedCode("");
      setAccountLabel("");
    });
  }
  async function startCodex(
    target: AccountSummary | null = null,
  ): Promise<void> {
    setDialog({ kind: "codex-login", accountId: target?.id ?? null });
    setLoginDone(null);
    setCodexStep(null);
    await run("codex-login", async () => {
      setAccountLabel("");
      setCodexStep(
        await rpc.call(
          "codexLogin.start",
          target === null ? null : { accountId: target.id },
        ),
      );
    });
  }
  async function chooseAdd(
    provider: PoolProvider,
    choice: AddChoice,
  ): Promise<void> {
    if (choice === "login") {
      if (provider === "claude") await startClaude();
      else await startCodex();
      return;
    }
    if (choice === "api-key") {
      setDialog({ kind: "api-key" });
      return;
    }
    await run(`import-${provider}`, async () => {
      await rpc.call("account.add", {
        provider,
        source: { kind: "import" },
        label: null,
      });
    });
  }
  async function renameAccount(
    account: AccountSummary,
    label: string,
  ): Promise<void> {
    await run(`rename-${account.id}`, async () => {
      await rpc.call("account.rename", { id: account.id, label });
    });
  }
  async function accountAction(
    account: AccountSummary,
    action: SubscriptionAction,
  ): Promise<void> {
    if (action === "details") {
      setDialog({ kind: "account", accountId: account.id });
      return;
    }
    if (action === "priority") {
      setPriority(String(account.priority));
      setDialog({ kind: "priority", accountId: account.id });
      return;
    }
    if (action === "remove") {
      setDialog({ kind: "remove", accountId: account.id });
      return;
    }
    if (action === "sign-in") {
      if (account.provider === "claude") await startClaude(account);
      else await startCodex(account);
      return;
    }
    if (
      action === "toggle" &&
      account.enabled &&
      enabledTwins(account).length > 0
    ) {
      setDialog({ kind: "turn-off", accountId: account.id });
      return;
    }
    await run(`${action}-${account.id}`, async () => {
      if (action === "toggle")
        await rpc.call(account.enabled ? "account.disable" : "account.enable", {
          id: account.id,
        });
      if (action === "refresh")
        await rpc.call("account.refreshUsage", { accountId: account.id });
    });
  }
  async function reorderAccounts(
    provider: PoolProvider,
    event: DragEndEvent,
  ): Promise<void> {
    if (pending !== null || event.over === null) return;
    const records = accounts.filter((account) => account.provider === provider);
    const ids = foldSubscriptions(records).map((account) => account.id);
    const from = ids.findIndex((id) => id === event.active.id);
    const to = ids.findIndex((id) => id === event.over?.id);
    if (from < 0 || to < 0 || from === to) return;
    const reordered = arrayMove(ids, from, to);
    const shown = new Set(ids);
    let slot = 0;
    const accountIds = records.map((account) => {
      if (!shown.has(account.id)) return account.id;
      slot += 1;
      return reordered[slot - 1] ?? account.id;
    });
    setOptimisticOrder({ provider, ids: reordered });
    try {
      await run(`order-${provider}`, async () => {
        await rpc.call("account.reorder", { provider, accountIds });
      });
    } finally {
      setOptimisticOrder(null);
    }
  }
  function closeDialog(): void {
    if (dialog?.kind === "codex-login" && codexStep !== null)
      void rpc.call("codexLogin.cancel", { sessionId: codexStep.sessionId });
    setDialog(null);
    setLoginStep(null);
    setCodexStep(null);
    setLoginDone(null);
    setPastedCode("");
    setAccountLabel("");
    setError(null);
  }
  const hubHosts =
    status?.hosts.map((host) => host.hostName ?? host.hostId).join(", ") ||
    "no machines";
  const parent = status?.parent ?? null;
  const proxying = parent !== null && parent.mode === "proxy";
  return (
    <div className="w-full space-y-6">
      {parent === null ? null : (
        <div className="rounded-lg border border-border px-4 py-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">
                {proxying
                  ? "Using the parent Account Pooler"
                  : "Parent Account Pooler available"}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {parentBannerBody(parent)}
              </p>
            </div>
            <Switch
              checked={proxying}
              disabled={pending !== null}
              aria-label="Use the parent Account Pooler"
              onCheckedChange={(enabled) =>
                void run("parent-mode", async () => {
                  await rpc.call("config.set", {
                    parentMode: enabled ? "proxy" : "isolate",
                  });
                })
              }
            />
          </div>
        </div>
      )}
      <div
        className={proxying ? "space-y-6 opacity-50" : "space-y-6"}
        inert={proxying ? true : undefined}
      >
        {error === null ? null : (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-surface-destructive px-3 py-2 text-sm text-destructive-text"
          >
            {error}
          </div>
        )}
        <section className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">
                Subscriptions
              </h2>
              <p className="mt-0.5 max-w-xl text-xs leading-snug text-subtle-foreground/75">
                Plans bb can send with. New conversations go to the subscription
                with the most headroom, and each conversation stays on its
                subscription.
              </p>
            </div>
            <div className="shrink-0 self-start">
              <AddSubscriptionMenu
                onChoose={(provider, choice) =>
                  void chooseAdd(provider, choice)
                }
              />
            </div>
          </div>
          <div className="@container divide-y divide-border overflow-hidden rounded-lg border border-border">
            {status === null ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                Loading…
              </p>
            ) : !statusIsCached && accounts.length === 0 ? (
              <div className="px-5 py-6 text-center">
                <h3 className="text-sm font-semibold text-foreground">
                  No subscriptions in the pool
                </h3>
                <p className="mx-auto mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">
                  Add a Claude or Codex subscription and threads on every
                  machine will route through it. Your machine&apos;s own login
                  keeps working until then.
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <Button size="sm" onClick={() => void startClaude()}>
                    Sign in to Claude
                  </Button>
                  <Button size="sm" onClick={() => void startCodex()}>
                    Sign in to Codex
                  </Button>
                </div>
              </div>
            ) : null}
            {PROVIDERS.map((provider) => {
              const serverAccounts = foldSubscriptions(
                accounts.filter((account) => account.provider === provider.id),
              );
              if (serverAccounts.length === 0) return null;
              const order =
                optimisticOrder?.provider === provider.id
                  ? optimisticOrder.ids
                  : null;
              const providerAccounts =
                order !== null &&
                order.length === serverAccounts.length &&
                serverAccounts.every((account) => order.includes(account.id))
                  ? order.flatMap((id) =>
                      serverAccounts.filter((account) => account.id === id),
                    )
                  : serverAccounts;
              const on = providerAccounts.filter(
                (account) => account.enabled,
              ).length;
              const needs = providerAccounts.filter(
                (account) => account.signInExpired,
              ).length;
              const groupSummary = `${providerAccounts.length} subscription${providerAccounts.length === 1 ? "" : "s"} · ${on} on${needs === 0 ? "" : ` · ${needs} need${needs === 1 ? "s" : ""} sign-in`}`;
              return (
                <div
                  key={provider.id}
                  role="group"
                  aria-label={`${provider.title} subscriptions`}
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 pb-2 pt-2.5 @[40rem]:px-4">
                    <h3 className="text-sm font-medium text-foreground">
                      {provider.title}
                    </h3>
                    <span className="order-3 basis-full text-xs text-subtle-foreground @[40rem]:order-none @[40rem]:basis-auto">
                      {groupSummary}
                    </span>
                    <span className="flex-1" />
                    <span className="inline-flex items-center gap-2 whitespace-nowrap text-xs text-subtle-foreground">
                      Route {provider.title} threads
                      <Switch
                        checked={status?.routing[provider.id] ?? true}
                        disabled={pending !== null}
                        aria-label={`Route ${provider.title} threads`}
                        onCheckedChange={(enabled) =>
                          void run(`routing-${provider.id}`, async () => {
                            await rpc.call("routing.set", {
                              provider: provider.id,
                              enabled,
                            });
                          })
                        }
                      />
                    </span>
                  </div>
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    modifiers={accountDragModifiers}
                    onDragEnd={(event) =>
                      void reorderAccounts(provider.id, event)
                    }
                  >
                    <SortableContext
                      items={providerAccounts.map((account) => account.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div>
                        {providerAccounts.map((account) => (
                          <SubscriptionRow
                            key={account.id}
                            account={account}
                            state={subscriptionState(
                              account,
                              threshold,
                              status?.routing.claude === false
                                ? null
                                : nextSubscriptionId,
                            )}
                            pending={pending !== null}
                            refreshing={
                              statusIsCached ||
                              pending === `refresh-${account.id}`
                            }
                            reorderDisabled={providerAccounts.length < 2}
                            onAction={(action) =>
                              void accountAction(account, action)
                            }
                            onRename={(label) =>
                              void renameAccount(account, label)
                            }
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                </div>
              );
            })}
            {localLogins.length === 0 ? null : (
              <div role="group" aria-label="On this Mac">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 pb-2 pt-2.5 @[40rem]:px-4">
                  <h3 className="text-sm font-medium text-foreground">
                    On this Mac
                  </h3>
                  <span className="text-xs text-subtle-foreground">
                    Signed in directly, not in the pool
                  </span>
                </div>
                {localLogins.map((login) => (
                  <LocalLoginRow
                    key={`${login.providerId}:${login.email ?? ""}`}
                    login={login}
                    pending={pending !== null}
                    onAdd={(provider) => void chooseAdd(provider, "import")}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
        <p className="text-xs text-subtle-foreground/75">
          Hub {status?.accepting ? "accepting" : "not accepting"} ·{" "}
          {status?.inFlight ?? 0} in flight · used by {hubHosts}
          {statusIsCached ? " · refreshing…" : null}
        </p>
        <Collapsible className="rounded-lg border border-border px-4">
          <CollapsibleTrigger className="flex w-full items-center gap-2 py-2.5 text-sm font-medium text-foreground">
            <Icon
              name="ChevronRight"
              className="size-4 transition-transform [[data-state=open]>&]:rotate-90"
            />
            Advanced
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="divide-y divide-border border-t border-border">
              <ConfigFieldRow
                label="Anthropic upstream base URL"
                description="QA override for Anthropic traffic."
                error={configErrors.anthropicUpstreamBaseUrl}
              >
                <Input
                  aria-label="Anthropic upstream base URL"
                  aria-invalid={
                    configErrors.anthropicUpstreamBaseUrl === null
                      ? undefined
                      : true
                  }
                  disabled={config === null || pending !== null}
                  value={drafts.anthropicUpstreamBaseUrl}
                  onChange={(event) =>
                    updateConfigDraft(
                      "anthropicUpstreamBaseUrl",
                      event.target.value,
                    )
                  }
                  onBlur={() =>
                    void saveConfigField("anthropicUpstreamBaseUrl")
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </ConfigFieldRow>
              <ConfigFieldRow
                label="Codex upstream base URL"
                description="QA override for ChatGPT Codex traffic."
                error={configErrors.codexUpstreamBaseUrl}
              >
                <Input
                  aria-label="Codex upstream base URL"
                  aria-invalid={
                    configErrors.codexUpstreamBaseUrl === null
                      ? undefined
                      : true
                  }
                  disabled={config === null || pending !== null}
                  value={drafts.codexUpstreamBaseUrl}
                  onChange={(event) =>
                    updateConfigDraft(
                      "codexUpstreamBaseUrl",
                      event.target.value,
                    )
                  }
                  onBlur={() => void saveConfigField("codexUpstreamBaseUrl")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </ConfigFieldRow>
              <ConfigFieldRow
                label="Quota switch threshold"
                description="Stop selecting an account at this quota fraction."
                error={configErrors.switchThreshold}
              >
                <Input
                  type="number"
                  min="0.01"
                  max="1"
                  step="0.01"
                  aria-label="Quota switch threshold"
                  aria-invalid={
                    configErrors.switchThreshold === null ? undefined : true
                  }
                  disabled={config === null || pending !== null}
                  value={drafts.switchThreshold}
                  onChange={(event) =>
                    updateConfigDraft("switchThreshold", event.target.value)
                  }
                  onBlur={() => void saveConfigField("switchThreshold")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </ConfigFieldRow>
              <div className="flex items-start justify-between gap-4">
                <div className="py-2.5">
                  <div className="text-sm text-foreground">Machine tokens</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {hubHosts}
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2 py-2.5">
                  {status?.hosts.map((host) => (
                    <Button
                      key={host.hostId}
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void run(`rotate-${host.hostId}`, async () => {
                          await rpc.call("token.rotate", {
                            machine: host.hostId,
                          });
                        })
                      }
                    >
                      Rotate {host.hostName ?? host.hostId}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        {dialog?.kind === "account" && selectedAccount !== null ? (
          <AccountDialog
            account={selectedAccount}
            threshold={threshold}
            act={(action) => void accountAction(selectedAccount, action)}
          />
        ) : null}
        {dialog?.kind === "priority" && selectedAccount !== null ? (
          <DialogFrame
            title="Set priority"
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  disabled={
                    !Number.isInteger(Number(priority)) || pending !== null
                  }
                  onClick={() =>
                    void run(`priority-${selectedAccount.id}`, async () => {
                      await rpc.call("account.setPriority", {
                        accountId: selectedAccount.id,
                        priority: Number(priority),
                      });
                      setDialog(null);
                    })
                  }
                >
                  Save
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              Lower numbers come first in the failover order. Ties follow the
              order accounts were added. Existing conversations stay pinned.
            </p>
            <Input
              type="number"
              aria-label="Account priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </DialogFrame>
        ) : null}
        {dialog?.kind === "api-key" ? (
          <DialogFrame
            title="Add an Anthropic API key"
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  disabled={apiKey.trim().length === 0 || pending !== null}
                  onClick={() =>
                    void run("api-key", async () => {
                      await rpc.call("account.add", {
                        provider: "claude",
                        source: { kind: "api-key", apiKey: apiKey.trim() },
                        label: null,
                      });
                      setApiKey("");
                      setDialog(null);
                    })
                  }
                >
                  Add API key
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              Metered fallback stored in the Account Pooler&apos;s protected
              secret directory.
            </p>
            <Input
              type="password"
              autoComplete="off"
              aria-label="Anthropic API key"
              placeholder="sk-ant-…"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </DialogFrame>
        ) : null}
        {dialog?.kind === "remove" && selectedAccount !== null ? (
          <DialogFrame
            title={`Remove ${selectedAccount.label}?`}
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={pending !== null}
                  onClick={() =>
                    void run(`remove-${selectedAccount.id}`, async () => {
                      await rpc.call("account.remove", {
                        id: selectedAccount.id,
                      });
                      setDialog(null);
                    })
                  }
                >
                  Remove
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              {removeCopy(selectedAccount)}
            </p>
          </DialogFrame>
        ) : null}
        {dialog?.kind === "turn-off" && selectedAccount !== null ? (
          <DialogFrame
            title={`Turn off ${selectedAccount.label}?`}
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  disabled={pending !== null}
                  onClick={() =>
                    void run(`toggle-${selectedAccount.id}`, async () => {
                      await rpc.call("account.disableSubscription", {
                        id: selectedAccount.id,
                      });
                      setDialog(null);
                    })
                  }
                >
                  Turn off all
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              {turnOffCopy(selectedAccount, enabledTwins(selectedAccount))}
            </p>
          </DialogFrame>
        ) : null}
        {dialog?.kind === "claude-login" ? (
          <LoginDialog
            provider="claude"
            target={selectedAccount}
            loginStep={loginStep}
            codexStep={null}
            loginDone={loginDone}
            pending={pending !== null}
            pastedCode={pastedCode}
            countdown={0}
            error={error}
            close={closeDialog}
            openUrl={navigate.openUrl}
            setPastedCode={setPastedCode}
            accountLabel={accountLabel}
            setAccountLabel={setAccountLabel}
            complete={() =>
              void run("complete-claude", async () => {
                if (loginStep === null) return;
                const added = await rpc
                  .call("login.complete", {
                    sessionId: loginStep.sessionId,
                    pasted: pastedCode,
                    ...(selectedAccount !== null || accountLabel.trim() === ""
                      ? {}
                      : { label: accountLabel.trim() }),
                  })
                  .catch((completeError: unknown) => {
                    setLoginStep(null);
                    throw completeError;
                  });
                setPastedCode("");
                setLoginDone(added.label);
                setLoginStep(null);
              })
            }
            restart={() => void startClaude(selectedAccount)}
          />
        ) : null}
        {dialog?.kind === "codex-login" ? (
          <LoginDialog
            provider="codex"
            target={selectedAccount}
            loginStep={null}
            codexStep={codexStep}
            loginDone={loginDone}
            pending={pending !== null}
            pastedCode=""
            countdown={countdown}
            error={error}
            close={closeDialog}
            openUrl={navigate.openUrl}
            setPastedCode={() => {}}
            accountLabel={accountLabel}
            setAccountLabel={setAccountLabel}
            complete={() => {}}
            restart={() => void startCodex(selectedAccount)}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

function AccountDialog({
  account,
  threshold,
  act,
}: {
  account: AccountSummary;
  threshold: number;
  act: (action: "toggle" | "refresh" | "remove") => void;
}) {
  const shared = (
    utilization: number | null,
    resetAt: number | null,
    status: string | null,
  ): FamilyQuota => ({
    utilization,
    resetAt,
    status,
    observedAt: account.observedAt ?? 0,
    source: "header",
  });
  const providerId =
    account.provider === "claude"
      ? account.accountUuid
      : account.codexAccountId;
  const plan = planBadge(account);
  return (
    <DialogFrame
      title={account.label}
      className="sm:max-w-xl"
      footer={
        <>
          <Button size="sm" variant="outline" onClick={() => act("toggle")}>
            {account.enabled ? "Disable" : "Enable"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => act("refresh")}>
            Refresh usage
          </Button>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive-text"
            onClick={() => act("remove")}
          >
            Remove
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2">
        {plan === null ? null : <SettingsBadge>{plan}</SettingsBadge>}
        <StateWord state={subscriptionState(account, threshold, null)} />
      </div>
      <div className="space-y-4">
        {account.provider === "codex" ? (
          account.limitWindows.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No usage limits observed yet.
            </div>
          ) : (
            account.limitWindows.map((window) => (
              <QuotaDetail
                key={window.slot}
                label={windowLongLabel(window)}
                quota={window}
                threshold={threshold}
              />
            ))
          )
        ) : (
          <>
            <QuotaDetail
              label="5 hour"
              quota={shared(
                account.fiveHourUtilization,
                account.fiveHourResetAt,
                account.fiveHourStatus,
              )}
              threshold={threshold}
            />
            <QuotaDetail
              label="7 day"
              quota={shared(
                account.sevenDayUtilization,
                account.sevenDayResetAt,
                account.sevenDayStatus,
              )}
              threshold={threshold}
            />
            {modelFamilySchema.options.flatMap((family) =>
              account.familyWeekly[family] === null
                ? []
                : [
                    <QuotaDetail
                      key={family}
                      label={FAMILY_LABELS[family]}
                      quota={account.familyWeekly[family]}
                      threshold={threshold}
                    />,
                  ],
            )}
          </>
        )}
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 border-t border-border pt-4 text-sm">
        {account.email === null ? null : (
          <>
            <dt className="text-muted-foreground">Email</dt>
            <dd className="break-all">{account.email}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Kind</dt>
        <dd>
          {account.kind === "oauth"
            ? `OAuth · ${account.provider === "claude" ? "claude.ai" : "ChatGPT"}`
            : "API key"}
        </dd>
        <dt className="text-muted-foreground">Priority</dt>
        <dd>{account.priority}</dd>
        <dt className="text-muted-foreground">Last used</dt>
        <dd>
          {account.lastUsedAt === null
            ? "Never"
            : `${relative(account.lastUsedAt)}${account.lastUsedHostName === null ? "" : ` · ${account.lastUsedHostName}`}`}
        </dd>
        <dt className="text-muted-foreground">Usage refreshed</dt>
        <dd>
          {account.observedAt === null ? "Never" : relative(account.observedAt)}
        </dd>
        {account.extraUsage === null ? null : (
          <>
            <dt className="text-muted-foreground">Extra usage</dt>
            <dd>
              {account.extraUsage.status === "allowed"
                ? "Available"
                : "Not available"}
            </dd>
          </>
        )}
        {providerId === null || providerId === undefined ? null : (
          <>
            <dt className="text-muted-foreground">Account id</dt>
            <dd className="font-mono text-xs">{`${providerId.slice(0, 4)}…${providerId.slice(-4)}`}</dd>
          </>
        )}
      </dl>
    </DialogFrame>
  );
}

function LoginDialog({
  provider,
  target,
  loginStep,
  codexStep,
  loginDone,
  pending,
  pastedCode,
  countdown,
  error,
  close,
  openUrl,
  setPastedCode,
  accountLabel,
  setAccountLabel,
  complete,
  restart,
}: {
  provider: PoolProvider;
  target: AccountSummary | null;
  loginStep: OAuthLoginStart | null;
  codexStep: CodexDeviceLoginStart | null;
  loginDone: string | null;
  pending: boolean;
  pastedCode: string;
  countdown: number;
  error: string | null;
  close: () => void;
  openUrl: (url: string) => boolean;
  setPastedCode: (value: string) => void;
  accountLabel: string;
  setAccountLabel: (value: string) => void;
  complete: () => void;
  restart: () => void;
}) {
  const name = provider === "claude" ? "Claude" : "Codex";
  const service = provider === "claude" ? "Claude" : "ChatGPT";
  const url =
    provider === "claude"
      ? loginStep?.authorizeUrl
      : codexStep?.verificationUri;
  return (
    <DialogFrame
      title={target === null ? `Sign in to ${name}` : "Sign in again"}
      className="sm:max-w-xl"
      footer={
        loginDone !== null ? (
          <>
            <span className="flex-1" />
            {target === null ? (
              <Button variant="outline" onClick={restart}>
                Add another
              </Button>
            ) : null}
            <Button onClick={close}>Done</Button>
          </>
        ) : provider === "claude" ? (
          <>
            <span className="flex-1" />
            <Button
              disabled={
                loginStep === null || pastedCode.trim().length === 0 || pending
              }
              onClick={complete}
            >
              Complete
            </Button>
          </>
        ) : null
      }
    >
      <StepIndicator step={loginDone === null ? 2 : 3} />
      {loginDone !== null ? (
        <div>
          <h3 className="text-base font-semibold">
            {target === null
              ? `Connected ${loginDone}`
              : `Signed in again to ${loginDone}`}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {target === null
              ? `${name} threads on every machine now route through this account. Usage refreshes in the background.`
              : target.enabled
                ? `${name} threads can use it again. Usage refreshes in the background.`
                : "It stays off until you turn it on."}
          </p>
        </div>
      ) : url === undefined ? (
        error !== null ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-destructive-text">
              {error}
            </p>
            <Button variant="outline" onClick={restart}>
              Try again
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Starting sign-in…</p>
        )
      ) : (
        <>
          {target === null ? null : (
            <p className="text-sm text-foreground">
              Sign in to {service} as the account behind{" "}
              <span className="font-semibold">{target.label}</span>. bb keeps
              its name{provider === "claude" ? ", plan" : ""} and place in the
              list.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {provider === "claude"
              ? "Sign in at claude.ai, then paste the code from the final page."
              : "Open the verification page, sign in to ChatGPT, and enter this code."}
          </p>
          {codexStep === null ? null : (
            <UserCodeBlock userCode={codexStep.userCode} />
          )}
          <AuthorizationUrlRow name={name} url={url} openUrl={openUrl} />
          {target === null ? (
            <>
              <Input
                aria-label="Account label"
                placeholder={`Optional ${name} account label`}
                value={accountLabel}
                onChange={(event) => setAccountLabel(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Use a private window or sign in to the account you want to add.
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              If {provider === "claude" ? "the code belongs" : "you sign in"} to
              a different {service} account, bb stops and keeps this
              subscription as it is.
            </p>
          )}
          {provider === "claude" ? (
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label="Claude authorization code"
              placeholder="Paste code#state here"
              value={pastedCode}
              onChange={(event) => setPastedCode(event.target.value)}
            />
          ) : (
            <p className="text-center text-sm text-muted-foreground">
              Waiting for you to authorize… expires in{" "}
              {Math.floor(countdown / 60)}:
              {String(countdown % 60).padStart(2, "0")}
            </p>
          )}
        </>
      )}
    </DialogFrame>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "subscription",
    scopes: ["new-thread", "thread"],
    experimental_modelPicker: SubscriptionPicker,
  });
  app.slots.settingsSection({
    id: "accounts",
    component: AccountPoolSettings,
  });
});
