import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { hookCommandFor } from "./native-hook-spool.js";
import type {
  ProviderNativeTerminalActivity,
  ProviderNativeTerminalRecordMatch,
} from "@bb/domain";

export type NativeActivityState = "working" | "idle";

export interface NativeQuestion {
  id: string;
  prompt: string;
}

export interface NativeToolCall {
  id: string;
  base: string;
  key: string;
}

export interface NativeActivitySignal {
  state: NativeActivityState | null;
  prompt: string | null;
  question?: NativeQuestion;
  answered?: string;
  occurrence?: true;
  call?: NativeToolCall;
  callId?: string;
  inputKey?: string;
}

export type NativeActivityReport =
  | { state: NativeActivityState; prompt: string | null; confirms?: false }
  | { state: "waiting"; prompt: null; questions: NativeQuestion[] };

type ActivityHooks = NonNullable<ProviderNativeTerminalActivity["hooks"]>;
type ActivityTranscript = NonNullable<
  ProviderNativeTerminalActivity["transcript"]
>;

const MAX_PROMPT_LENGTH = 4_000;
const MAX_ORPHAN_BASES = 256;
const MAX_ANNOUNCED_CALLS = 256;
const TOOL_CALL_ID_FIELD = "tool_use_id";
const TOOL_INPUT_FIELD = "tool_input";

const MAX_READ_BYTES = 4 * 1024 * 1024;

