Use the model menu's Subscription selector or
`bb pool select <thread-id> <claude|codex> [<account-id>|automatic]` to read or
choose an account for one conversation. Automatic is the default. Explicit
choices never silently fail over and do not reorder the pool. Existing-thread
changes require an idle or failed conversation with no queued messages. The
read/write RPCs are `routing.selection.get` and `routing.selection.set`;
their inputs are `{threadId, provider}` and `{threadId, provider, accountId}`,
where `accountId: null` restores Automatic. For new threads, use the
`experimental_pluginCreateData: {"account-pool": {provider: "claude", accountId: "<uuid>"}}`
field with `threads.spawn`, or pass that JSON to `bb thread spawn --plugin-create-data`.
This persists the pin before Fleet's initial admission check. The same draft
data works for ordinary Enter/button sends and programmatic composer submissions.
No entry means Automatic. Choices require a local pool; choose Automatic when
proxying a parent pool. For native terminals, the hub resolves the conversation's
current account choice at the start of each request. A retained bridge credential
keeps the account chosen when it was issued; a new bridge turn's credential uses
the current selection. A request already in flight keeps its choice. Native Codex launches use the same
environment-backed provider configuration as chat turns; no token is passed in
command arguments. Native launch credentials live only in the server process. Existing scoped
credential files are converted to SHA-256 digests at startup; bridge credentials
remain reusable for authentication across restarts through these digests. Older
builds discard digest-only records and reissue a token on the next chat turn or
thread start. Reopen a native terminal after downgrading.
Reopen the terminal after a server restart to obtain a new credential. Machine
token rotation also revokes derived conversation credentials after the existing
ten-minute grace period; reopen the terminal after that grace expires.

The builtin Account Pooler plugin is disabled by default. Enable it, add Claude
or Codex credentials, and inspect its proxy routes and account quota with:

```sh
bb plugin enable account-pool
bb pool account add --provider claude --login
printf '%s\n' "$CLAUDE_AUTH_CODE" | bb pool account login-complete --session <id> --code-stdin
bb pool account add --provider codex --login
bb pool account login-poll --session <id>
bb pool account add --provider claude --import
bb pool account add --provider codex --import
printf '%s\n' "$ANTHROPIC_API_KEY" | bb pool account add --provider claude --api-key-stdin [--label <text>] [--priority <n>]
bb pool account list [--json]
bb pool account local [--json]
bb pool account sign-in-again <id> [--json]
bb pool account rename <id> <label>
bb pool account remove <id>
bb pool account enable <id>
bb pool account disable <id> [--subscription]
bb pool account priority <id> <n>
bb pool account reorder <claude|codex> <id>...
bb pool account refresh <id>
bb pool status [--json]
bb pool routing <claude|codex> [--off]
bb pool config
bb pool config set <anthropicUpstreamBaseUrl|codexUpstreamBaseUrl|switchThreshold|parentMode> <value>
bb pool parent [proxy|isolate]
bb pool token rotate --machine <id-or-name>
bb pool bypass <thread-id> [--off]
bb pool bypass get <thread-id>
```

`bb pool bypass get <thread-id>` reads whether that thread currently bypasses
Account Pooler routing. It is read-only; `bb pool bypass <thread-id> [--off]`
continues to enable or disable the bypass.

Every command accepts `--json` and `--help`. `bb pool --help` lists the
commands; `bb pool <command> --help` prints that command's arguments, options,
and rules, including which flags cannot be combined. Unknown commands, unknown
flags, and stray arguments are rejected with the nearest suggestion rather than
ignored, and a failing invocation that carries `--json` also prints
`{"ok":false,"error":{"code","message","hint"}}` on stdout.

### One-time cleanup after upgrading

1. Delete Codex shell snapshots containing the pool credential variable names. The command prints only the matching file count. Run it for each affected `CODEX_HOME`, replacing the default directory below when needed:

   ```sh
   python3 - <<'PY'
   from pathlib import Path
   snapshots = Path.home() / ".codex" / "shell_snapshots"
   names = (b"CODEX_POOL_AUTH_TOKEN", b"BB_ACCOUNT_POOL_PARENT_TOKEN")
   files = [file for file in snapshots.glob("*.sh") if any(name in file.read_bytes() for name in names)]
   print(len(files))
   for file in files:
       file.unlink()
   PY
   ```

