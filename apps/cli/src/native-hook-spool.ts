import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  rmdirSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const SEQUENCE_WIDTH = 12;
const SEQUENCE_NAME = /^\d{12}$/u;
const TEMP_NAME = /^\.tmp\.(\d+)\./u;
const MAX_RECORDS_PER_READ = 2_000;
const SCAN_INTERVAL_MS = 2_000;
export const SPOOL_SCAN_BATCH = 4_096;
export const MAX_LATE_PROBES_PER_SCAN = 256;
const FORWARD_PROBE_SPAN = 64;
const GAP_REPORT_AFTER_MS = 10_000;
const ABANDONED_TEMP_AGE_MS = 10 * 60_000;
const MAX_RESERVATIONS_PER_SCAN = 64;
const LOCK_WAIT_SECONDS = 20;
const LATE_FILE_NAME = /^\.late\.\d+\.(\d+)(?:\.(\d+))?$/u;
const APPEND_LOCK_NAME = "hooks.lock";
const ORPHANED_LOCK_AGE_MS = 10 * 60_000;
const LOST_MARKER_NAME = /^\.lost\./u;
const LOSS_MARK_NAME = ".loss";
const WRITE_BLOCKED_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EDQUOT",
  "EMFILE",
  "ENFILE",
  "ENOSPC",
  "EPERM",
  "EROFS",
]);
const INCOMPLETE_LINE_AFTER_MS = 10_000;
const MAX_APPEND_READ_BYTES = 4 * 1024 * 1024;
const NETWORK_FILESYSTEM_TYPES: ReadonlySet<number> = new Set([
  0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x01021997, 0x65735546, 0x5346414f,
  0x00c36400, 0x73757245,
]);

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function sequenceName(sequence: number): string {
  return String(sequence).padStart(SEQUENCE_WIDTH, "0");
}

export function createHookSpool(parent: string, label: string): string {
  return mkdtempSync(path.join(parent, `bb-native-activity-${label}-`));
}

export function removeHookSpool(directory: string): void {
  rmSync(directory, { force: true, recursive: true });
}

