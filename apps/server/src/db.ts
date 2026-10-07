import { createConnection, ensurePersonalProject, migrate } from "@bb/db";
import type {
  DbConnection,
  MigrationWarningLogger,
  SlowDbQueryLogger,
} from "@bb/db";
import type { Logger } from "@bb/logger";
import { getCurrentEventLoopWorkLabel } from "./services/system/event-loop-work.js";
import {
  exportLegacyAutomationsForPluginImport,
  hasLegacyAutomationsToExport,
} from "./legacy-automations-export.js";

type InitDbLogger = MigrationWarningLogger &
  SlowDbQueryLogger &
  Pick<Logger, "debug" | "error" | "info">;

interface InitDbOptions {
  dataDir?: string;
  slowQueryThresholdMs?: number | (() => number);
  slowQueryDiagnosticsEnabled?: () => boolean;
  logger?: InitDbLogger;
}

export function initDb(
  databasePath: string,
  options: InitDbOptions = {},
): DbConnection {
  const db = createConnection(databasePath, {
    databaseWriteBytesLogger: options.logger,
    slowQueryLogger: options.logger,
    slowQueryThresholdMs: options.slowQueryThresholdMs,
    slowQueryWorkLabel: getCurrentEventLoopWorkLabel,
    slowQueryDiagnosticsEnabled: options.slowQueryDiagnosticsEnabled,
  });
  try {
    if (options.dataDir !== undefined && options.logger !== undefined) {
      exportLegacyAutomationsForPluginImport({
        dataDir: options.dataDir,
        db,
        logger: options.logger,
      });
    } else if (hasLegacyAutomationsToExport(db)) {
      throw new Error(
        "Cannot migrate legacy automations without dataDir and logger; refusing to drop kernel automation rows before exporting them for the automations plugin",
      );
    }
    migrate(db, {
      deferDestructiveLegacyCleanup: true,
      logger: options.logger,
    });
    ensurePersonalProject(db);
  } catch (error) {
    db.$client.close();
    throw error;
  }
  return db;
}