2. Rotate the existing pool token for every affected host:

   ```sh
   bb pool token rotate --machine <id-or-name>
   ```

   Rotation keeps the existing ten-minute grace. Reopen long-lived native terminals after rotation so they receive the new credential. The upgrade does not delete the user's snapshots or rotate host tokens automatically.

Pooled Codex native terminals and chat bridges exclude pool variables from model-run shell environments and their shell snapshots. Codex itself retains the credential in memory to authenticate pool requests.

The host reads `CODEX_HOME/config.toml` (default `~/.codex/config.toml`) without
changing it. Existing `shell_environment_policy.exclude`, `include_only`, and
canonical filters keep their restrictions. Invalid or conflicting policy shapes,
legacy top-level `profile`, or `set` entries that restore pool variables refuse a
pooled launch. Move a policy from `/etc/codex/config.toml`,
`/etc/codex/managed_config.toml`, or an ancestor `.codex/config.toml` to the user
file before using pooled launches. A present macOS managed-preference plist for
`com.openai.codex` also refuses pooled launches without reading its contents;
remove the managed source through its administrator. Errors name the file and
setting. Windows pooled launches are unsupported. Unpooled launches are unchanged.

The desktop app's Sign in buttons open the same URLs in a clean in-app window with an empty,
non-persistent session, so the browser's own claude.ai or ChatGPT account is never reused, and
finish the Claude login from the redirect; the CLI has no window, so it prints the URL.

Claude `--login` starts a PKCE session, prints a browser URL and session ID,
then exits. Pipe the manual callback code to `account login-complete` with that
session ID within ten minutes. Its command hint uses the absolute path of the
running bb executable. Codex `--login` prints a device verification
URL, one-time code, session ID, and an `account login-poll` command that waits
for authorization. OAuth codes and API keys must be piped through stdin, and either
browser may be on a different machine from the bb server. New accounts join the
end of the provider's priority order by default; rename them with
`bb pool account rename <id> <label>`. The plugin settings page offers the same
flows through **Add subscription**. Newly added or enabled accounts are
available without a plugin reload. With an
enabled account whose secret file remains readable and valid, matching Claude
Code or Codex sessions receive the pool route and a secret token scoped to
their thread. The machine token itself is never handed to an agent. Claude Code
also receives `ENABLE_TOOL_SEARCH=true`, so tool search stays on through the
pool, and `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`, so Opus keeps its 1M
context window instead of the 200k fallback for custom base URLs.
Codex receives `CODEX_OPENAI_BASE_URL` and the secret
`CODEX_POOL_AUTH_TOKEN`; bb applies them as in-memory app-server and native CLI config.
Codex image generation and editing use the same authenticated pool route.
Tokens are never printed. `status` prunes tokens for unenrolled machines and
shows token timestamps plus recently routed threads whose machines need a
local Claude login before the pool can be disabled safely. Rotation keeps the
prior token valid for ten minutes. Agents should pipe API keys to
`--api-key-stdin`; the CLI rejects inline secret values. Prefer `--import` for
an existing Claude Code login. The CLI Codex import path reads
`~/.codex/auth.json` on the bb server host. OAuth quota refreshes on add or
enable and every five minutes while an account is idle. When a request finds no
eligible account, the pool first refreshes the OAuth accounts it considers
exhausted, at most once every 30 seconds per account, so a plan upgrade or an
early reset takes effect on the next turn. Use
`bb pool account refresh <id>` to request an immediate refresh for one account.
For an OAuth account in error, `refresh` also forces a new token with the stored
refresh token and clears the error when that succeeds, so a spurious error does
not require logging in again.
An account enters error only when its OAuth refresh token is rejected (HTTP 400
or 401 from the token endpoint) or an API key is rejected. A rejected refresh
token sets `signInExpired` in account JSON and `expired` in the `account list`
Sign-in column, even while the account is disabled. Repair it with
`bb pool account sign-in-again <id>` (aliases `reauth`, `reauthorize`): it starts
the same Claude or Codex login as `add --login`, and the matching
`login-complete` or `login-poll` replaces that account's credential in place,
keeping its ID, label, priority, enabled state, and conversation choices. bb
refuses the sign-in, and leaves the account unchanged, when it belongs to a
different Claude account (account UUID, else email) or ChatGPT account, or when
neither login carries an identity it can compare. It also refuses a Claude
sign-in from a different organization when both organizations are known. bb
learns a Claude subscription's organization from its profile when it signs in
and when usage refreshes, and from `~/.claude.json` when `add --import` pools
this Mac's login. Account JSON reports it as `organizationUuid` (`null` until
known). API key
accounts cannot sign in again. The RPCs are `login.start` and
`codexLogin.start` with `{accountId}` instead of `null`.
`bb pool account local` (RPC `local.logins`) lists the bb server host's own
provider logins that are not in the pool, and which ones `add --import` can
pool. A Codex login's plan (such as ChatGPT Pro) comes from the
`chatgpt_plan_type` claim of the host's Codex tokens when their email matches
that login. A 401 or 403 on a
freshly refreshed OAuth token is treated as an upstream failure instead: the
request gets HTTP 503, and that token is held out of routing for one minute.
Account tables add columns for observed model-family buckets; JSON status
exposes their utilization, reset, status, observation time, and source under
`familyWeekly`. Selection skips an account whose requested family is spent
while retaining it for other families. A present `metadata.user_id` account
UUID is aligned with the selected OAuth account. Use `bb pool config` to
inspect the full routing configuration and
`bb pool config set <key> <value>` to update one value. The upstream URL keys
are QA-only overrides; `switchThreshold` must be greater than 0 and at most 1.