export function filesystemTypeOf(directory: string): number | null {
  if (process.platform !== "linux") return null;
  let current = directory;
  for (;;) {
    try {
      return Number(statfsSync(current).type);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

export function hookSpoolCandidates(args: {
  env: NodeJS.ProcessEnv;
  filesystemType?: (directory: string) => number | null;
  home: string;
  tmpDir: string;
}): string[] {
  const candidates = [args.tmpDir];
  const runtimeDir = args.env.XDG_RUNTIME_DIR;
  if (
    runtimeDir !== undefined &&
    path.isAbsolute(runtimeDir) &&
    isOwnedDirectory(runtimeDir)
  ) {
    candidates.push(runtimeDir);
  }
  candidates.push(path.join(args.home, ".bb", "native-terminals", "hooks"));
  const unique = [...new Set(candidates)];
  const typeOf = args.filesystemType ?? filesystemTypeOf;
  const isNetwork = (directory: string): boolean => {
    const type = typeOf(directory);
    return type !== null && NETWORK_FILESYSTEM_TYPES.has(type);
  };
  return [
    ...unique.filter((directory) => !isNetwork(directory)),
    ...unique.filter(isNetwork),
  ];
}

export function openHookSpool(
  candidates: readonly string[],
  label: string,
  supportsLinks: (directory: string) => boolean = hookSpoolSupportsLinks,
): string | null {
  for (const parent of candidates) {
    let directory: string;
    try {
      mkdirSync(parent, { mode: 0o700, recursive: true });
      directory = createHookSpool(parent, label);
    } catch {
      continue;
    }
    if (supportsLinks(directory)) return directory;
    removeHookSpool(directory);
  }
  return null;
}

export function openHookAppendFile(
  candidates: readonly string[],
  label: string,
): { directory: string; file: string } | null {
  for (const parent of candidates) {
    let directory: string;
    try {
      mkdirSync(parent, { mode: 0o700, recursive: true });
      directory = createHookSpool(parent, label);
    } catch {
      continue;
    }
    const file = path.join(directory, "hooks.jsonl");
    try {
      closeSync(openSync(file, "wx", 0o600));
      return { directory, file };
    } catch {
      removeHookSpool(directory);
    }
  }
  return null;
}

export type HookSource =
  | string
  | { appendFile: string }
  | { unavailable: true }
  | null;

export interface HookCapture {
  directory: string | null;
  source: Exclude<HookSource, null>;
}

export function openHookCapture(
  candidates: readonly string[],
  label: string,
  events: { appendFallback(): void; unsupported(): void },
  supportsLinks: (directory: string) => boolean = hookSpoolSupportsLinks,
): HookCapture {
  const spool = openHookSpool(candidates, label, supportsLinks);
  if (spool !== null) return { directory: spool, source: spool };
  const append = openHookAppendFile(candidates, label);
  if (append !== null) {
    events.appendFallback();
    return { directory: append.directory, source: { appendFile: append.file } };
  }
  events.unsupported();
  return { directory: null, source: { unavailable: true } };
}

export function hookSpoolSupportsLinks(directory: string): boolean {
  const source = path.join(directory, `.probe.${process.pid}`);
  const target = `${source}.link`;
  try {
    closeSync(openSync(source, "wx", 0o600));
    linkSync(source, target);
    return true;
  } catch {
    return false;
  } finally {
    for (const file of [source, target]) {
      try {
        unlinkSync(file);
      } catch {
        continue;
      }
    }
  }
}

export function hookSpoolCommand(directory: string): string {
  const spool = shellQuote(directory);
  return [
    "exec 2>/dev/null",
    `d=${spool}`,
    't=$(mktemp "$d/.tmp.$$.XXXXXX") || { printf x >>"$d/.loss"; exit 0; }',
    'cat >"$t" || exit 0',
    'n=$(cat "$d/.hint" 2>/dev/null)',
    "case \"$n\" in ''|*[!0-9]*) n=0;; esac",
    "while :; do n=$((n+1)); f=$(printf '%012d' \"$n\");" +
      ' if ln "$t" "$d/$f"; then break; fi;' +
      ' [ -e "$d/$f" ] || exit 0; done',
    'printf \'%s\' "$n" >"$d/.hint.$$" && mv -f "$d/.hint.$$" "$d/.hint"',
    'rm -f "$t"',
    "exit 0",
  ].join("; ");
}

export function hookAppendCommand(
  file: string,
  waitSeconds: number = LOCK_WAIT_SECONDS,
): string {
  return [
    "exec 2>/dev/null",
    `d=${shellQuote(path.dirname(file))}`,
    `f=${shellQuote(file)}`,
    'o="$d/.sequence"',
    'lq="$d/.sequence.lock"',
    "tries=0",
    'while ! /bin/ln -s "$$" "$lq" 2>/dev/null; do ' +
      'p=$(/bin/readlink "$lq" 2>/dev/null); case "$p" in \'\'|*[!0-9]*) p=0;; esac; ' +
      'if [ "$p" -gt 0 ] && ! kill -0 "$p" 2>/dev/null; then /bin/rm -f "$lq"; fi; ' +
      'tries=$((tries+1)); [ "$tries" -lt 2000 ] || exit 0; sleep 0.01; done',
    'n=$(cat "$o" 2>/dev/null); case "$n" in \'\'|*[!0-9]*) n=0;; esac; ' +
      'q=$((n+1)); printf \'%s\' "$q" >"$o.$$" && mv -f "$o.$$" "$o"; ' +
      '[ "$(/bin/readlink "$lq" 2>/dev/null)" = "$$" ] && /bin/rm -f "$lq"',
    `l="$d/${APPEND_LOCK_NAME}"`,
    'm="$d/.tmp.$$.mark"',
    ': >"$m" || exit 0',
    "r=$(cat) || exit 0",
    "s=$(date +%s)",
    "case \"$s\" in ''|*[!0-9]*) s=0;; esac",
    `e=$((s+${waitSeconds}))`,
    "w=0",
    "y=0",
    "z=0",
    "oi=",
    "os=0",
    "t=$(sed 's/^.*) //' \"/proc/$$/stat\" | cut -d' ' -f20)",
    "c=$$",
    'if [ -n "$t" ]; then c="$$:p$t"; else ' +
      't=$(ps -o lstart= -p "$$" | sed \'s/^ *//;s/ *$//\' | tr -s " " "_"); ' +
      'if [ -n "$t" ]; then c="$$:s$t"; fi; fi',
    "while :; do " +
      'if [ -d "$l" ] && [ ! -L "$l" ] && [ ! -e "$l/pid" ]; then ' +
      'i=$(ls -di "$l" 2>/dev/null); ' +
      'if [ "$i" != "$oi" ]; then oi=$i; os=$(date +%s); fi; ' +
      'if [ -n "$i" ] && [ "$(date +%s)" -ge "$((os+3))" ]; then rmdir "$l"; fi; ' +
      "else oi=; fi; " +
      'if ln -s "$c" "$l"; then ' +
      'if [ -L "$l" ] && [ "$(readlink "$l")" = "$c" ]; then break; fi; ' +
      'rm -f "$l/$c"; ' +
      'elif [ -L "$l" ]; then y=1; z=0; ' +
      'elif [ -e "$l" ]; then z=0; ' +
      "else z=$((z+1)); " +
      'if [ "$y" = 0 ] && [ "$z" -ge 3 ]; then ' +
      'if mkdir "$l"; then ' +
      'if ( set -C; printf \'%s\' "$c" >"$l/pid" ) ' +
      '&& [ "$(cat "$l/pid")" = "$c" ]; then break; fi; ' +
      'rmdir "$l"; fi; fi; fi; ' +
      'if ! [ "$(date +%s)" -lt "$e" ]; then ' +
      'printf \'%s\\n\' "$r" >"$d/.late.$$.tmp" ' +
      '&& mv -f "$d/.late.$$.tmp" "$d/.late.$$.$s.$q" && rm -f "$m" ' +
      '|| mv -f "$m" "$d/.lost.$$"; exit 0; fi; ' +
      'if [ "$w" -lt 10 ]; then w=$((w+1)); else sleep 0.05 || sleep 1; fi; done',
    'printf \'%s\\t%s\\n\' "$q" "$r" >>"$f" && rm -f "$m"',
    'if [ -L "$l" ]; then [ "$(readlink "$l")" = "$c" ] && rm -f "$l"; ' +
      'elif [ -d "$l" ] && [ "$(cat "$l/pid")" = "$c" ]; then ' +
      'rm -f "$l/pid"; rmdir "$l"; fi',
    "exit 0",
  ].join("; ");
}

export function hookCommandFor(
  target: string | { appendFile: string },
): string {
  return typeof target === "string"
    ? hookSpoolCommand(target)
    : hookAppendCommand(target.appendFile);
}

export interface HookSpoolRead {
  late?: Array<{
    record: unknown;
    sequence: number | null;
    startedAt: number;
  }>;
  records: unknown[];
  sequenceWatermark?: number;
  unreadable: number;
}

const hookSequences = new WeakMap<object, number>();
const hookStartedAtSeconds = new WeakMap<object, number>();
const lateHookRecords = new WeakSet<object>();

export function hookSequenceOf(record: unknown): number | null {
  return typeof record === "object" && record !== null
    ? (hookSequences.get(record) ?? null)
    : null;
}

export function hookStartedAtSecondsOf(record: unknown): number | null {
  return typeof record === "object" && record !== null
    ? (hookStartedAtSeconds.get(record) ?? null)
    : null;
}

export function isLateHookRecord(record: unknown): boolean {
  return typeof record === "object" && record !== null
    ? lateHookRecords.has(record)
    : false;
}

export interface DirectoryBatch {
  done: boolean;
  names: string[];
}

export interface DirectoryCursor {
  close(): void;
  readBatch(max: number): DirectoryBatch;
}

export type OpenDirectoryCursor = (directory: string) => DirectoryCursor;

type PathState = "present" | "missing" | "unknown";

export type SpoolWriteState = "writable" | "blocked";

export type ProbeSpoolWritable = (directory: string) => SpoolWriteState;

function probeSpoolWritable(directory: string): SpoolWriteState {
  const probe = path.join(directory, `.probe.${process.pid}`);
  try {
    closeSync(openSync(probe, "wx", 0o600));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : "";
    return typeof code === "string" && WRITE_BLOCKED_CODES.has(code)
      ? "blocked"
      : "writable";
  }
  try {
    unlinkSync(probe);
  } catch {
    return "writable";
  }
  return "writable";
}

type StatPath = (file: string) => PathState;

function openDirectoryCursor(directory: string): DirectoryCursor {
  const handle = opendirSync(directory);
  return {
    close: () => {
      try {
        handle.closeSync();
      } catch {
        return;
      }
    },
    readBatch: (max) => {
      const names: string[] = [];
      while (names.length < max) {
        const entry = handle.readSync();
        if (entry === null) return { done: true, names };
        names.push(entry.name);
      }
      return { done: false, names };
    },
  };
}

interface ScanPass {
  cursor: DirectoryCursor;
  highest: number;
}

export class HookSpoolReader {
  private next = 1;
  private lastScanAt = 0;
  private pass: ScanPass | null = null;
  private lateRange = 0;
  private lateSequence = 0;
  private completedHighest = 0;
  private gapTarget = 0;
  private readonly missingCounted = new Set<number>();
  private gapSince: number | null = null;
  private gapCounted = false;
  private readonly skipped: Array<{ from: number; to: number }> = [];
  private readonly reportedLate = new Set<string>();
  private readonly reportedTemps = new Set<string>();
  private lossMarksSeen = 0;
  private writeBlocked = false;

  constructor(
    private readonly directory: string,
    private readonly openCursor: OpenDirectoryCursor = openDirectoryCursor,
    private readonly statPath: StatPath = pathState,
    private readonly probeWritable: ProbeSpoolWritable = probeSpoolWritable,
  ) {}

  read(now: number = Date.now()): HookSpoolRead {
    const records: unknown[] = [];
    let unreadable = this.drain(records);
    if (now - this.lastScanAt >= SCAN_INTERVAL_MS) {
      this.lastScanAt = now;
      unreadable += this.scan(now);
      unreadable += this.drain(records);
    }
    return { records, unreadable };
  }

  private drain(records: unknown[]): number {
    let unreadable = 0;
    for (let count = 0; count < MAX_RECORDS_PER_READ; count += 1) {
      const step = this.readNext();
      if (step.kind === "missing") break;
      records.push(...step.records);
      unreadable += step.unreadable + step.settle();
    }
    return unreadable;
  }

  readNext(): SpoolStep {
    const sequence = this.next;
    const file = path.join(this.directory, sequenceName(sequence));
    const content = readRegularFile(file);
    if (content.kind === "missing") return { kind: "missing" };
    this.next += 1;
    this.gapSince = null;
    if (content.kind !== "text") {
      return { kind: "consumed", records: [], settle: () => 0, unreadable: 1 };
    }
    const records: unknown[] = [];
    let unreadable = 0;
    try {
      records.push(JSON.parse(content.text));
    } catch {
      unreadable = 1;
    }
    return {
      kind: "consumed",
      records,
      settle: () => this.settleConsumed(file, sequence, content.identity),
      unreadable,
    };
  }

  private settleConsumed(
    file: string,
    sequence: number,
    identity: FileIdentity,
  ): number {
    const outcome = truncateRegularFile(file, identity, false);
    if (outcome === "replaced") {
      if (this.next === sequence + 1) this.next = sequence;
      return 1;
    }
    return outcome === "irregular" ? 1 : 0;
  }

  private readHint(): number {
    const content = readRegularFile(path.join(this.directory, ".hint"));
    if (content.kind !== "text") return 0;
    const text = content.text.trim();
    return /^\d+$/u.test(text) ? Number(text) : 0;
  }

  private confirmedHint(): number {
    const hint = this.readHint();
    if (hint <= this.next) return 0;
    return existsSync(path.join(this.directory, sequenceName(hint))) ? hint : 0;
  }

  private probeLate(): number {
    let lost = 0;
    let work = 0;
    let wraps = 0;
    while (work < MAX_LATE_PROBES_PER_SCAN && this.skipped.length > 0) {
      const range = this.skipped[this.lateRange];
      if (range === undefined) {
        wraps += 1;
        if (wraps > 1) break;
        this.lateRange = 0;
        this.lateSequence = 0;
        continue;
      }
      work += 1;
      if (this.lateSequence < range.from) this.lateSequence = range.from;
      if (this.lateSequence >= range.to) {
        this.lateRange += 1;
        this.lateSequence = 0;
        continue;
      }
      lost += this.settleLate(sequenceName(this.lateSequence));
      this.lateSequence += 1;
    }
    return lost;
  }

  private probeForward(): number {
    for (let offset = 1; offset <= FORWARD_PROBE_SPAN; offset += 1) {
      const sequence = this.next + offset;
      if (existsSync(path.join(this.directory, sequenceName(sequence)))) {
        return sequence;
      }
    }
    return 0;
  }

  private advancePass(now: number): number {
    let lost = 0;
    try {
      this.pass ??= {
        cursor: this.openCursor(this.directory),
        highest: 0,
      };
      const batch = this.pass.cursor.readBatch(SPOOL_SCAN_BATCH);
      for (const name of batch.names) {
        if (SEQUENCE_NAME.test(name)) {
          const sequence = Number(name);
          if (sequence > this.pass.highest) this.pass.highest = sequence;
          continue;
        }
        const temp = TEMP_NAME.exec(name);
        if (temp === null || this.reportedTemps.has(name)) continue;
        const state = tempState(this.directory, name, Number(temp[1]), now);
        if (state !== "dead") continue;
        this.reportedTemps.add(name);
        lost += 1;
      }
      if (batch.done) {
        this.pass.cursor.close();
        this.completedHighest = Math.max(
          this.completedHighest,
          this.pass.highest,
        );
        this.pass = null;
      }
    } catch {
      this.pass?.cursor.close();
      this.pass = null;
    }
    return lost;
  }

  private countLossMarks(): number {
    let size: number;
    try {
      size = statSync(path.join(this.directory, LOSS_MARK_NAME)).size;
    } catch {
      return 0;
    }
    const fresh = Math.max(0, size - this.lossMarksSeen);
    this.lossMarksSeen = size;
    return fresh;
  }

  private countWriteBlock(): number {
    const blocked = this.probeWritable(this.directory) === "blocked";
    const started = blocked && !this.writeBlocked;
    this.writeBlocked = blocked;
    return started ? 1 : 0;
  }

  private scan(now: number): number {
    let lost = this.probeLate();
    lost += this.countLossMarks();
    lost += this.countWriteBlock();
    lost += this.advancePass(now);
    let countedMissing = 0;
    if (this.gapTarget !== 0 && this.next >= this.gapTarget) {
      this.gapTarget = 0;
    }
    for (const counted of this.missingCounted) {
      if (counted <= this.next) this.missingCounted.delete(counted);
    }
    if (this.gapTarget !== 0) {
      const target = this.gapTarget;
      const file = path.join(this.directory, sequenceName(target));
      if (this.statPath(file) === "missing") {
        this.gapTarget = 0;
        if (!this.missingCounted.has(target)) {
          this.missingCounted.add(target);
          countedMissing = target;
          lost += 1;
        }
      }
    }
    const next = path.join(this.directory, sequenceName(this.next));
    const highest = existsSync(next)
      ? 0
      : Math.max(
          this.gapTarget,
          this.confirmedHint(),
          this.completedHighest,
          this.pass?.highest ?? 0,
          this.probeForward(),
        );
    if (highest <= this.next) {
      this.gapSince = null;
      this.gapCounted = false;
      return lost;
    }
    if (highest === countedMissing) this.gapCounted = true;
    this.gapTarget = highest;
    this.gapSince ??= now;
    if (now - this.gapSince >= GAP_REPORT_AFTER_MS) {
      const from = this.next;
      let outcome: ReturnType<typeof reserveSequence> = "reserved";
      while (
        this.next < highest &&
        this.next - from < MAX_RESERVATIONS_PER_SCAN
      ) {
        outcome = reserveSequence(this.directory, this.next);
        if (outcome !== "reserved") break;
        this.next += 1;
      }
      if (this.next > from) {
        const last = this.skipped[this.skipped.length - 1];
        if (last !== undefined && last.to === from) last.to = this.next;
        else this.skipped.push({ from, to: this.next });
      }
      if ((this.next > from || outcome === "failed") && !this.gapCounted) {
        this.gapCounted = true;
        lost += 1;
      }
      if (outcome === "present" || this.next >= highest) {
        this.gapSince = null;
        this.gapCounted = false;
      }
    }
    return lost;
  }

  private settleLate(name: string): number {
    if (this.reportedLate.has(name)) return 0;
    const outcome = truncateRegularFile(
      path.join(this.directory, name),
      null,
      false,
    );
    if (outcome === "missing" || outcome === "empty" || outcome === "error") {
      return 0;
    }
    this.reportedLate.add(name);
    return 1;
  }
}

function pathState(file: string): PathState {
  try {
    lstatSync(file);
    return "present";
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? "missing"
      : "unknown";
  }
}

export function reserveSequence(
  directory: string,
  sequence: number,
): "reserved" | "present" | "failed" {
  try {
    closeSync(
      openSync(path.join(directory, sequenceName(sequence)), "wx", 0o600),
    );
    return "reserved";
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EEXIST"
      ? "present"
      : "failed";
  }
}

type RegularRead =
  | { kind: "text"; text: string; identity: FileIdentity }
  | { kind: "missing" }
  | { kind: "irregular" }
  | { kind: "error" };

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

export type SpoolStep =
  | { kind: "missing" }
  | {
      kind: "consumed";
      records: unknown[];
      settle(): number;
      unreadable: number;
    };

const NO_FOLLOW_NO_BLOCK = constants.O_NONBLOCK | constants.O_NOFOLLOW;

function readRegularFile(file: string): RegularRead {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | NO_FOLLOW_NO_BLOCK);
  } catch (error) {
    if (isMissing(error)) return { kind: "missing" };
    return isSymlinkRefusal(error) ? { kind: "irregular" } : { kind: "error" };
  }
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    if (!stats.isFile()) return { kind: "irregular" };
    return {
      identity: { dev: stats.dev, ino: stats.ino },
      kind: "text",
      text: readFileSync(descriptor, "utf8"),
    };
  } catch {
    return { kind: "error" };
  } finally {
    closeSync(descriptor);
  }
}

