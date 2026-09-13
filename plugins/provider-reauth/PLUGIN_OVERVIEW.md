Renew an expired provider sign-in without you doing anything. When a turn fails because Claude Code or Codex is signed out, this plugin opens that provider's own sign-in on the host, waits for the provider to be ready again, resumes the turns that failed, and tells you once.

## What you get

- A sign-in that starts itself when a turn fails on a signed-out provider.
- One sign-in per provider and host at a time, however many threads hit it.
- The turns that failed are resumed for you when the sign-in lands.
- One notification: a toast in the app and a desktop notification on this device.
- `bb provider-signin` for agents and terminals.

## How it works

The provider CLI runs the sign-in, opens your browser, and receives the code on its own localhost callback. bb never sees a code and never reads the sign-in terminal's output. bb only watches whether the provider reports ready.

A host with no desktop session cannot open a browser, so bb notifies you instead of launching anything there. A sign-in nobody completes within ten minutes is closed, and the notification carries a retry.

The plugin makes no network call of its own. The only traffic is the provider CLI's own sign-in.

## CLI

- `bb provider-signin <claude-code|codex> --host <host-id> [--json]`: sign in now.
- `bb provider-signin status [--json]`: show sign-ins bb is waiting on.