Automatic routing chooses the eligible account with the most headroom: the
minimum remaining quota across known five-hour, weekly, and applicable
model-family windows. Equal headroom prefers the account whose limiting quota
recovers more used quota per hour until reset, then the lower priority number.
The active account stays preferred while another account leads by less than 10
headroom points. Existing conversations keep their affinity until that account
becomes ineligible. Short temporary rate limits wait on the same account once;
longer holds return Retry-After for pinned conversations while new conversations
can use another eligible account. A model-family limit detours only requests for
that family without moving the session's main pin. Session pins survive hub
restarts, expire after 30 idle minutes, and the pool retains the 4,096 most
recently used pins.

Claude accounts with an exhausted subscription window remain eligible as a
fallback when Anthropic reports extra usage enabled with remaining allowance,
or an allowed overage response header. Accounts below the switch threshold
are preferred, including for conversations pinned to an extra-usage fallback;
those conversations return to subscription quota when it recovers. Before using
extra usage, the pool rechecks exhausted OAuth accounts (at most every 30 seconds).
Disabled, spent, or unobserved extra usage does not override subscription limits.
This does not enable extra usage or change spending limits on Claude.
`account list` and `status` show an Extra usage column; JSON and the corresponding
plugin RPCs expose `extraUsage` with status, observation time, and source.
This state survives hub restarts. Model entitlement differences between plans
are not inferred from missing quota buckets.

Codex credits use the same fallback policy and availability pill. The pool reads
`credits.has_credits` and `credits.unlimited` from usage responses and the
corresponding `x-codex-credits-*` headers. Credit-only updates are accepted;
omitted fields preserve prior observations. Workspace hard stops (the
`workspace_{owner,member}_{credits_depleted,usage_limit_reached}` limit types,
or a reached spend control) block routing even below the subscription switch
threshold and survive restarts. Other limit types, including unknown ones, do
not restrict the account. A refreshed allowance or spending-control observation can
clear the matching restriction. JSON account/status responses expose
`usageRestriction` (reason and optional reset time); the pool does not change
workspace spending controls or purchase credits. Availability is not current
billing activity.

Drag an account’s handle in Account Pooler settings (or focus the handle and use
Space, arrow keys, and Space again), or
`bb pool account reorder <claude|codex> <id>...`, to set the complete order for
one provider. Include disabled accounts too. For Claude, priority breaks ties
after headroom and reset recovery; for Codex, the order controls sequential
failover. Reordering does not move an existing conversation.