type TruncateOutcome =
  | "empty"
  | "error"
  | "irregular"
  | "linked"
  | "missing"
  | "replaced"
  | "truncated";

function truncateRegularFile(
  file: string,
  identity: FileIdentity | null,
  requireSingleLink: boolean,
): TruncateOutcome {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_WRONLY | NO_FOLLOW_NO_BLOCK);
  } catch (error) {
    if (isMissing(error)) return "missing";
    return isSymlinkRefusal(error) || isNoDevice(error) ? "irregular" : "error";
  }
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    if (!stats.isFile()) return "irregular";
    if (
      identity !== null &&
      (stats.dev !== identity.dev || stats.ino !== identity.ino)
    ) {
      return "replaced";
    }
    if (requireSingleLink && stats.nlink !== 1n) return "linked";
    if (stats.size === 0n) return "empty";
    ftruncateSync(descriptor, 0);
    return "truncated";
  } catch {
    return "error";
  } finally {
    closeSync(descriptor);
  }
}

function isNoDevice(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENXIO";
}

function isSymlinkRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ELOOP" || error.code === "EMLINK")
  );
}

function lockHolderText(lock: string, stats: Stats): string | null {
  if (stats.isSymbolicLink()) {
    try {
      return readlinkSync(lock);
    } catch {
      return null;
    }
  }
  const content = readRegularFile(path.join(lock, "pid"));
  return content.kind === "text" ? content.text : null;
}

