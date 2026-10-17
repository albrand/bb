import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const stdioLogWriter = `
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const logPath = process.argv[1];
const writerBarrier = process.argv[2] ? JSON.parse(process.argv[2]) : null;
const sizeLimit = 10 * 1024 * 1024;
const retainedBackups = 5;
const maxWriteAttempts = 3;
const retryDelayMs = 10;
const maxChunkRetryMs = 2_000;
const recoveryIntervalMs = writerBarrier?.recoveryIntervalMs ?? 1_000;
const identityFallbackMs = writerBarrier?.identityFallbackMs ?? 10 * 60 * 1000;
const identityRecheckMs = writerBarrier?.identityRecheckMs ?? 5_000;
const processIdentityCache = new Map();
const fingerprint = (value) => crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
const readProcStartTime = (pid) => {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const startTime = stat.slice(close + 2).trim().split(/\\s+/)[19];
    return /^\\d+$/.test(startTime) ? startTime : undefined;
  } catch {
    return undefined;
  }
};
const readPsStartTime = (pid) => {
  try {
    const startTime = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      timeout: 1_000,
    }).trim();
    return startTime || undefined;
  } catch {
    return undefined;
  }
};
const readProcessIdentity = (pid) => {
  if (process.platform === "linux" && writerBarrier?.forcePsIdentity !== true) {
    const startTime = readProcStartTime(pid);
    if (startTime !== undefined) return { source: 1, fingerprint: fingerprint(startTime) };
  }
  const startTime = readPsStartTime(pid);
  if (startTime !== undefined) return { source: 2, fingerprint: fingerprint(startTime) };
  return { source: 0, fingerprint: "0000000000000000" };
};
const cachedProcessFingerprint = (pid, source) => {
  const key = pid + "-" + source;
  const cached = processIdentityCache.get(key);
  const now = Date.now();
  if (cached !== undefined && now - cached.checkedAt < identityRecheckMs) return cached.fingerprint;
  let value;
  if (writerBarrier?.unreadableOwnerIdentityPids?.includes(pid)) {
    value = undefined;
  } else if (source === 1) {
    const startTime = readProcStartTime(pid);
    value = startTime === undefined ? undefined : fingerprint(startTime);
  } else if (source === 2) {
    const startTime = readPsStartTime(pid);
    value = startTime === undefined ? undefined : fingerprint(startTime);
  }
  processIdentityCache.set(key, { fingerprint: value, checkedAt: now });
  return value;
};
const ownerIdentity = readProcessIdentity(process.pid);
const token = process.pid + "-" + ownerIdentity.source + "-" + ownerIdentity.fingerprint + "-" + crypto.randomUUID();
const familyPrefix = logPath + ".";
const activePath = familyPrefix + "active-" + token;
let activeFd;
let activeSize = 0;
let aliasSequence = 0;
let writerBarrierUsed = false;
let initialized = false;
let processing = false;
let inputPaused = false;
let inputEnded = false;
let finalized = false;
let retryTimer;
let recoveryTimer;
let writeAttempts = 0;
let chunkRetryStartedAt;
let pendingOffset = 0;
let pendingLossBytes = 0;
let pendingLossErrno = "";
let pendingLossMarker;
let pendingLossMarkerOffset = 0;
let finalizationAttempts = 0;
const pendingChunks = [];
let pendingBytes = 0;
const maxPendingBytes = 16 * 1024 * 1024;
const backupPattern = /^.+\\.backup-[0-9]+-[0-9]+-[a-f0-9-]+$/;
const activePattern = /^.+\\.active-[0-9]+-[012]-[a-f0-9]{16}-[a-f0-9-]+$/;
const paths = () => fs.readdirSync(path.dirname(logPath)).map((name) => path.join(path.dirname(logPath), name));
const uniqueBackupPath = () => familyPrefix + "backup-" + Date.now() + "-" + token + "-" + crypto.randomUUID();
const errorCode = (error) => typeof error?.code === "string" ? error.code : "UNKNOWN";
const reportDiagnostic = (message) => {
  try {
    fs.writeSync(2, Buffer.from("[bb] " + message + "\\n"));
  } catch (error) {
    const diagnosticErrorCode = errorCode(error);
    if (diagnosticErrorCode === "EPIPE") return;
  }
};
const reportFsError = (operation, error) => reportDiagnostic(operation + ": " + errorCode(error));
const makeInjectedFailure = (operation) => {
  const error = new Error("injected stdio " + operation + " failure");
  error.code = "EIO";
  return error;
};
const openSync = fs.openSync;
fs.openSync = (filePath, ...args) => {
  if (filePath === activePath && writerBarrier !== null && writerBarrier.failActiveOpenCount > 0) {
    writerBarrier.failActiveOpenCount -= 1;
    throw makeInjectedFailure("active open");
  }
  return openSync(filePath, ...args);
};
const writeSync = fs.writeSync;
fs.writeSync = (fd, ...args) => {
  if (fd === activeFd && writerBarrier !== null && writerBarrier.failActiveWriteCount > 0) {
    writerBarrier.failActiveWriteCount -= 1;
    throw makeInjectedFailure("active append");
  }
  return writeSync(fd, ...args);
};
const publishAliasTo = (targetPath) => {
  const temporary = logPath + ".alias-" + token + "-" + (++aliasSequence);
  try {
    fs.linkSync(targetPath, temporary);
    try {
      fs.renameSync(temporary, logPath);
    } catch (error) {
      if (error.code !== "EEXIST" && error.code !== "EPERM") reportFsError("stdio alias replace failed", error);
      try {
        fs.unlinkSync(logPath);
        fs.renameSync(temporary, logPath);
      } catch (replaceError) {
        reportFsError("stdio alias publish failed", replaceError);
      }
    }
  } catch (error) {
    reportFsError("stdio alias link failed", error);
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") reportFsError("stdio alias cleanup failed", cleanupError);
    }
  }
};
const pruneBackups = (maximum = retainedBackups) => {
  let backups;
  try {
    backups = paths().filter((file) => file.startsWith(familyPrefix) && backupPattern.test(path.basename(file)));
    backups.sort((left, right) => fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs);
  } catch (error) {
    reportFsError("stdio backup scan failed", error);
    return;
  }
  while (backups.length > maximum) {
    const oldest = backups.shift();
    try {
      const aliasStat = fs.statSync(logPath);
      const oldestStat = fs.statSync(oldest);
      if (aliasStat.dev === oldestStat.dev && aliasStat.ino === oldestStat.ino) {
        const replacement = paths()
          .filter((file) => file !== oldest && (activePattern.test(path.basename(file)) || backupPattern.test(path.basename(file))))
          .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];
        if (replacement !== undefined) publishAliasTo(replacement);
        else fs.unlinkSync(logPath);
      }
    } catch (error) {
      if (error.code !== "ENOENT") reportFsError("stdio alias retention update failed", error);
    }
    try {
      fs.unlinkSync(oldest);
    } catch (error) {
      if (error.code !== "ENOENT") reportFsError("stdio backup prune failed", error);
    }
  }
};
const migrateLegacyFiles = () => {
  const baseName = path.basename(logPath);
  const numberedBackups = paths().filter((file) => {
    const name = path.basename(file);
    const suffix = name.slice(baseName.length + 1);
    return name.startsWith(baseName + ".") && /^[1-9][0-9]*$/.test(suffix);
  }).sort((left, right) => Number(path.basename(right).slice(baseName.length + 1)) - Number(path.basename(left).slice(baseName.length + 1)));
  const candidates = [...numberedBackups, logPath];
  for (const sourcePath of candidates) {
    if (!fs.existsSync(sourcePath)) continue;
    let sourceFd;
    let backupFd;
    try {
      const sourceStat = fs.statSync(sourcePath);
      const alreadySegmented = paths().some((file) => {
        if (file === sourcePath || (!activePattern.test(path.basename(file)) && !backupPattern.test(path.basename(file))) || !fs.existsSync(file)) return false;
        const candidateStat = fs.statSync(file);
        return candidateStat.dev === sourceStat.dev && candidateStat.ino === sourceStat.ino;
      });
      if (alreadySegmented || sourceStat.size === 0) continue;
      sourceFd = fs.openSync(sourcePath, "r");
      let remaining = sourceStat.size;
      let segmentSize = 0;
      const buffer = Buffer.alloc(64 * 1024);
      while (remaining > 0) {
        if (backupFd === undefined || segmentSize >= sizeLimit) {
          if (backupFd !== undefined) fs.closeSync(backupFd);
          pruneBackups(retainedBackups - 1);
          const backupPath = uniqueBackupPath();
          backupFd = fs.openSync(backupPath, "wx", 0o600);
          segmentSize = 0;
        }
        const length = Math.min(buffer.length, remaining, sizeLimit - segmentSize);
        const read = fs.readSync(sourceFd, buffer, 0, length, null);
        if (read <= 0) throw new Error("legacy stdio log ended during migration");
        let offset = 0;
        while (offset < read) offset += fs.writeSync(backupFd, buffer, offset, read - offset);
        remaining -= read;
        segmentSize += read;
      }
      fs.closeSync(sourceFd);
      sourceFd = undefined;
      if (backupFd !== undefined) fs.closeSync(backupFd);
      backupFd = undefined;
      fs.unlinkSync(sourcePath);
    } catch (error) {
      reportFsError("legacy stdio migration failed", error);
      if (sourceFd !== undefined) {
        try {
          fs.closeSync(sourceFd);
        } catch (closeError) {
          reportFsError("legacy stdio source close failed", closeError);
        }
      }
      if (backupFd !== undefined) {
        try {
          fs.closeSync(backupFd);
        } catch (closeError) {
          reportFsError("legacy stdio backup close failed", closeError);
        }
      }
      throw error;
    }
  }
  pruneBackups();
};
const recoverClosedSegments = () => {
  for (const file of paths()) {
    const name = path.basename(file);
    if (!file.startsWith(familyPrefix) || file === activePath || !activePattern.test(name)) continue;
    const ownerParts = name.slice(name.indexOf(".active-") + 8).split("-");
    const ownerPid = Number(ownerParts[0]);
    const ownerSource = Number(ownerParts[1]);
    const ownerFingerprint = ownerParts[2];
    if (!Number.isInteger(ownerPid) || ownerPid < 1) continue;
    let recover = false;
    try {
      process.kill(ownerPid, 0);
    } catch (error) {
      if (error.code === "ESRCH") {
        recover = true;
      } else if (error.code !== "EPERM") {
        reportFsError("stdio segment owner check failed", error);
        continue;
      }
    }
    if (!recover) {
      const currentFingerprint = ownerSource === 0 ? undefined : cachedProcessFingerprint(ownerPid, ownerSource);
      if (currentFingerprint !== undefined) {
        recover = currentFingerprint !== ownerFingerprint;
      } else {
        try {
          recover = Date.now() - fs.statSync(file).mtimeMs > identityFallbackMs;
        } catch (statError) {
          if (statError.code !== "ENOENT") reportFsError("stdio segment idle check failed", statError);
          continue;
        }
        if (recover) reportDiagnostic("stdio segment owner identity unavailable; recovering after idle bound");
      }
    }
    if (recover) {
      try {
        pruneBackups(retainedBackups - 1);
        fs.renameSync(file, uniqueBackupPath());
      } catch (renameError) {
        if (renameError.code !== "ENOENT") reportFsError("orphan stdio segment recovery failed", renameError);
      }
    }
  }
  pruneBackups();
};
const createActive = () => {
  activeFd = fs.openSync(activePath, "wx", 0o600);
  activeSize = fs.fstatSync(activeFd).size;
  publishAliasTo(activePath);
};
const ensureInitialized = () => {
  if (initialized) return;
  migrateLegacyFiles();
  recoverClosedSegments();
  createActive();
  initialized = true;
};
const closeActive = (archive) => {
  if (activeFd !== undefined) {
    fs.closeSync(activeFd);
    activeFd = undefined;
  }
  if (archive && fs.existsSync(activePath)) {
    pruneBackups(retainedBackups - 1);
    fs.renameSync(activePath, uniqueBackupPath());
    pruneBackups();
  }
};
const rotateOwnedSegment = () => {
  closeActive(true);
  recoverClosedSegments();
  createActive();
};
const appendBuffer = (buffer, startOffset, kind) => {
  let offset = startOffset;
  while (offset < buffer.length) {
    ensureInitialized();
    if (activeFd === undefined) createActive();
    if (activeSize >= sizeLimit) rotateOwnedSegment();
    const length = Math.min(sizeLimit - activeSize, buffer.length - offset);
    if (kind === "output" && writerBarrier !== null && !writerBarrierUsed && writerBarrier.pauseAtBytes !== undefined && activeSize >= writerBarrier.pauseAtBytes) {
      writerBarrierUsed = true;
      fs.writeFileSync(writerBarrier.enteredPath, "entered");
      const waitCell = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(writerBarrier.releasePath)) Atomics.wait(waitCell, 0, 0, 10);
    }
    const startingSize = activeSize;
    try {
      const written = fs.writeSync(activeFd, buffer, offset, length);
      if (written <= 0) throw new Error("stdio segment write made no progress");
      offset += written;
      activeSize += written;
    } catch (error) {
      try {
        const observedSize = fs.fstatSync(activeFd).size;
        const observedProgress = Math.max(0, observedSize - startingSize);
        if (observedProgress <= length) {
          activeSize = observedSize;
          offset += observedProgress;
        } else {
          reportDiagnostic("stdio segment size changed unexpectedly during failed append");
        }
      } catch (statError) {
        reportFsError("stdio segment size recovery failed", statError);
      }
      const failure = new Error("stdio " + kind + " append failed", { cause: error });
      failure.code = errorCode(error);
      failure.writerKind = kind;
      failure.writerOffset = offset;
      throw failure;
    }
  }
  return offset;
};
const writePendingLossMarker = () => {
  if (pendingLossBytes === 0) return;
  if (pendingLossMarker === undefined) pendingLossMarker = Buffer.from("[bb] " + pendingLossBytes + " bytes of child output lost: " + pendingLossErrno + "\\n");
  pendingLossMarkerOffset = appendBuffer(pendingLossMarker, pendingLossMarkerOffset, "marker");
  pendingLossBytes = 0;
  pendingLossErrno = "";
  pendingLossMarker = undefined;
  pendingLossMarkerOffset = 0;
};
const resumeInputIfDrained = () => {
  if (inputPaused && pendingBytes < maxPendingBytes / 2) {
    inputPaused = false;
    process.stdin.resume();
  }
};
const dequeueChunk = (chunk) => {
  pendingChunks.shift();
  pendingBytes -= chunk.length;
  pendingOffset = 0;
  writeAttempts = 0;
  chunkRetryStartedAt = undefined;
  resumeInputIfDrained();
};
const scheduleRetry = (delayMs = retryDelayMs) => {
  processing = false;
  if (retryTimer !== undefined || finalized) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    processNext();
  }, delayMs);
};
const finishStream = () => {
  if (finalized) return;
  try {
    if (pendingLossBytes > 0) writePendingLossMarker();
    closeActive(true);
    if (writerBarrier?.completionPath !== undefined) {
      fs.writeFileSync(writerBarrier.completionPath, "done");
    }
    finalized = true;
    clearInterval(recoveryTimer);
  } catch (error) {
    finalizationAttempts += 1;
    reportFsError("stdio finalization retry " + finalizationAttempts + "/" + maxWriteAttempts, error);
    scheduleRetry(Math.min(1_000, retryDelayMs * Math.max(1, finalizationAttempts)));
  }
};
const processNext = () => {
  if (processing || finalized) return;
  const chunk = pendingChunks[0];
  if (chunk === undefined) {
    if (inputEnded) {
      processing = true;
      finishStream();
      processing = false;
    }
    return;
  }
  processing = true;
  if (chunkRetryStartedAt === undefined) chunkRetryStartedAt = Date.now();
  try {
    ensureInitialized();
    writePendingLossMarker();
    pendingOffset = appendBuffer(chunk, pendingOffset, "output");
    dequeueChunk(chunk);
    processing = false;
    setImmediate(processNext);
  } catch (error) {
    const code = errorCode(error);
    if (error.writerKind === "marker") pendingLossMarkerOffset = error.writerOffset;
    if (error.writerKind === "output") pendingOffset = error.writerOffset;
    writeAttempts += 1;
    if (writeAttempts <= maxWriteAttempts) reportFsError("stdio output retry " + writeAttempts + "/" + maxWriteAttempts, error);
    if (writeAttempts < maxWriteAttempts || Date.now() - chunkRetryStartedAt < maxChunkRetryMs) {
      const delayMs = writeAttempts < maxWriteAttempts ? retryDelayMs : 100;
      if (writeAttempts >= maxWriteAttempts) writeAttempts = 0;
      scheduleRetry(delayMs);
      return;
    }
    const lostBytes = Math.max(0, chunk.length - pendingOffset);
    dequeueChunk(chunk);
    pendingLossBytes += lostBytes;
    pendingLossErrno = code;
    if (lostBytes > 0) reportDiagnostic(lostBytes + " bytes of child output lost: " + code);
    processing = false;
    setImmediate(processNext);
  }
};
try {
  ensureInitialized();
} catch (error) {
  reportFsError("stdio writer setup failed", error);
}
process.stdin.on("data", (chunk) => {
  pendingChunks.push(chunk);
  pendingBytes += chunk.length;
  if (!inputPaused && pendingBytes >= maxPendingBytes) {
    inputPaused = true;
    process.stdin.pause();
  }
  processNext();
});
process.stdin.on("end", () => {
  inputEnded = true;
  processNext();
});
process.stdin.on("error", (error) => {
  reportFsError("stdio input stream failed", error);
  inputEnded = true;
  processNext();
});
process.stderr.on("error", (error) => {
  const diagnosticErrorCode = errorCode(error);
  if (diagnosticErrorCode !== "EPIPE") reportFsError("stdio diagnostic stream failed", error);
});
process.on("uncaughtException", (error) => {
  reportFsError("uncaught stdio writer error", error);
  processing = false;
  scheduleRetry();
});
recoveryTimer = setInterval(() => {
  if (finalized) return;
  try {
    if (activeFd !== undefined) {
      const now = new Date();
      fs.futimesSync(activeFd, now, now);
    }
    recoverClosedSegments();
  } catch (error) {
    reportFsError("stdio periodic segment recovery failed", error);
  }
}, recoveryIntervalMs);
recoveryTimer.unref();
`;

