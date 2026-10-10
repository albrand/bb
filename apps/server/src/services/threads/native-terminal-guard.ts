import { isNativeTerminalThread, type DbConnection } from "@bb/db";
import { ApiError } from "../../errors.js";

export function assertNotNativeTerminalThread(
  db: DbConnection,
  threadId: string,
): void {
  if (isNativeTerminalThread(db, threadId)) {
    throw new ApiError(
      409,
      "native_terminal_thread",
      "This thread runs its agent in a native terminal; send input through the terminal",
    );
  }
}