const LOCK_START_FORMS =
  /^(?:p\d+|s[^\s_]+_[^\s_]+_\d{1,2}_\d{2}:\d{2}:\d{2}_\d{4})$/u;

interface LockHolder {
  pid: number;
  start: string | null;
}

function parseLockHolder(text: string | null): LockHolder | null {
  if (text === null) return null;
  const match = /^(\d+)(.*)$/su.exec(text.trim());
  const pid = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const rest = match?.[2] ?? "";
  const start = rest.startsWith(":") ? rest.slice(1) : "";
  return { pid, start: LOCK_START_FORMS.test(start) ? start : null };
}

function procStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const field = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
    return field !== undefined && /^\d+$/u.test(field) ? `p${field}` : null;
  } catch {
    return null;
  }
}

function psStartTime(pid: number): string | null {
  try {
    const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return output === "" ? null : `s${output.replace(/\s+/gu, "_")}`;
  } catch {
    return null;
  }
}

export function processStartTime(pid: number): string | null {
  return procStartTime(pid) ?? psStartTime(pid);
}

function lockHolderIsGone(
  holder: LockHolder,
  startTimeOf: (pid: number) => string | null,
): boolean {
  if (!processIsAlive(holder.pid)) return true;
  if (holder.start === null) return false;
  const current = startTimeOf(holder.pid);
  return (
    current !== null &&
    current.charAt(0) === holder.start.charAt(0) &&
    current !== holder.start
  );
}