export function readRecordField(value: unknown, fieldPath: string): unknown {
  let current = value;
  for (const key of fieldPath.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function nativeActivityHookSettings(
  hooks: ActivityHooks,
  capture: string | { appendFile: string },
): string {
  const command = hookCommandFor(capture);
  const entries = [
    ...new Set([
      ...hooks.working,
      ...hooks.idle,
      ...(hooks.pending ?? []),
      ...(hooks.permission?.open ?? []),
      ...(hooks.permission?.close ?? []),
    ]),
  ].map(
    (event) => [event, [{ hooks: [{ type: "command", command }] }]] as const,
  );
  return JSON.stringify({ hooks: Object.fromEntries(entries) });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function toolInputKey(record: unknown): string | undefined {
  const input = readRecordField(record, TOOL_INPUT_FIELD);
  if (typeof input !== "object" || input === null) return undefined;
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function toolCallId(record: unknown): string | undefined {
  const id = readRecordField(record, TOOL_CALL_ID_FIELD);
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function announcedToolCall(
  permission: NonNullable<ActivityHooks["permission"]>,
  record: unknown,
): NativeToolCall | undefined {
  const tool = readRecordField(record, permission.idField);
  const id = toolCallId(record);
  const key = toolInputKey(record);
  if (typeof tool !== "string" || tool.length === 0) return undefined;
  if (id === undefined || key === undefined) return undefined;
  return { id, base: `permission:${tool}`, key };
}

function promptText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length === 0 ? null : text.slice(0, MAX_PROMPT_LENGTH);
}

export function classifyHookRecord(
  hooks: ActivityHooks,
  record: unknown,
): NativeActivitySignal {
  const event = readRecordField(record, "hook_event_name");
  if (typeof event !== "string") return { state: null, prompt: null };
  const permission = hooks.permission;
  const inputKey = toolInputKey(record);
  if (permission !== undefined) {
    const id = readRecordField(record, permission.idField);
    if (typeof id === "string" && id.length > 0) {
      if (permission.open.includes(event)) {
        if (permission.skip?.includes(id)) return { state: null, prompt: null };
        return {
          state: null,
          prompt: null,
          question: {
            id: `permission:${id}`,
            prompt: `${permission.label}: ${id}`,
          },
          occurrence: true,
          ...(toolCallId(record) === undefined
            ? {}
            : { callId: toolCallId(record) }),
          ...(inputKey === undefined ? {} : { inputKey }),
        };
      }
      if (permission.close.includes(event)) {
        const callId = toolCallId(record);
        return {
          state: null,
          prompt: null,
          answered: `permission:${id}`,
          occurrence: true,
          ...(callId === undefined ? {} : { callId }),
          ...(inputKey === undefined ? {} : { inputKey }),
        };
      }
    }
  }
  if (hooks.working.includes(event)) {
    const call =
      permission === undefined
        ? undefined
        : announcedToolCall(permission, record);
    return {
      state: "working",
      prompt: promptText(readRecordField(record, hooks.promptField)),
      ...(call === undefined ? {} : { call }),
    };
  }
  if (hooks.idle.includes(event)) return { state: "idle", prompt: null };
  return { state: null, prompt: null };
}

export function recordMatches(
  match: ProviderNativeTerminalRecordMatch,
  record: unknown,
): boolean {
  for (const [field, expected] of Object.entries(match.equals)) {
    if (readRecordField(record, field) !== expected) return false;
  }
  for (const [field, prefix] of Object.entries(match.startsWith ?? {})) {
    const value = readRecordField(record, field);
    if (typeof value !== "string" || !value.startsWith(prefix)) return false;
  }
  return true;
}

export function classifyTranscriptRecord(
  transcript: ActivityTranscript,
  record: unknown,
): NativeActivitySignal {
  for (const rule of transcript.questions?.open ?? []) {
    if (!recordMatches(rule.match, record)) continue;
    const id = readRecordField(record, rule.id);
    if (typeof id !== "string" || id.length === 0) continue;
    return {
      state: null,
      prompt: null,
      question: {
        id,
        prompt:
          (rule.prompt === undefined
            ? null
            : promptText(readRecordField(record, rule.prompt))) ?? rule.label,
      },
    };
  }
  for (const rule of transcript.questions?.close ?? []) {
    if (!recordMatches(rule.match, record)) continue;
    const id = readRecordField(record, rule.id);
    if (typeof id === "string" && id.length > 0) {
      return { state: null, prompt: null, answered: id };
    }
  }
  for (const rule of transcript.prompt) {
    if (recordMatches(rule.match, record)) {
      const prompt = promptText(readRecordField(record, rule.text));
      if (prompt !== null) return { state: "working", prompt };
    }
  }
  if (transcript.idle.some((match) => recordMatches(match, record))) {
    return { state: "idle", prompt: null };
  }
  if (transcript.working.some((match) => recordMatches(match, record))) {
    return { state: "working", prompt: null };
  }
  return { state: null, prompt: null };
}

export function fileSize(filePath: string): number | null {
  try {
    return statSync(filePath).size;
  } catch {
    return null;
  }
}

export interface JsonlRecordLocation {
  offset: number;
  length: number;
}

const TAIL_WINDOW_BYTES = 64 * 1024;

export function readTailJsonlRecords(filePath: string): unknown[] {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, "r");
    const size = statSync(filePath).size;
    const length = Math.min(size, TAIL_WINDOW_BYTES);
    if (length === 0) return [];
    const buffer = Buffer.alloc(length);
    const read = readSync(descriptor, buffer, 0, length, size - length);
    const lines = buffer.subarray(0, read).toString("utf8").split("\n");
    if (size > length) lines.shift();
    const records: unknown[] = [];
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    return records;
  } catch {
    return [];
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export class JsonlTail {
  private partial: Buffer = Buffer.alloc(0);

  constructor(private offset: number) {}

  readRecords(
    filePath: string,
    accept?: (record: unknown, location: JsonlRecordLocation) => void,
  ): unknown[] {
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      this.offset = 0;
      this.partial = Buffer.alloc(0);
    }
    if (size === this.offset) return [];
    const length = Math.min(size - this.offset, MAX_READ_BYTES);
    const buffer = Buffer.alloc(length);
    let read = 0;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(filePath, "r");
      read = readSync(descriptor, buffer, 0, length, this.offset);
    } catch {
      return [];
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
    const startOffset = this.offset - this.partial.length;
    this.offset += read;
    const contents =
      this.partial.length === 0
        ? buffer.subarray(0, read)
        : Buffer.concat([this.partial, buffer.subarray(0, read)]);
    const records: unknown[] = [];
    let start = 0;
    let end: number;
    while ((end = contents.indexOf(10, start)) !== -1) {
      const line = contents.subarray(start, end).toString("utf8");
      const location = { offset: startOffset + start, length: end - start };
      start = end + 1;
      if (line.trim().length === 0) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (accept === undefined) records.push(record);
      else accept(record, location);
    }
    this.partial = Buffer.from(contents.subarray(start));
    return records;
  }
}

const MAX_QUESTION_BASE_ID_LENGTH = 200;
let holderNonce: string | null = null;

function orphanKey(base: string, key: string): string {
  return `${base}\u0000${key}`;
}

function occurrenceBase(questionId: string): string {
  return questionId.slice(0, MAX_QUESTION_BASE_ID_LENGTH);
}

function processHolderNonce(): string {
  holderNonce ??= randomBytes(8).toString("hex");
  return holderNonce;
}

interface OpenOccurrence {
  id: string;
  key: string | null;
  callId: string | null;
  candidateCallIds: string[];
  candidateGroupId: number | null;
  candidateGroupSize: number;
  candidateGroupDynamic: boolean;
}

interface AnnouncedCall {
  base: string;
  key: string;
  bound: boolean;
}

export class NativeActivityTracker {
  private state: NativeActivityState = "idle";
  private reportedPrompt: string | null = null;
  private readonly questions = new Map<string, string>();
  private readonly occurrenceCounters = new Map<string, number>();
  private readonly openOccurrences = new Map<string, OpenOccurrence[]>();
  private readonly announcedCalls = new Map<string, AnnouncedCall>();
  private readonly lastOrphanCloseSequence = new Map<string, number>();
  private candidateGroupCounter = 0;
  private lastClearSequence = 0;
  private lastObservedHookSequence = 0;
  private hasUnsequencedClear = false;

  constructor(private readonly nonce: string = processHolderNonce()) {}

  apply(
    signal: NativeActivitySignal,
    hookSequence: number | null = null,
  ): NativeActivityReport | null {
    if (hookSequence !== null) {
      this.lastObservedHookSequence = Math.max(
        this.lastObservedHookSequence,
        hookSequence,
      );
    }
    if (signal.call !== undefined) this.announceCall(signal.call);
    if (signal.question !== undefined) {
      return this.openQuestion(
        signal.occurrence === true
          ? this.startOccurrence(
              signal.question,
              signal.inputKey,
              signal.callId,
            )
          : signal.question,
      );
    }
    if (signal.answered !== undefined) {
      if (signal.occurrence !== true)
        return this.closeQuestion(signal.answered);
      const occurrences = this.endMatchingOccurrences(
        signal.answered,
        signal,
        hookSequence,
      );
      let report: NativeActivityReport | null = null;
      for (const occurrence of occurrences) {
        report = this.closeQuestion(occurrence);
      }
      return report;
    }
    if (signal.state === "idle") {
      this.clearQuestions(hookSequence);
      if (this.state === "idle") return null;
      this.state = "idle";
      this.reportedPrompt = null;
      return { state: "idle", prompt: null };
    }
    if (signal.state !== "working") return null;
    const newPrompt =
      signal.prompt !== null && signal.prompt !== this.reportedPrompt
        ? signal.prompt
        : null;
    if (newPrompt !== null) this.clearQuestions(hookSequence);
    if (this.state === "working" && newPrompt === null) return null;
    this.state = "working";
    if (newPrompt !== null) this.reportedPrompt = newPrompt;
    return { state: "working", prompt: newPrompt };
  }

  acceptsLate(
    signal: NativeActivitySignal,
    startedAtSec: number,
    hookSequence: number | null = null,
  ): boolean {
    if (signal.question === undefined || signal.occurrence !== true) {
      return false;
    }
    if (
      !Number.isInteger(startedAtSec) ||
      hookSequence === null ||
      this.hasUnsequencedClear ||
      hookSequence <= this.lastClearSequence
    )
      return false;
    const base = occurrenceBase(signal.question.id);
    const closedAt = Math.max(
      this.lastOrphanCloseSequence.get(base) ?? 0,
      signal.inputKey === undefined
        ? 0
        : (this.lastOrphanCloseSequence.get(orphanKey(base, signal.inputKey)) ??
            0),
    );
    return closedAt === 0 || hookSequence > closedAt;
  }

  heartbeat(): NativeActivityReport | null {
    if (this.questions.size > 0) return this.waitingReport();
    return this.state === "working" ? { state: "working", prompt: null } : null;
  }

  finish(): NativeActivityReport | null {
    return this.apply({ state: "idle", prompt: null });
  }

  private clearQuestions(hookSequence: number | null): void {
    this.questions.clear();
    this.openOccurrences.clear();
    this.announcedCalls.clear();
    if (hookSequence === null) this.hasUnsequencedClear = true;
    else {
      this.lastClearSequence = Math.max(this.lastClearSequence, hookSequence);
      this.hasUnsequencedClear = false;
    }
  }

  private announceCall(call: NativeToolCall): void {
    if (this.announcedCalls.has(call.id)) return;
    if (this.announcedCalls.size >= MAX_ANNOUNCED_CALLS) {
      const oldest = this.announcedCalls.keys().next().value;
      if (oldest !== undefined) this.announcedCalls.delete(oldest);
    }
    this.announcedCalls.set(call.id, {
      base: occurrenceBase(call.base),
      key: call.key,
      bound: false,
    });
    const groups = new Map<number, OpenOccurrence[]>();
    for (const [base, occurrences] of this.openOccurrences) {
      if (base !== occurrenceBase(call.base)) continue;
      for (const occurrence of occurrences) {
        if (
          occurrence.callId !== null ||
          occurrence.key !== call.key ||
          occurrence.candidateGroupId === null ||
          !occurrence.candidateGroupDynamic
        )
          continue;
        const group = groups.get(occurrence.candidateGroupId) ?? [];
        group.push(occurrence);
        groups.set(occurrence.candidateGroupId, group);
      }
    }
    for (const occurrences of groups.values()) {
      if (occurrences[0]?.candidateCallIds.includes(call.id)) continue;
      const firstCandidate = occurrences[0]?.candidateCallIds.length === 0;
      const candidateGroupSize = firstCandidate
        ? (occurrences[0]?.candidateGroupSize ?? 0) + 1
        : (occurrences[0]?.candidateGroupSize ?? 0);
      for (const occurrence of occurrences) {
        occurrence.candidateCallIds.push(call.id);
        occurrence.candidateGroupSize = candidateGroupSize;
      }
      const announced = this.announcedCalls.get(call.id);
      if (announced !== undefined) announced.bound = true;
    }
  }

  private bindAnnouncedCall(
    base: string,
    key: string | undefined,
    callId: string | undefined,
  ): {
    callId: string | null;
    candidateCallIds: string[];
    candidateGroupId: number | null;
    candidateGroupSize: number;
    candidateGroupDynamic: boolean;
  } {
    if (callId !== undefined) {
      const announced = this.announcedCalls.get(callId);
      if (announced !== undefined) announced.bound = true;
      return {
        callId,
        candidateCallIds: [],
        candidateGroupId: null,
        candidateGroupSize: 0,
        candidateGroupDynamic: false,
      };
    }
    if (key === undefined) {
      return {
        callId: null,
        candidateCallIds: [],
        candidateGroupId: null,
        candidateGroupSize: 0,
        candidateGroupDynamic: false,
      };
    }
    const candidates: string[] = [];
    for (const [id, call] of this.announcedCalls) {
      if (call.bound || call.base !== base || call.key !== key) continue;
      call.bound = true;
      candidates.push(id);
    }
    const freshCandidateCount = candidates.length;
    if (freshCandidateCount === 0) {
      const open = this.openOccurrences.get(base) ?? [];
      const candidateOccurrences = open.filter(
        (occurrence) =>
          occurrence.key === key && occurrence.candidateCallIds.length > 0,
      );
      const candidateCallIds = [
        ...new Set(
          candidateOccurrences.flatMap(({ candidateCallIds: ids }) => ids),
        ),
      ];
      if (candidateOccurrences.length < candidateCallIds.length) {
        const candidateGroupId = ++this.candidateGroupCounter;
        return {
          callId: null,
          candidateCallIds,
          candidateGroupId,
          candidateGroupSize: candidateCallIds.length,
          candidateGroupDynamic: candidateOccurrences.some(
            ({ candidateGroupDynamic }) => candidateGroupDynamic,
          ),
        };
      }
      const candidateGroupId = ++this.candidateGroupCounter;
      return {
        callId: null,
        candidateCallIds: [],
        candidateGroupId,
        candidateGroupSize: 0,
        candidateGroupDynamic: true,
      };
    }
    const uniqueCandidates = [...new Set(candidates)];
    if (uniqueCandidates.length === 1) {
      return {
        callId: uniqueCandidates[0]!,
        candidateCallIds: [],
        candidateGroupId: null,
        candidateGroupSize: 0,
        candidateGroupDynamic: false,
      };
    }
    const candidateGroupId = ++this.candidateGroupCounter;
    return {
      callId: null,
      candidateCallIds: uniqueCandidates,
      candidateGroupId,
      candidateGroupSize: uniqueCandidates.length,
      candidateGroupDynamic: false,
    };
  }

  private startOccurrence(
    question: NativeQuestion,
    key: string | undefined,
    callId: string | undefined,
  ): NativeQuestion {
    const base = occurrenceBase(question.id);
    const serial = (this.occurrenceCounters.get(base) ?? 0) + 1;
    this.occurrenceCounters.set(base, serial);
    const id = `${base}#${this.nonce}.${serial}`;
    const binding = this.bindAnnouncedCall(base, key, callId);
    this.openOccurrences.set(base, [
      ...(this.openOccurrences.get(base) ?? []),
      { id, key: key ?? null, ...binding },
    ]);
    return { id, prompt: question.prompt };
  }

  private endMatchingOccurrences(
    questionId: string,
    signal: NativeActivitySignal,
    hookSequence: number | null,
  ): string[] {
    const base = occurrenceBase(questionId);
    const open = this.openOccurrences.get(base) ?? [];
    const callId = signal.callId ?? null;
    const key = signal.inputKey ?? null;
    const announced =
      callId === null ? undefined : this.announcedCalls.get(callId);
    if (callId !== null) this.announcedCalls.delete(callId);
    const directOccurrences =
      callId === null
        ? []
        : open.filter((occurrence) => occurrence.callId === callId);
    const candidates =
      callId === null
        ? []
        : open.filter((occurrence) =>
            occurrence.candidateCallIds.includes(callId),
          );
    const candidateKey = candidates[0]?.key ?? announced?.key ?? key;
    const candidatePool =
      callId === null || candidateKey === null
        ? []
        : open.filter(
            (occurrence) =>
              occurrence.key === candidateKey &&
              occurrence.candidateCallIds.length > 0,
          );
    const candidateCallIds = new Set(
      candidatePool.flatMap(({ candidateCallIds }) => candidateCallIds),
    );
    const candidateCapacityMatches =
      candidatePool.length === candidateCallIds.size;
    if (callId !== null && candidates.length > 0) {
      for (const occurrence of open) {
        occurrence.candidateCallIds = occurrence.candidateCallIds.filter(
          (candidateId) => candidateId !== callId,
        );
      }
    }
    const settled =
      directOccurrences.length > 0
        ? directOccurrences
        : candidateCapacityMatches && candidates.length > 0
          ? [candidates[0]!]
          : [];
    if (settled.length > 0) {
      const settledIds = new Set(settled.map(({ id }) => id));
      const remaining = open.filter(
        (occurrence) => !settledIds.has(occurrence.id),
      );
      if (remaining.length === 0) this.openOccurrences.delete(base);
      else this.openOccurrences.set(base, remaining);
      return settled.map(({ id }) => id);
    }
    if (candidates.length > 0) {
      this.openOccurrences.set(base, open);
      return [];
    }
    let index = -1;
    if (
      index === -1 &&
      key !== null &&
      (announced === undefined || announced.key !== key)
    ) {
      index = open.findIndex(
        (occurrence) =>
          occurrence.key === key &&
          occurrence.candidateCallIds.length === 0 &&
          (callId === null || occurrence.callId === null),
      );
    }
    const matched = open[index];
    if (matched === undefined) {
      this.recordOrphanClose(
        base,
        [announced?.key, key ?? undefined],
        announced === undefined && open.length === 0,
        hookSequence,
      );
      return [];
    }
    if (open.length === 1) this.openOccurrences.delete(base);
    else
      this.openOccurrences.set(
        base,
        open.filter((_, i) => i !== index),
      );
    return [matched.id];
  }

  private recordOrphanClose(
    base: string,
    keys: ReadonlyArray<string | undefined>,
    wholeBase: boolean,
    hookSequence: number | null,
  ): void {
    const sequence = hookSequence ?? this.lastObservedHookSequence;
    if (wholeBase) this.lastOrphanCloseSequence.set(base, sequence);
    for (const key of keys) {
      if (key !== undefined)
        this.lastOrphanCloseSequence.set(orphanKey(base, key), sequence);
    }
    while (this.lastOrphanCloseSequence.size > MAX_ORPHAN_BASES) {
      const first = this.lastOrphanCloseSequence.keys().next().value;
      if (first === undefined) break;
      this.lastOrphanCloseSequence.delete(first);
    }
  }

  private openQuestion(question: NativeQuestion): NativeActivityReport | null {
    if (this.questions.get(question.id) === question.prompt) return null;
    this.state = "working";
    this.questions.set(question.id, question.prompt);
    return this.waitingReport();
  }

  private closeQuestion(id: string): NativeActivityReport | null {
    if (!this.questions.delete(id)) return null;
    return this.questions.size > 0
      ? this.waitingReport()
      : { state: "working", prompt: null };
  }

  private waitingReport(): NativeActivityReport {
    return {
      state: "waiting",
      prompt: null,
      questions: [...this.questions].map(([id, prompt]) => ({ id, prompt })),
    };
  }
}