interface SpawnLoggedProcessArgs {
  args: string[];
  command: string;
  env: NodeJS.ProcessEnv;
  ipc?: boolean;
  logDir: string;
  logName: "server" | "host-daemon";
  testWriterBarrier?: {
    enteredPath?: string;
    releasePath?: string;
    pauseAtBytes?: number;
    failActiveOpenCount?: number;
    failActiveWriteCount?: number;
    identityFallbackMs?: number;
    identityRecheckMs?: number;
    recoveryIntervalMs?: number;
    unreadableOwnerIdentityPids?: number[];
    forcePsIdentity?: boolean;
    writerEnv?: Pick<NodeJS.ProcessEnv, "LC_ALL" | "TZ">;
    diagnosticPath?: string;
    completionPath?: string;
  };
}

export function spawnLoggedProcess(args: SpawnLoggedProcessArgs): ChildProcess {
  mkdirSync(args.logDir, { recursive: true });
  const logPath = join(args.logDir, `${args.logName}-stdio.log`);
  const logWriter = spawn(
    process.execPath,
    [
      "-e",
      stdioLogWriter,
      logPath,
      JSON.stringify(args.testWriterBarrier ?? null),
    ],
    {
      detached: true,
      env: { ...process.env, ...args.testWriterBarrier?.writerEnv },
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  logWriter.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    if (args.testWriterBarrier?.diagnosticPath !== undefined) {
      try {
        appendFileSync(args.testWriterBarrier.diagnosticPath, chunk);
      } catch (error) {
        process.stderr.write(
          `[bb] could not capture stdio writer diagnostic: ${String(error)}\n`,
        );
      }
    }
  });
  logWriter.unref();
  const child = spawn(args.command, args.args, {
    cwd: process.cwd(),
    env: args.env,
    stdio:
      args.ipc === true
        ? ["ignore", logWriter.stdin, logWriter.stdin, "ipc"]
        : ["ignore", logWriter.stdin, logWriter.stdin],
  });
  logWriter.stdin?.destroy();
  return child;
}