function tempState(
  directory: string,
  name: string,
  pid: number,
  now: number,
): "alive" | "dead" | "published" {
  let stats: Stats;
  try {
    stats = statSync(path.join(directory, name));
  } catch {
    return "published";
  }
  if (stats.nlink > 1) return "published";
  if (now - stats.mtimeMs > ABANDONED_TEMP_AGE_MS) return "dead";
  return processIsAlive(pid) ? "alive" : "dead";
}

function isInFlightOrPublished(
  directory: string,
  name: string,
  pid: number,
  now: number,
): boolean {
  return tempState(directory, name, pid, now) !== "dead";
}

function isOwnedDirectory(directory: string): boolean {
  try {
    const stats = statSync(directory);
    return (
      stats.isDirectory() &&
      (process.getuid === undefined || stats.uid === process.getuid())
    );
  } catch {
    return false;
  }
}

export interface MainSnapshot {
  descriptor: number | null;
  key: string | null;
  kind: "irregular" | "missing" | "regular";
  size: number;
}

export class HookAppendReader {
  private offset = 0;
  private lastScanAt = 0;
  private incompleteSince: number | null = null;
  private incompleteOffset = -1;
  private incompleteCounted = false;
  private readonly seenLate = new Set<string>();
  private regularKey: string | null = null;
  private irregularKey: string | null = null;
  private readonly reportedMarkers = new Set<string>();

