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
proxying a parent pool. Conversation credentials carry the current account choice;
active turns keep their choice. Machine token rotation also revokes derived
conversation credentials after the existing ten-minute grace period.

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
bb pool account disable <id>
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

Claude `--login` starts a PKCE session, prints a browser URL and session ID,
then exits. Pipe the manual callback code to `account login-complete` with that
session ID within ten minutes. Its command hint uses the absolute path of the
running bb executable. Codex `--login` prints a device verification
URL, one-time code, session ID, and an `account login-poll` command that waits
for authorization. OAuth codes and API keys must be piped through stdin, and either
browser may be on a different machine from the bb server. New accounts join the
end of the provider's priority order by default; rename them with
`bb pool account rename <id> <label>`. Newly added or enabled accounts are
available without a plugin reload. With an
enabled account whose secret file remains readable and valid, matching Claude
Code or Codex sessions receive the pool route and a distinct secret token for
their machine.
Codex receives `CODEX_OPENAI_BASE_URL` and the secret
`CODEX_POOL_AUTH_TOKEN`; bb applies them as in-memory app-server config.
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
pool. A 401 or 403 on a
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
Records that share a login fold into one subscription: Claude records with the
same email and organization (a record without an email joins the login with its
account UUID), and Codex records with the same email and ChatGPT account. A plan change never
splits a subscription. A Claude record whose organization is not known yet,
such as one whose sign-in expired, joins its login's subscription; when that
login has several known organizations, it joins the one with its plan. The
healthiest record represents the subscription in settings, in
the provider usage sources, and in the Subscription selector. The selector
still shows a folded record while a conversation is set to it. The other records
stay in the pool unchanged and still appear in `account list`, `status`, and
`account reorder`. Dragging a row keeps folded records in their places.
Turning a subscription off disables each of its enabled records, so none of
them routes; turning it on enables only the record that represents it. From
the CLI, `account disable` and `account enable` act on one record.
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
when it sees them.

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

Proxied traffic authenticates as the parent machine's token, so `bb pool status`
on the parent attributes it to the parent host rather than to the nested
instance.