Account Pooler settings show one Subscriptions card. Each row has an on/off
switch (`enable`/`disable`), a name you rename in place (Enter saves, Escape
cancels), a plan badge from the stored tier, and a state word. A row whose
sign-in expired shows Sign in again instead of the switch. Its menu holds Usage
details, Refresh usage, Set priority, Sign in again, and Remove, which asks for
confirmation first. Below the pool, On this Mac lists `account local`.
A provider with no record in the pool has no section; its Route threads switch
(`bb pool routing <claude|codex> [--off]`) moves under Advanced.
Records that share a login fold into one subscription: Claude records with the
same email and organization (a record without an email joins the login with its
account UUID), and Codex records with the same email and ChatGPT account. A plan change never
splits a subscription. A Claude record whose organization is not known yet,
such as one whose sign-in expired, joins its login's subscription; when that
login has several known organizations, it joins the one with its plan. The
healthiest record (then the active one, then the most recently used) represents the subscription in settings, in
the provider usage sources, and in the Subscription selector. The selector
still shows a folded record while a conversation is set to it. The other records
stay in the pool and still appear in `account list`, `status`, and
`account reorder`. Dragging a row keeps folded records in their places.
A subscription's switch turns its representative on or off. When another record
of that subscription is still on and can send (its sign-in has not expired),
switching it off first asks, naming every enabled record,
and Turn off all disables every enabled record in one write so none of them
routes; Cancel changes nothing. Records already off are never touched, and
turning a subscription on enables only its representative.
`bb pool account disable <id> --subscription` (RPC
`account.disableSubscription`) does the same from the CLI and SDK; without
`--subscription`, `account disable` and `account enable` act on one record.
The RPC's optional `expectedIds` names the records the caller confirmed. The
check and the write happen in one step against the stored records, so when the
subscription's enabled records differ by then, it refuses and turns nothing off.
Which records share a subscription does not depend on list order or priority. Settings pass the names shown in the dialog, then show the
refusal and the updated list.
`bb pool account priority <id> <n>`
sets an individual priority; the same operations are available through the
`account.reorder` and `account.setPriority` plugin RPCs.

`bb pool status` and `bb pool account list` show each account's binding window,
headroom, reset recovery per hour, and the reason it was last selected
automatically. JSON includes these as `balance` and `lastAutomaticChoice`; the
same fields are returned by the SDK `status.get` method. New accounts are added
at the end of the provider's priority order unless an explicit priority is set.

The Fleet binding RPCs are read-only. `routing.binding.get` takes
`{threadId, provider: "claude"}` and returns `boundAccountId`, `nextAccountId`,
`reason`, and per-account `headroom` entries with the binding window, headroom,
reset recovery, contributing windows, and an `eligible` boolean. The list covers
every enabled Claude account, including accounts at the quota threshold.
`routing.binding.next` takes
`{provider: "claude"}` and returns only `nextAccountId` and `reason`. Inputs
reject extra fields and invalid thread IDs. Older cores return `unknown_method`
for these methods.

The Fleet preview currently evaluates model-neutral quota windows. A request
family is not part of these RPC inputs, so a family-specific quota may change
the account selected for an actual request.

## Nested bb servers