  constructor(
    private readonly file: string,
    private readonly beforeLockRemoval: () => void = () => undefined,
    private readonly startTimeOf: (
      pid: number,
    ) => string | null = processStartTime,
  ) {}

  read(now: number = Date.now()): HookSpoolRead {
    const snapshot = this.takeSnapshot();
    const late = this.readLate();
    const result = this.readLines(now, snapshot);
    const sequenceState = readRegularFile(
      path.join(path.dirname(this.file), ".sequence"),
    );
    if (sequenceState.kind === "text" && /^\d+$/u.test(sequenceState.text)) {
      Object.defineProperty(result, "sequenceWatermark", {
        value: Number(sequenceState.text),
      });
    }
    result.unreadable += late.lost;
    if (late.records.length > 0) result.late = late.records;
    if (now - this.lastScanAt >= SCAN_INTERVAL_MS) {
      this.lastScanAt = now;
      result.unreadable += this.breakStaleLock(now) + this.scanMarkers(now);
    }
    return result;
  }

  takeSnapshot(): MainSnapshot {
    let descriptor: number;
    try {
      descriptor = openSync(this.file, constants.O_RDONLY | NO_FOLLOW_NO_BLOCK);
    } catch (error) {
      return isMissing(error)
        ? { descriptor: null, key: null, kind: "missing", size: 0 }
        : { descriptor: null, key: "open-error", kind: "irregular", size: 0 };
    }
    try {
      const stats = fstatSync(descriptor, { bigint: true });
      if (!stats.isFile()) {
        closeSync(descriptor);
        return {
          descriptor: null,
          key: `irregular:${stats.dev}:${stats.ino}`,
          kind: "irregular",
          size: 0,
        };
      }
      return {
        descriptor,
        key: `file:${stats.dev}:${stats.ino}`,
        kind: "regular",
        size: Number(stats.size),
      };
    } catch {
      closeSync(descriptor);
      return {
        descriptor: null,
        key: "open-error",
        kind: "irregular",
        size: 0,
      };
    }
  }

