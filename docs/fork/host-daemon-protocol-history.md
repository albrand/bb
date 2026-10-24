# Fork Host Daemon Protocol History

| Version | Wire change |
| --- | --- |
| 239 | `terminal.open.cwd` adds the requested working directory to terminal open messages. |
| 240 | `terminal.attention` reports terminal bell and notification signals from the daemon to the server. |
| 250 | `host.move_path` is replaced by `host.move_file`: one call that refuses Windows hosts, refuses any path that reaches its target through a symbolic link or alias (the resolved path must equal the given path), opens the source with `O_NOFOLLOW`, accepts only a regular file, hard-links it to the destination (refusing folders, links, an existing destination and a cross-filesystem move atomically), then removes the source through a private holding name and an inode check. Daemons on protocols 246-249 stay compatible, but the server refuses a move to them with `file_move_upgrade_required` (`hostDaemonSupportsMoveFile`); there is no fallback to the old browse-then-rename path. `host.remove_path` gains the same Windows and alias refusals. |