A bb server started from inside another bb server's thread inherits that parent's
pooler routing through its environment. The parent contributes
`BB_ACCOUNT_POOL_PARENT_URL` and `BB_ACCOUNT_POOL_PARENT_TOKEN` alongside the
provider routing variables, and the nested server enables the pooler on first run
when it sees them. The token is scoped to the launching thread, is accepted only
for pooled provider requests and `/availability`. It is suspended while that
thread is archived and works again, unchanged, once the thread is unarchived;
it ends for good when the thread is deleted, or ten minutes after the machine
token is rotated. Archiving never deletes a thread's credentials: the plugin
keeps their digests on disk behind an archive marker, so a crash at any point
of an archive or unarchive cannot cost a running session its token. If no
archive marker can be written, the thread's credential files are renamed to
`suspended-<name>`, keeping their content, and renamed back on unarchive. Only
deleting the thread removes its credentials; a credential otherwise ends only
by its own expiry or a machine-token rotation. Deletion is final: the plugin
records it in a `deleted-thread-<digest>.json` marker and in the thread's
archive marker and its fallback. If the marker cannot be written atomically,
it is created in place, and failing that the plugin creates a
`deleted-thread-<digest>.d` directory, which records the deletion by its
existence alone. If none of those lands, each credential file is renamed to
`deleted-pending-<digest>-<name>`; that rename is itself a record. A
filesystem record counts only once its content write, the file sync and the
sync of the store directory all succeed; any failure on the way moves on to the
next path. At start, a deletion marker found on disk counts only if its content
is complete and syncing it and the directory succeeds; a partial, empty or
unreadable `deleted-thread-<digest>.json` keeps the thread deleted, blocking
restore and mint, but removes nothing and the record is written again. Then,
every time, the plugin also writes a `deleted-thread:<digest>` row to bb's own
database through plugin kv, the database that already holds the thread's
committed `deletedAt`. Every filesystem path is tried before the kv write, so
a refused kv write followed by a crash never leaves a filesystem record
untried. The plugin never restores or mints credentials for that thread
again, even if bb later reports it live, in which case it logs a warning.
Credentials are never removed before a deletion record is durable, and the kv
row lands before the first credential removal whenever kv accepts it. A
pending file is removed only once a record of another kind exists. Where the
rename also fails the file stays untouched. Either way the thread stays
deleted in the running process, and the record, then the removal, is retried
on the next delete event, sweep and start. The kv rows are loaded once at
start; while that load fails, every thread token is rejected and nothing is
minted, and the load is retried on each sweep. Authentication never reads kv.
There is no residual: bb commits a thread's deletion before the plugin hears of
it, so after a committed delete bb answers gone, and every mint, env export and
authentication asks bb, even when none of the plugin's own records survived.
bb's thread state is the authority, asked each time a thread's token is
presented and before every credential is minted or exported (concurrent
requests for one thread share one lookup): live accepts, archived rejects and
suspends, deleted rejects and revokes. A mint or export while bb cannot answer
is refused, like a token. A missed archive or unarchive event therefore
takes effect on the next request. If bb's lookup fails or times out (one retry
on failure, none on timeout), the token is rejected with 401 and nothing is
deleted or suspended; the same token works again once bb answers live. The
plugin logs a warning naming the thread, at most once a minute per thread. It
also checks every thread holding
credentials at startup and every 15 minutes. A nested server
started before this scoping existed holds the machine token, which the hub no
longer accepts; relaunch it so it receives a scoped token.

The nested token is scoped to the thread, not to a provider or an account. It
reaches both providers' pooled routes, ignores the thread's pinned account and
bypass setting, and stays in the environment a nested server's threads inherit
even when that server isolates or cannot route.

`bb pool parent` reports the detected parent, the current mode, and which
providers the parent can serve. `bb pool parent proxy` and `bb pool parent
isolate` set the mode; `bb pool config` shows it as `parentMode`.

In `proxy` mode the nested server runs its own hub and mints its own machine
tokens, forwarding pooled traffic upstream with the parent's token, so the
parent's token is never handed to the nested server's agents. It reads the
parent's `/availability` endpoint and contributes routing only for providers the
parent can actually serve; if the parent is unreachable it contributes nothing
and neutralises the inherited values rather than pointing agents at a dead hub.

In `isolate` mode the nested server contributes empty routing variables, which
overrides the inherited values so threads fall back to that instance's own
accounts or to each provider's own credentials.

Proxied traffic authenticates with the nested token of the launching thread and
is attributed to that thread's machine, so `bb pool status` on the parent
attributes it to the parent host rather than to the nested instance.

## Claude Artifacts

Claude Code offers `Artifact` only in a claude.ai account session, and it refuses every call while `ANTHROPIC_AUTH_TOKEN` is set. A pooled Claude thread on a pool with at least one subscription account therefore signs in with its pool token as `CLAUDE_CODE_OAUTH_TOKEN` and gets `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS` and `CLAUDE_CODE_ARTIFACT=1`. It sets no `NO_PROXY`, so a value already in the thread keeps working. Inference keeps using the hub base URL.

Claude Code sends Artifact, policy and feature-flag requests straight to `https://api.anthropic.com` and ignores `ANTHROPIC_BASE_URL` for them, so the plugin's `bb.host` entry runs a proxy on `127.0.0.1` of each thread's host:

