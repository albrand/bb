#!/usr/bin/env bash
# Run a command (normally `claude`) routed through the bb Account Pooler with a
# per-launch, thread-bound, revocable route token.
#
#   pool-actor-launch.sh --thread <thread-id> [--actor <actor-id>] [--rotate] [--bb <bb-cli>] -- claude [args...]
#
# The command runs as a child with the token only in its environment. The
# token is never in argv, never echoed, never written to disk. When the child
# exits (any status) or the launcher is signalled, the actor's route is revoked
# and the child's exit status is propagated. If revocation fails the launcher
# says so on stderr and exits non-zero even when the child succeeded.
# Issuance failure is fail-closed: the command is not started and there is no
# fallback to direct credentials (run plain `claude` for that).
set -uo pipefail
umask 077

usage() {
  echo "usage: pool-actor-launch.sh --thread <thread-id> [--actor <actor-id>] [--rotate] [--bb <bb-cli>] -- <command> [args...]" >&2
}

die() {
  echo "pool-actor-launch: $*" >&2
  exit 1
}

thread=""
actor=""
rotate=0
bb_cli="${BB_CLI:-bb}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --thread) [ "$#" -ge 2 ] || { usage; exit 2; }; thread="$2"; shift 2 ;;
    --actor) [ "$#" -ge 2 ] || { usage; exit 2; }; actor="$2"; shift 2 ;;
    --bb) [ "$#" -ge 2 ] || { usage; exit 2; }; bb_cli="$2"; shift 2 ;;
    --rotate) rotate=1; shift ;;
    --) shift; break ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done
[ -n "$thread" ] && [ "$#" -gt 0 ] || { usage; exit 2; }
command -v "$bb_cli" >/dev/null 2>&1 || die "bb CLI not found: $bb_cli"

if [ -z "$actor" ]; then
  suffix="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
  [ -n "$suffix" ] || die "could not generate a unique actor id"
  actor="launch:${suffix}"
  rotate=0
fi

if command -v node >/dev/null 2>&1; then
  json_field() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d)[process.argv[1]];if(typeof v==="string"&&v!=="")process.stdout.write(v);else process.exit(1)}catch{process.exit(1)}})' "$1"; }
elif command -v python3 >/dev/null 2>&1; then
  json_field() { python3 -I -c 'import json,sys
try:
    v=json.load(sys.stdin)[sys.argv[1]]
except Exception:
    sys.exit(1)
if not isinstance(v,str) or not v:
    sys.exit(1)
sys.stdout.write(v)' "$1"; }
else
  die "need node or python3 to read the issuer response"
fi

if [ "$rotate" -eq 1 ]; then
  mode="--rotate"
else
  mode="--exclusive"
fi
issued="$("$bb_cli" pool route issue --thread "$thread" --actor "$actor" --provider claude "$mode" --json)" \
  || die "could not issue a pooled route for actor '$actor' on thread '$thread'; not starting the command (no fallback to direct auth)"

child=""
revoked=0
revoke_failed=0
final_status=1

revoke_route() {
  [ "$revoked" -eq 0 ] || return 0
  revoked=1
  if ! "$bb_cli" pool route revoke --actor "$actor" --thread "$thread" >/dev/null; then
    revoke_failed=1
    echo "pool-actor-launch: FAILED to revoke the pooled route for actor '$actor' on thread '$thread'; revoke it manually with: bb pool route revoke --actor $actor --thread $thread" >&2
  fi
}

on_exit() {
  trap - EXIT
  revoke_route
  if [ "$revoke_failed" -eq 1 ] && [ "$final_status" -eq 0 ]; then
    final_status=1
  fi
  exit "$final_status"
}

on_signal() {
  revoke_route
  if [ -n "$child" ]; then
    kill -s "$1" "$child" 2>/dev/null || true
  fi
}

trap on_exit EXIT
trap 'on_signal TERM' TERM
trap 'on_signal HUP' HUP
if [ -t 0 ]; then
  trap ':' INT
else
  trap 'on_signal INT' INT
fi

token="$(printf '%s' "$issued" | json_field token)" || { final_status=1; echo "pool-actor-launch: issuer response had no token" >&2; exit 1; }
hub_url="$(printf '%s' "$issued" | json_field hubUrl)" || { echo "pool-actor-launch: issuer response had no hub URL" >&2; exit 1; }
unset issued
case "$hub_url" in
  http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*|https://*) ;;
  *) echo "pool-actor-launch: refusing unexpected hub URL" >&2; exit 1 ;;
esac

(
  unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
  export ANTHROPIC_BASE_URL="$hub_url"
  export ANTHROPIC_AUTH_TOKEN="$token"
  export ENABLE_TOOL_SEARCH=true
  export _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1
  export ENABLE_PROMPT_CACHING_1H=1
  unset token hub_url
  trap - EXIT TERM HUP INT
  exec "$@"
) <&0 &
child=$!
unset token hub_url

status=0
while kill -0 "$child" 2>/dev/null; do
  wait "$child"
  status=$?
done
final_status=$status
exit "$final_status"
