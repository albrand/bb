Renew an expired provider sign-in without you doing anything. When a turn fails because Claude Code or Codex is signed out, this plugin opens that provider's own sign-in on the host, waits for the provider to be ready again, resumes the turns that failed, and tells you once.

## What you get

- A sign-in that starts itself when a turn fails on a signed-out provider.
- One sign-in per provider and host at a time, however many threads hit it.
- The turns that failed are resumed for you when the sign-in lands.
- One notification: a toast in the app and a desktop notification on this device.
- `bb provider-signin` for agents and terminals.

## How it works

On the primary Mac with a desktop session, the provider CLI runs its usual sign-in flow. On another host, Claude Code runs its interactive sign-in so you can open the handed-off URL on your device and paste the displayed code into the terminal. Codex uses device authentication, which displays a URL and code for you to enter on your device. bb never reads sign-in terminal output; it only watches whether the provider reports ready.

A sign-in on a primary Mac without a desktop session is not launched; bb notifies you instead. Remote-host sign-ins use the callback-free flow above and open provider URLs through the device handoff. A sign-in nobody completes within ten minutes is closed, and the notification carries a retry.

The plugin does not read or log provider credentials, codes, or terminal output. When a provider opens a URL through `BROWSER`, the shared device handoff sends that URL only to WebSocket clients admitted by BB's browser request guard (the same Origin and Host boundary as every BB WebSocket) that are viewing the originating thread or terminal; the provider CLI makes the remaining sign-in requests.

## CLI

- `bb provider-signin <claude-code|codex> --host <host-id> [--json]`: sign in now.
- `bb provider-signin status [--json]`: show sign-ins bb is waiting on.
