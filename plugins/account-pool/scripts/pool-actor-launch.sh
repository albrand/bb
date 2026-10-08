#!/usr/bin/env bash
set -uo pipefail
umask 077

HUB_PATH="/api/v1/plugins/account-pool/http"

usage() {
  echo "usage: pool-actor-launch.sh --thread <thread-id> [--actor <actor-id>] [--rotate] [--proof-env <VAR>] [--bb <bb-cli>] -- <command> [args...]" >&2
}

die() {
  echo "pool-actor-launch: $*" >&2
  exit 1
}

thread=""
actor=""
rotate=0
proof_env="ANTHROPIC_AUTH_TOKEN"
bb_cli="${BB_CLI:-bb}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --thread) [ "$#" -ge 2 ] || { usage; exit 2; }; thread="$2"; shift 2 ;;
    --actor) [ "$#" -ge 2 ] || { usage; exit 2; }; actor="$2"; shift 2 ;;
    --bb) [ "$#" -ge 2 ] || { usage; exit 2; }; bb_cli="$2"; shift 2 ;;
    --proof-env) [ "$#" -ge 2 ] || { usage; exit 2; }; proof_env="$2"; shift 2 ;;
    --rotate) rotate=1; shift ;;
    --) shift; break ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done
[ -n "$thread" ] && [ "$#" -gt 0 ] || { usage; exit 2; }
command -v "$bb_cli" >/dev/null 2>&1 || die "bb CLI not found: $bb_cli"
command -v node >/dev/null 2>&1 || die "node is required to read the issuer response"
# Issuing and revoking need proof that this caller acts for the thread: the
# pool token bb contributed to that thread (ANTHROPIC_AUTH_TOKEN inside a bb
# thread). It reaches the CLI on stdin, never argv, and is never exported.
[[ "$proof_env" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "--proof-env must name an environment variable"
proof="${!proof_env:-}"
[ -n "$proof" ] || die "no thread proof in \$$proof_env; run inside the thread whose route you need, or pass --proof-env"

if [ -z "$actor" ]; then
  suffix="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
  [ -n "$suffix" ] || die "could not generate a unique actor id"
  actor="launch:${suffix}"
  rotate=0
fi

issue_args=(pool route issue --thread "$thread" --actor "$actor" --provider claude --json)
[ "$rotate" -eq 0 ] || issue_args+=(--rotate)
issued="$(printf '%s' "$proof" | "$bb_cli" "${issue_args[@]}" --proof-stdin)" \
  || die "could not issue a pooled route for actor '$actor' on thread '$thread'; not starting the command (no fallback to direct auth)"

generation=""
revoked=0
revoke_failed=0
final_status=1
child=""

revoke_route() {
  [ "$revoked" -eq 0 ] || return 0
  revoked=1
  local args=(pool route revoke --actor "$actor" --thread "$thread")
  if [ -n "$generation" ]; then
    args+=(--generation "$generation")
  elif [ "$rotate" -eq 1 ]; then
    echo "pool-actor-launch: the issuer response had no generation, so the route for actor '$actor' on thread '$thread' was left in place (it may belong to another launch); revoke it manually from inside that thread with: bb pool route revoke --actor $actor --thread $thread --proof-stdin" >&2
    return 0
  fi
  if ! printf '%s' "$proof" | "$bb_cli" "${args[@]}" --proof-stdin >/dev/null; then
    revoke_failed=1
    echo "pool-actor-launch: FAILED to revoke the pooled route for actor '$actor' on thread '$thread'; revoke it manually from inside that thread with: bb pool route revoke --actor $actor --thread $thread --proof-stdin" >&2
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

parse_issued() {
  printf '%s' "$issued" | node -e '
const hubPath = process.argv[1];
const denied = new Set(["PATH","HOME","SHELL","IFS","ENV","BASH_ENV","NODE_OPTIONS","NODE_PATH","LD_PRELOAD","LD_LIBRARY_PATH","DYLD_INSERT_LIBRARIES","DYLD_LIBRARY_PATH","ANTHROPIC_API_KEY","CLAUDE_CODE_OAUTH_TOKEN","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_BASE_URL"]);
let data = "";
process.stdin.on("data", (chunk) => (data += chunk)).on("end", () => {
  const out = [];
  let doc;
  try { doc = JSON.parse(data); } catch { process.stdout.write("\0reject:unreadable\0"); return; }
  const generation = typeof doc.generation === "string" && /^[a-f0-9]{16}$/.test(doc.generation) ? doc.generation : "";
  const reject = (reason) => process.stdout.write(generation + "\0reject:" + reason + "\0");
  if (generation === "") return reject("no-generation");
  if (typeof doc.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(doc.token)) return reject("no-token");
  let url;
  try { url = new URL(doc.hubUrl); } catch { return reject("hub-url"); }
  const hosts = ["127.0.0.1", "localhost", "[::1]"];
  if (url.protocol !== "http:" || !hosts.includes(url.hostname) || url.port === "" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname.replace(/\/+$/, "") !== hubPath) return reject("hub-url");
  if (!Array.isArray(doc.launchEnv)) return reject("launch-env");
  const seen = new Set();
  for (const entry of doc.launchEnv) {
    if (entry === null || typeof entry !== "object" || typeof entry.name !== "string" || typeof entry.value !== "string") return reject("launch-env");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) || denied.has(entry.name) || entry.name.startsWith("LD_") || entry.name.startsWith("DYLD_") || entry.value.includes("\0") || seen.has(entry.name)) return reject("launch-env");
    seen.add(entry.name);
    out.push(entry.name, entry.value);
  }
  process.stdout.write([generation, "ok", doc.token, url.origin + hubPath, ...out].join("\0") + "\0");
});
' "$HUB_PATH"
}

exec 3< <(parse_issued)
unset issued
IFS= read -r -d '' generation <&3 || true
IFS= read -r -d '' parse_status <&3 || parse_status="reject:unreadable"
if [ "$parse_status" != "ok" ]; then
  exec 3<&-
  die "refusing the issuer response (${parse_status#reject:}); not starting the command"
fi
IFS= read -r -d '' token <&3 || die "issuer response had no token"
IFS= read -r -d '' hub_url <&3 || die "issuer response had no hub URL"
env_names=()
env_values=()
while IFS= read -r -d '' env_name <&3 && IFS= read -r -d '' env_value <&3; do
  env_names+=("$env_name")
  env_values+=("$env_value")
done
exec 3<&-

(
  unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
  unset ENABLE_PROMPT_CACHING_1H ENABLE_TOOL_SEARCH _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL
  index=0
  while [ "$index" -lt "${#env_names[@]}" ]; do
    export "${env_names[$index]}=${env_values[$index]}"
    index=$((index + 1))
  done
  export ANTHROPIC_BASE_URL="$hub_url"
  export ANTHROPIC_AUTH_TOKEN="$token"
  unset token hub_url env_names env_values env_name env_value index
  trap - EXIT TERM HUP INT
  exec "$@"
) <&0 &
child=$!
unset token hub_url env_names env_values env_name env_value

status=0
while kill -0 "$child" 2>/dev/null; do
  wait "$child"
  status=$?
done
final_status=$status
exit "$final_status"