- Every `CONNECT` must carry the thread's proxy credential (`Proxy-Authorization`), an HMAC the server derives from the pool token with a per-server secret; it buys tunnel use only and is never accepted by the hub. Anything else gets 407. The server sends each host the complete set of active credentials whenever a thread token is issued, archived, deleted or dropped and once a minute; the host replaces its set and closes the tunnels of any removed credential, so a revoked thread's credential gets 407 on its next `CONNECT`. Each successful send also renews a 3-minute lease on the host: if no send succeeds for 3 minutes, the host answers 407 to every credential and closes its tunnels until the next send restores the active ones. A failed send is retried once after 2 seconds. Other hosts are tunnelled directly from that host.
- `api.anthropic.com:443` is terminated with a 7-day leaf certificate. Only `/api/frame/*`, the Artifact MCP endpoint `/api/artifacts/mcp` (GET and POST, no query), the policy lookup, feature flags and bootstrap are relayed to the hub route `POST /claude-oauth`; `settings` answers 404 and telemetry 204 locally; everything else is 403. The hub re-checks host, method and path against the same allowlist, swaps the pool token for the selected subscription account's access token (refreshing it, and retrying once on 401), and never forwards the pool token.
- The certificate authority lives on the server in `secrets/proxy-ca` (key mode 0600) and is limited to `api.anthropic.com` by a critical name constraint. Hosts receive only the CA certificate (written to the plugin data directory) and their own leaf certificate and key, which the host worker keeps in memory only and the server resends when the worker restarts. Minting needs the system `openssl` command; without it, or when the host proxy cannot start, threads keep the plain pool credentials and `Artifact` stays unavailable.
- Pools with only API keys, nested servers that proxy to a parent pool, and Codex are unchanged. Any thread on the pool can PATCH or DELETE `/api/frame/*` artifacts of the shared account, which is accepted for a single-owner pool. Artifacts belong to the account that published them, so a conversation moved to another account cannot see the earlier ones.
- The hub logs one info line per relayed request, `Account Pooler relayed <method> <route> -> upstream <status> in <n>ms`, or `-> upstream=error <ErrorClass> in <n>ms` when the upstream fetch threw and no status was received (the client gets a pool-generated 502; the line carries the error class name only, never its message), where `<route>` is the matched allowlist pattern (`/api/frame/*`, `/api/eval/sdk-*` or the exact endpoint), never the requested path: no path segments, query values, headers or bodies. A refused request (403 above) is not relayed and logs no such line.

Known upstream limitation: the `claude-artifacts` MCP server that Claude Code 2.1.311 and 2.1.312 starts for `https://api.anthropic.com/api/artifacts/mcp` fails with `Connection failed (404): Error POSTing to endpoint: not found`, in direct unpooled sessions (`HTTP_PROXY`/`HTTPS_PROXY` unset) as well as pooled ones. The 404 comes from Anthropic, not from the pool: the hub relays the upstream status and body unchanged. Publish Claude documents through the built-in `Artifact` tool, which is unaffected and works through the pool; do not rely on the `claude-artifacts` MCP server.

## Automatic retries

Provider Retry discovers Account Pooler’s `provider-retry.v1.availability` RPC. It accepts `{ threadId, requestId }` and reports `not-routed`, `ready`, `blocked` with `retryAt` in epoch milliseconds, or `unavailable` with a reason. Pool routing must have been recorded when the provider environment was prepared. The request must still be the thread’s latest request; its recorded model determines which quota windows apply. The pool uses the same recovery calculation for its HTTP 429 response and this RPC. Parent pools expose the authenticated `/retry-availability?provider=claude|codex&family=<family>` endpoint.

The retry plugin remains responsible for queueing, maximum waits, and attempt limits. Inspect a skipped decision with `bb provider-retry explain <thread-id>` and pending work with `bb provider-retry status <thread-id>`.

## Plan and model labels

Claude plan badges and the CLI Plan column prefer Anthropic's
`organization.plan_display_name` (for example Ultra) over legacy Max flags and
rate-limit tier identifiers. The name is collected on the next profile refresh;
account names remain unchanged. Without a provider display name, the pool shows
Max with its reported multiplier, or the capitalised subscription type.
The additive `display.get` RPC returns display names in `plans`, keyed by account
ID. Legacy account records and `status.get` retain their existing shape.

The `weekly` map in `display.get` preserves each API-reported model display name
and weekly quota, keyed by account ID and model name. Usage details, the usage
card and CLI show one weekly row per reported name, including future models.
Servers without this method fall back to the legacy family rows. Model display
quotas use an additive SQLite table; existing routing-family quotas and stored
account records remain readable. An empty model map means the latest usage
response reported no scoped limits; an absent map uses legacy observations.
