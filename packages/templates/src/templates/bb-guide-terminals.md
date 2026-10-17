---
kind: instruction
title: bb Terminal Guide
summary: Creating and managing persistent terminals across thread, environment, and machine scopes.
intent: Help agents route terminal sessions explicitly and manage them by terminal ID.
editingNotes: Keep scope selectors and ID-only commands aligned with bb terminal --help.
---
Terminal commands

Use terminals for long-running commands that should stay alive for the user,
such as dev servers, watch tasks, REPLs, and database consoles. A terminal is a
real persistent PTY and appears in the bb UI.

List and create require exactly one explicit scope:

  bb terminal list --thread <thread-id>
  bb terminal list --environment <environment-id>
  bb terminal list --machine <id-or-name> [--cwd <path>]

  bb terminal create --thread <thread-id> [--working-directory <path>] --command "pnpm dev"
  bb terminal create --environment <environment-id>
  bb terminal create --machine <id-or-name> [--cwd <path>]   (alias: start)
    --working-directory <path>       Initial shell working directory
    --host <id-or-name>                   Alias for --machine
    --title <title>                       Display title
    --cols <n>                            Initial terminal columns
    --rows <n>                            Initial terminal rows
    --attach                              Attach after creating
    --json                                Print machine-readable output

Machine names are resolved to an explicit machine ID. No scope defaults to the
server machine, and --cwd is valid only with --machine or --host.

A terminal runs the machine's own shell: $SHELL (then zsh, bash, sh) on macOS
and Linux; on Windows, PowerShell 7 when `pwsh` is on PATH, otherwise Windows
PowerShell, otherwise cmd. Write --command in that shell's syntax. To run a
program with arguments without knowing the shell, pass them after `--`
(`bb terminal create --thread <id> -- pnpm test "my file.ts"`): the machine
quotes each argument for its own shell. `send --enter` presses Enter (a carriage
return), which every one of those shells accepts. The terminal's exit code is
the command's own exit code on every shell.

All other operations need only the terminal ID. They also accept the scope
flags above and ignore them, so a command built for `list` or `create` still
runs:

From inside a bb terminal, `bb terminal notify --title "Build" --body "Finished"`
raises attention on its terminal. The SDK exposes the same operation as
`sdk.terminals.notify({ terminalId, title, body })`.

Device handoffs

Agent commands and terminal shells can offer text to copy or an HTTP(S) URL to
open on a device whose WebSocket is admitted by BB's browser request guard
(the same Origin and Host boundary as every BB WebSocket) and is viewing the
originating thread or terminal:

  bb device copy "text to copy"
  printf '%s' "text to copy" | bb device copy
  bb device open https://example.com/login

The SDK exposes `sdk.device.request({ kind: "copy-text", text, origin })` and
`sdk.device.request({ kind: "open-url", url, origin })`. On the host, `pbcopy`,
`open`, `xdg-open`, and `$BROWSER` preserve their local behavior and also offer
supported text or URLs to the viewing device. Handoffs expire after ten minutes
and never copy or open anything until the user taps the offered action.

  bb terminal show <terminal-id>
  bb terminal attach <terminal-id>        Ctrl-B d detaches
  bb terminal send <terminal-id> --text <text> [--enter]
    --stdin                               Read bytes from stdin instead of --text
  bb terminal resize <terminal-id> --cols <n> --rows <n>
  bb terminal rename <terminal-id> <title>
  bb terminal notify --title <title> --body <body>   Raise attention from this terminal
  bb terminal attention list                     List uncleared terminal attention
  bb terminal attention next                     Print the oldest terminal needing attention
  bb terminal attention clear <terminal-id>       Clear attention for a terminal
  bb terminal restart <terminal-id>       Atomically replaces it with a shell; does not replay the original command
  bb terminal close <terminal-id> [--if-clean]   (alias: stop)

  A terminal has one size. When several windows or devices show it, the one
  you last typed, pasted or clicked in sets the size; opening or resizing
  another view does not change it until you use that view. bb terminal attach
  takes the size when it attaches and when its window resizes.

The app's “Next terminal needing attention” command and Alt+Shift+N open the
oldest uncleared terminal in its thread and terminal pane. When no terminal
needs attention, the app shows “Nothing needs attention.” The CLI's `next`
prints the target because it has no app window. The SDK exposes
`sdk.terminals.experimental_attention.list()`, `.next()`, and `.clear({ terminalId })`.

  bb terminal output <terminal-id>
    --lines <n>                          Print the latest N lines
    --since-seq <n>                       Read output chunks from a sequence
    --tail-bytes <n>                      Bound output to latest N bytes
    --limit-chunks <n>                    Bound output to latest N chunks
    --json                                Print chunks, nextSeq, truncated, status, exitCode, and closeReason

  bb terminal pipe <terminal-id> --follow
    --command <command>                  Pipe output into a local command

  Output stays readable after the command exits for 30 minutes, capped at 64 KiB
  per terminal, 2 MiB and 128 terminals per machine, with oldest output evicted first. Output
  is stored in the server database and survives server restarts. `pipe --follow` streams
  output until exit or Ctrl-C. For an exited terminal the output is followed by
  `Terminal <id> exited with code N` on stderr. Once the scrollback is gone,
  output fails with `terminal_output_unavailable` and says why.

  bb terminal wait <terminal-id>
    --contains <text>                     Wait for new output containing text
    --regex <pattern>                     Wait for new output matching regex
    --exit                                Wait until the terminal exits
    --from-start                          Include existing scrollback
    --timeout <duration>                  Seconds, or a duration with a unit: 90s, 5m (default: 30s)
    --poll-interval <duration>            Milliseconds, or a duration with a unit (default: 500ms)

  When the terminal exits before the text appears, wait stops at once with exit
  code 124, the terminal's exit code, and the last output it printed. `--exit`
  prints the exit code.

For a dev server, prefer:

  bb terminal create --thread <thread-id> --title "pnpm dev" --command "pnpm dev"
  bb terminal wait <terminal-id> --contains "Local:" --timeout 120

Do not run long-lived servers as one-off foreground commands when the user will
need to inspect logs, refresh the page, or stop the process later.