  private observeMain(snapshot: MainSnapshot): number {
    if (snapshot.kind === "missing") return 0;
    if (snapshot.kind === "irregular") {
      const sameEpisode = this.irregularKey === snapshot.key;
      this.irregularKey = snapshot.key;
      return sameEpisode ? 0 : 1;
    }
    const comingFromIrregular = this.irregularKey !== null;
    this.irregularKey = null;
    const changedKey =
      this.regularKey !== null && this.regularKey !== snapshot.key;
    const shrunk = snapshot.size < this.offset;
    this.regularKey = snapshot.key;
    if (!changedKey && !shrunk) return 0;
    this.offset = 0;
    this.incompleteSince = null;
    return shrunk || !comingFromIrregular ? 1 : 0;
  }

  listLate(): Array<{
    name: string;
    sequence: number | null;
    startedAt: number;
  }> {
    let names: string[];
    try {
      names = readdirSync(path.dirname(this.file));
    } catch {
      return [];
    }
    const fresh: Array<{
      name: string;
      sequence: number | null;
      startedAt: number;
    }> = [];
    for (const name of names.sort()) {
      const match = LATE_FILE_NAME.exec(name);
      if (match === null || this.seenLate.has(name)) continue;
      fresh.push({
        name,
        sequence: match[2] === undefined ? null : Number(match[2]),
        startedAt: Number(match[1]),
      });
    }
    return fresh;
  }

  readLateFile(entry: {
    name: string;
    sequence: number | null;
    startedAt: number;
  }): {
    lost: number;
    record: {
      record: unknown;
      sequence: number | null;
      startedAt: number;
    } | null;
    settle(): number;
  } {
    this.seenLate.add(entry.name);
    const file = path.join(path.dirname(this.file), entry.name);
    const content = readRegularFile(file);
    if (content.kind !== "text") {
      return { lost: 1, record: null, settle: () => 0 };
    }
    let record: {
      record: unknown;
      sequence: number | null;
      startedAt: number;
    } | null = null;
    try {
      const parsed: unknown = JSON.parse(content.text);
      if (typeof parsed === "object" && parsed !== null) {
        if (entry.sequence !== null) hookSequences.set(parsed, entry.sequence);
        hookStartedAtSeconds.set(parsed, entry.startedAt);
        lateHookRecords.add(parsed);
      }
      record = {
        record: parsed,
        sequence: entry.sequence,
        startedAt: entry.startedAt,
      };
    } catch {
      record = null;
    }
    return {
      lost: 1,
      record,
      settle: () => {
        const outcome = truncateRegularFile(file, content.identity, true);
        if (outcome === "replaced") {
          this.seenLate.delete(entry.name);
          return 0;
        }
        return outcome === "linked" || outcome === "irregular" ? 1 : 0;
      },
    };
  }

  readLate(): {
    lost: number;
    records: Array<{
      record: unknown;
      sequence: number | null;
      startedAt: number;
    }>;
  } {
    const records: Array<{
      record: unknown;
      sequence: number | null;
      startedAt: number;
    }> = [];
    let lost = 0;
    for (const entry of this.listLate()) {
      const step = this.readLateFile(entry);
      lost += step.lost;
      if (step.record !== null) records.push(step.record);
      lost += step.settle();
    }
    return { lost, records };
  }

