#!/usr/bin/env bash
# Launch a command (normally `claude`) routed through the bb Account Pooler
# with a per-actor, thread-bound, revocable route token.
#
#   pool-actor-launch.sh --thread <thread-id> --actor <actor-id> [--bb <bb-cli>] -- claude [args...]
#
# The token is obtained from `bb pool route issue --json` into a shell
# variable (never argv, never echoed, never written to disk), exported into the
# child's environment, and the command is exec'd. If issuance fails the script
# exits non-zero. It never falls back to direct provider credentials; run plain
# `claude` for that.
set -euo pipefail
umask 077

usage() {
  echo "usage: pool-actor-launch.sh --thread <thread-id> --actor <actor-id> [--bb <bb-cli>] -- <command> [args...]" >&2
}

die() {
  echo "pool-actor-launch: $*" >&2
  exit 1
}

thread=""
actor=""
bb_cli="${BB_CLI:-bb}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --thread) [ "$#" -ge 2 ] || { usage; exit 2; }; thread="$2"; shift 2 ;;
    --actor) [ "$#" -ge 2 ] || { usage; exit 2; }; actor="$2"; shift 2 ;;
    --bb) [ "$#" -ge 2 ] || { usage; exit 2; }; bb_cli="$2"; shift 2 ;;
    --) shift; break ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done
[ -n "$thread" ] && [ -n "$actor" ] && [ "$#" -gt 0 ] || { usage; exit 2; }
command -v "$bb_cli" >/dev/null 2>&1 || die "bb CLI not found: $bb_cli"

# Pick a JSON reader that takes its input on stdin so the token never reaches argv.
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

# stderr (refusal reasons) passes through; stdout (the token) stays in the variable.
issued="$("$bb_cli" pool route issue --thread "$thread" --actor "$actor" --provider claude --json)" \
  || die "could not issue a pooled route for actor '$actor' on thread '$thread'; not starting the command (no fallback to direct auth)"

token="$(printf '%s' "$issued" | json_field token)" || die "issuer response had no token"
hub_url="$(printf '%s' "$issued" | json_field hubUrl)" || die "issuer response had no hub URL"
unset issued
case "$hub_url" in
  http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*|https://*) ;;
  *) die "refusing unexpected hub URL" ;;
esac

# Direct credentials must not compete with the pooled route.
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
export ANTHROPIC_BASE_URL="$hub_url"
export ANTHROPIC_AUTH_TOKEN="$token"
export ENABLE_TOOL_SEARCH=true
export _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1
export ENABLE_PROMPT_CACHING_1H=1
unset token hub_url
exec "$@"
