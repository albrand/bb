export const COMMAND_TIMEOUT_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const LEASE_TIMEOUT_MS = 30_000;
export const DAEMON_DISCONNECT_GRACE_MS = 5_000;
export const DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS = LEASE_TIMEOUT_MS;
export const MANAGED_ENVIRONMENT_RETIRE_GRACE_MS = 5 * 60_000;
export const WORKSPACE_DIFF_MAX_DIFF_BYTES = 2 * 1024 * 1024;
export const WORKSPACE_DIFF_MAX_FILE_LIST_BYTES = 256 * 1024;
export const WORKSPACE_STATUS_MAX_UNTRACKED_LINE_STAT_FILES = 50;
export const WORKSPACE_STATUS_MAX_UNTRACKED_LINE_STAT_BYTES = 8 * 1024 * 1024;
export const WORKSPACE_DIFF_MAX_FILES = 500;

export const DIFF_FILE_AUTO_LOAD_MAX_CHANGED_LINES = 500;
export const DIFF_FILE_TOO_LARGE_CHANGED_LINES = 20_000;
export const DIFF_FILE_PATCH_MAX_BYTES = 512 * 1024;
export const DIFF_FILES_INLINE_PATCH_MAX_FILES = 10;

/**
 * How long a send waits for the daemon to accept a `turn.submit` before it
 * reports the message sent anyway.
 *
 * The daemon answers a submit as soon as the turn is started or steered, and a
 * refusal ("Refusing to start a competing turn …") comes back in milliseconds.
 * Without this wait a refused message was reported as delivered: `bb thread
 * tell` printed "updated" and exited 0 while the thread went to `error` behind
 * it. Short, because a submit to a cold provider session can legitimately take
 * much longer, and those still report "sent" exactly as before.
 */
export const TURN_ACCEPTANCE_GRACE_MS = 3_000;