  readLines(now: number, snapshot: MainSnapshot): HookSpoolRead {
    const records: unknown[] = [];
    let unreadable = this.observeMain(snapshot);
    const descriptor = snapshot.descriptor;
    if (descriptor === null) return { records, unreadable };
    try {
      const actual = fstatSync(descriptor).size;
      const size = Math.min(actual, snapshot.size);
      const length = Math.min(size - this.offset, MAX_APPEND_READ_BYTES);
      if (length <= 0) {
        this.incompleteSince = null;
        return { records, unreadable };
      }
      const buffer = Buffer.alloc(length);
      const filled = readSync(descriptor, buffer, 0, length, this.offset);
      const text = buffer.subarray(0, filled);
      const end = text.lastIndexOf(0x0a);
      if (end < 0 && filled >= MAX_APPEND_READ_BYTES) {
        this.offset += filled;
        return { records, unreadable: unreadable + 1 };
      }
      const consumed = end + 1;
      this.offset += consumed;
      for (const line of text
        .subarray(0, consumed)
        .toString("utf8")
        .split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const split = /^(\d+)\t([\s\S]*)$/u.exec(line);
          const parsed: unknown = JSON.parse(split?.[2] ?? line);
          if (split !== null && typeof parsed === "object" && parsed !== null) {
            hookSequences.set(parsed, Number(split[1]));
          }
          records.push(parsed);
        } catch {
          unreadable += 1;
        }
      }
      unreadable += this.trackIncompleteLine(
        filled > consumed && this.offset + filled - consumed >= actual,
        now,
      );
    } catch {
      return { records, unreadable };
    } finally {
      closeSync(descriptor);
    }
    return { records, unreadable };
  }

  private trackIncompleteLine(incomplete: boolean, now: number): number {
    if (!incomplete) {
      this.incompleteSince = null;
      return 0;
    }
    if (
      this.incompleteSince === null ||
      this.incompleteOffset !== this.offset
    ) {
      this.incompleteSince = now;
      this.incompleteOffset = this.offset;
      this.incompleteCounted = false;
    }
    if (
      !this.incompleteCounted &&
      now - this.incompleteSince >= INCOMPLETE_LINE_AFTER_MS
    ) {
      this.incompleteCounted = true;
      return 1;
    }
    return 0;
  }

  private breakStaleLock(now: number): number {
    const lock = path.join(path.dirname(this.file), APPEND_LOCK_NAME);
    try {
      const stats = lstatSync(lock);
      const text = lockHolderText(lock, stats);
      const holder = parseLockHolder(text);
      const stale =
        holder === null
          ? now - stats.mtimeMs >= ORPHANED_LOCK_AGE_MS
          : lockHolderIsGone(holder, this.startTimeOf);
      if (!stale) return 0;
      this.beforeLockRemoval();
      if (stats.isSymbolicLink()) {
        if (readlinkSync(lock) !== text) return 0;
        unlinkSync(lock);
      } else if (text === null) {
        rmdirSync(lock);
      } else {
        const pidFile = path.join(lock, "pid");
        const again = readRegularFile(pidFile);
        if (again.kind !== "text" || again.text !== text) return 0;
        unlinkSync(pidFile);
        try {
          rmdirSync(lock);
        } catch {
          return 1;
        }
      }
      return 1;
    } catch {
      return 0;
    }
  }

  private scanMarkers(now: number): number {
    const directory = path.dirname(this.file);
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      return 0;
    }
    let lost = 0;
    for (const name of names) {
      if (this.reportedMarkers.has(name)) continue;
      const gaveUp = LOST_MARKER_NAME.test(name);
      const marker = TEMP_NAME.exec(name);
      if (
        !gaveUp &&
        (marker === null ||
          isInFlightOrPublished(directory, name, Number(marker[1]), now))
      ) {
        continue;
      }
      this.reportedMarkers.add(name);
      lost += 1;
    }
    return lost;
  }
}

export interface HookRecordSource {
  read(now?: number): HookSpoolRead;
}

export function hookRecordSource(source: HookSource): HookRecordSource | null {
  if (source === null) return null;
  if (typeof source === "string") return new HookSpoolReader(source);
  if ("appendFile" in source) return new HookAppendReader(source.appendFile);
  return null;
}

export function hookSourceIsUnavailable(source: HookSource): boolean {
  return (
    source !== null && typeof source === "object" && "unavailable" in source
  );
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
