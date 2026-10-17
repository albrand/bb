# CLI, Guide, And Skill

`bb terminal output <id> --lines <n>` prints the latest lines, including from
recently exited terminals. The server retains at most 64 KiB per terminal,
2 MiB and 128 terminals per machine for 30 minutes, evicting oldest output
first. The retained output is stored in the server database and survives server
restarts. Use
`bb terminal pipe <id> --follow [--command <cmd>]` to stream output to stdout or
a local command until the terminal exits or Ctrl-C.

Keep the discoverable surfaces in sync whenever you add or change a `bb` CLI command, flag, or a user-facing configuration knob (env var, `.bb/` workspace file, settings field):

- The in-CLI guide templates under `packages/templates/src/templates/bb-guide-*.md` are the core CLI manual. Document core commands, flags, and settings there; turbo regenerates `packages/templates/src/generated/templates.generated.ts` (not committed) before every build, typecheck, and test task.
- The bb-cli skill (`plugins/bb-guide/skills/bb-cli/SKILL.md`) only routes agents to guide chapters and states agent habits and safety rules. Do not copy command documentation into it. Add new core command paths to its `references/command-index.md`.
- For plugin commands and settings, update the owning plugin's `skills/<name>/SKILL.md` or supporting reference, including built-in plugins. Configuration knobs also belong in `docs/configuration.md`.
- Keep maintainer and repository-development instructions (source startup, release and publishing steps) in `docs/` and app READMEs, not in the guide or shipped skills.
- Match the existing chapter/section style; keep entries concise and accurate against the implementation.

Device handoff is available as `bb device copy [text]` (or stdin) and
`bb device open <url>`, with SDK methods under `sdk.device.request()`. A
handoff reaches only WebSocket clients admitted by BB's browser request guard
(the same Origin and Host boundary as every BB WebSocket) that are viewing the
originating thread or terminal.

`bb thread row-status set <key> <value> [--icon <icon>] [--color <color>] [--priority <number>]`, `bb thread row-status clear [<key>]`, and `bb thread row-status list` manage up to eight status chips on the current thread's sidebar row. `bb thread progress <0..1> [--label <text>]` sets its progress bar; `bb thread progress clear` removes it. These commands use `BB_THREAD_ID` and fail outside a thread. `bb thread status <id>` remains an alias for `bb thread show <id>`. Row state clears when a managed turn settles to idle or error, or when a native terminal session closes with process exit or user close. A daemon disconnect does not clear native row state because the terminal may reattach. Explicit clear commands remove the selected state, and a targeted read hides state after 60 minutes without an update as a backstop. The SDK equivalents are `threads.experimental_rowState` and `threads.experimental_updateRowState`.
