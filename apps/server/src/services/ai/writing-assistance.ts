import {
  addWritingUsage,
  getWritingAssistanceSettings,
  getWritingUsage,
  reserveWritingUsage,
  updateWritingAssistanceSettings,
} from "@bb/db";
import {
  normalizeDictatedText,
  wordTokens,
  proposedWritingEditSchema,
  resolveWritingEdits,
  validateFormattedTranscript,
  type DictationSegmentResponse,
  type ProposedWritingEdit,
  type WritingAssistanceSettings,
  type WritingAssistanceSettingsUpdate,
  type WritingAssistanceView,
  type WritingCorrectionRequest,
  type WritingCorrectionResponse,
  type WritingMode,
  type WritingSkipReason,
  type WritingUsage,
} from "@bb/domain";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { isAiTaskAvailable, runAiTask } from "./ai-tasks.js";
import { measureAudioSeconds } from "./audio-duration.js";
import { transcribeVoiceInput } from "./voice-transcription.js";

type WritingDeps = LoggedWorkSessionDeps;

const MAX_PROPOSALS = 24;
const MAX_FORMATTED_CHARS = 8_000;
const MAX_FORMATTED_WORDS = 70;
const DICTATION_CONTEXT_CHARS = 400;
const HINT_MAX_CHARS = 900;
const MAX_SEGMENT_DURATION_MS = 120_000;
const MEASURED_DURATION_SLACK_SECONDS = 1;
const TRANSCRIPTION_MICROS_PER_SECOND = 100;
const TEXT_INPUT_MICROS_PER_CHAR = 0.1;
const TEXT_OUTPUT_MICROS_PER_CHAR = 0.4;
const THINK_BLOCK = /<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/giu;

export function utcDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function estimateTextCostMicros(
  inputChars: number,
  outputChars: number,
): number {
  return Math.ceil(
    inputChars * TEXT_INPUT_MICROS_PER_CHAR +
      outputChars * TEXT_OUTPUT_MICROS_PER_CHAR,
  );
}

const MODE_GUIDANCE: Record<WritingMode, string> = {
  natural:
    "Everyday language. Fix spelling, grammar, punctuation and capitalization. Keep the writer's tone.",
  developer:
    "Technical writing for software work. Preserve identifiers, file paths, commands, versions, numbers and code exactly. Fix only language around them.",
  prompt:
    "Instructions for an AI coding agent. Make them clear and well punctuated, use lists for enumerated steps, and never add, drop or soften a requirement.",
  verbatim: "Minimal changes. Fix only obvious punctuation and capitalization.",
  polished:
    "Improve fluency and readability while keeping every fact, requirement and nuance.",
  "literal-code":
    'The user is dictating code. Convert spoken symbols to characters ("open paren" -> "(", "dot" -> ".", "equals" -> "="), keep identifiers exact and change nothing else.',
};

const SHARED_RULES = [
  "Never translate. Keep each sentence in the language it was written or spoken in (English, Brazilian Portuguese, or a mix).",
  "Never change meaning. Fluency is not evidence of correctness.",
  "Never alter text inside backticks, URLs, file paths, identifiers (camelCase, snake_case, dotted.names), commands, flags, version numbers, numbers, or the user's vocabulary terms.",
  "Do not add requirements, assumptions, emphasis, greetings or explanations.",
];

function vocabularyLine(settings: WritingAssistanceSettings): string {
  return settings.vocabulary.length === 0
    ? ""
    : `Vocabulary to spell exactly: ${settings.vocabulary.join(", ")}`;
}

export function buildCorrectionPrompt(
  settings: WritingAssistanceSettings,
  request: WritingCorrectionRequest,
): string {
  return [
    "You are a careful copy editor inside a developer tool. Propose minimal edits to TARGET.",
    `Mode: ${MODE_GUIDANCE[settings.mode]}`,
    ...SHARED_RULES,
    vocabularyLine(settings),
    request.complete
      ? "TARGET is made of finished sentences."
      : "TARGET ends with a sentence the user is still writing; do not finish it or add ending punctuation to its last sentence.",
    'Reply with JSON only: {"edits":[{"original":"...","replacement":"...","category":"spelling|grammar|punctuation|capitalization|structure|speech-recognition|word-choice|formatting","confidence":"high|medium|low","semanticImpact":"none|possible|likely","explanation":"at most six words, or null"}]}',
    "Return at most three edits, the most important first.",
    "`original` must be an exact substring of TARGET that occurs once; include a neighboring word when needed to make it unique. Keep each edit as small as possible.",
    'semanticImpact is "none" only when the meaning is certainly unchanged. A different content word is at least "possible".',
    'If nothing needs fixing reply {"edits":[]}.',
    "<context>",
    request.context,
    "</context>",
    "<target>",
    request.target,
    "</target>",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function buildDictationFormatPrompt(
  settings: WritingAssistanceSettings,
  transcript: string,
  context: string,
): string {
  return [
    "You format dictated speech for a developer tool's message box. Return only the formatted text.",
    `Mode: ${MODE_GUIDANCE[settings.mode]}`,
    ...SHARED_RULES,
    vocabularyLine(settings),
    "Infer sentence boundaries, commas, question marks, capitalization and paragraph breaks.",
    'Remove hesitations (um, uh, é, tipo when used as filler) and repeated words. When the speaker corrects themselves ("no wait", "I mean", "quer dizer"), keep only the corrected version.',
    "When the speaker enumerates steps (first, second, third / primeiro, segundo), write a numbered Markdown list. Do not turn ordinary conversation into lists or headings.",
    "Use only words the speaker said, apart from punctuation, list numbers and fixes to obvious misspellings.",
    "CONTEXT is text already in the message before this speech. Do not repeat it.",
    "<context>",
    context,
    "</context>",
    "<speech>",
    transcript,
    "</speech>",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function extractJsonObject(raw: string): unknown {
  const text = raw.replace(THINK_BLOCK, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function completeArrayObjects(text: string): unknown[] | null {
  const key = /"edits"\s*:\s*\[/u.exec(text);
  if (key === null) return null;
  const objects: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = key.index + key[0].length; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          return objects;
        }
        start = -1;
      }
    } else if (char === "]" && depth === 0) {
      return objects;
    }
  }
  return objects;
}

export function parseCorrectionReply(
  raw: string,
): ProposedWritingEdit[] | null {
  const parsed = extractJsonObject(raw);
  const edits =
    typeof parsed === "object" && parsed !== null
      ? Reflect.get(parsed, "edits")
      : completeArrayObjects(raw.replace(THINK_BLOCK, ""));
  if (!Array.isArray(edits)) return null;
  const proposals: ProposedWritingEdit[] = [];
  for (const entry of edits.slice(0, MAX_PROPOSALS)) {
    const result = proposedWritingEditSchema.safeParse(entry);
    if (result.success) proposals.push(result.data);
  }
  return proposals;
}

export function cleanFormattedReply(raw: string): string | null {
  let text = raw.replace(THINK_BLOCK, "").trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/u.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
  const tagged = /^<speech>([\s\S]*)<\/speech>$/u.exec(text);
  if (tagged?.[1] !== undefined) text = tagged[1].trim();
  if (text.length === 0 || text.length > MAX_FORMATTED_CHARS) return null;
  return normalizeDictatedText(text);
}

function correctionBudgetLeft(
  settings: WritingAssistanceSettings,
  usage: WritingUsage,
): boolean {
  return usage.corrections + usage.formattings < settings.dailyCorrectionLimit;
}

function skipped(
  reason: WritingSkipReason,
  message: string,
): WritingCorrectionResponse {
  return { status: "skipped", reason, message };
}

export async function correctWriting(
  deps: WritingDeps,
  request: WritingCorrectionRequest,
  signal: AbortSignal,
): Promise<WritingCorrectionResponse> {
  const settings = getWritingAssistanceSettings(deps.db);
  if (settings.typingCorrection === "off" || settings.mode === "literal-code") {
    return skipped("off", "Typing assistance is off");
  }
  const day = utcDay();
  const reserved = reserveWritingUsage(
    deps.db,
    day,
    { corrections: 1 },
    (usage) => correctionBudgetLeft(settings, usage),
  );
  if (reserved === null) {
    return skipped(
      "budget",
      `Daily writing assistance limit of ${settings.dailyCorrectionLimit} requests reached`,
    );
  }
  const prompt = buildCorrectionPrompt(settings, request);
  const outcome = await runAiTask(deps, {
    task: "writing",
    label: "Writing correction",
    signal,
    call: (service, callSignal) => {
      if (service.complete === null) {
        throw new Error("This service does not answer text prompts");
      }
      return service.complete(prompt, { signal: callSignal });
    },
    accept: (raw) => (typeof raw === "string" ? raw : null),
  });
  if (!outcome.ok) {
    addWritingUsage(deps.db, day, { corrections: -1 });
    if (outcome.reason === "cancelled") {
      throw new ApiError(400, "cancelled", "Writing correction was cancelled");
    }
    return skipped(
      outcome.reason === "off"
        ? "off"
        : outcome.reason === "timeout"
          ? "timeout"
          : outcome.reason === "unavailable"
            ? "unavailable"
            : "failed",
      outcome.message,
    );
  }
  addWritingUsage(deps.db, day, {
    inputChars: prompt.length,
    outputChars: outcome.value.length,
    estimatedCostMicros: estimateTextCostMicros(
      prompt.length,
      outcome.value.length,
    ),
  });
  const proposals = parseCorrectionReply(outcome.value);
  if (proposals === null) {
    return skipped("failed", "The AI service returned an unreadable reply");
  }
  return {
    status: "ok",
    edits: resolveWritingEdits({
      target: request.target,
      proposals,
      behavior: settings.typingCorrection,
      vocabulary: settings.vocabulary,
      complete: request.complete,
    }),
  };
}

async function formatDictation(
  deps: WritingDeps,
  settings: WritingAssistanceSettings,
  transcript: string,
  context: string,
  signal: AbortSignal,
): Promise<DictationSegmentResponse> {
  const raw = normalizeDictatedText(transcript);
  const unformatted = { raw, text: raw, formatted: false };
  if (
    !settings.dictationFormatting ||
    settings.mode === "verbatim" ||
    wordTokens(raw).length > MAX_FORMATTED_WORDS
  ) {
    return unformatted;
  }
  const day = utcDay();
  const reserved = reserveWritingUsage(
    deps.db,
    day,
    { formattings: 1 },
    (usage) => correctionBudgetLeft(settings, usage),
  );
  if (reserved === null) return unformatted;
  const prompt = buildDictationFormatPrompt(settings, raw, context);
  const outcome = await runAiTask(deps, {
    task: "writing",
    label: "Dictation formatting",
    signal,
    call: (service, callSignal) => {
      if (service.complete === null) {
        throw new Error("This service does not answer text prompts");
      }
      return service.complete(prompt, { signal: callSignal });
    },
    accept: (reply) =>
      typeof reply === "string" ? cleanFormattedReply(reply) : null,
  });
  if (!outcome.ok) {
    addWritingUsage(deps.db, day, { formattings: -1 });
    return unformatted;
  }
  addWritingUsage(deps.db, day, {
    inputChars: prompt.length,
    outputChars: outcome.value.length,
    estimatedCostMicros: estimateTextCostMicros(
      prompt.length,
      outcome.value.length,
    ),
  });
  const verdict = validateFormattedTranscript(
    raw,
    outcome.value,
    settings.vocabulary,
    { literalCode: settings.mode === "literal-code" },
  );
  if (!verdict.ok) {
    deps.logger.info(
      { reason: verdict.reason },
      "Dictation formatting rejected; keeping the transcript",
    );
    return unformatted;
  }
  return { raw, text: outcome.value, formatted: true };
}

function transcriptionHint(
  settings: WritingAssistanceSettings,
  context: string,
): string {
  const vocabulary =
    settings.vocabulary.length === 0
      ? ""
      : `Terms: ${settings.vocabulary.join(", ")}. `;
  const tail = context.slice(-DICTATION_CONTEXT_CHARS);
  return `${vocabulary}${tail}`.slice(-HINT_MAX_CHARS);
}

export async function transcribeDictationSegment(
  deps: WritingDeps,
  args: {
    file: File;
    context: string;
    signal: AbortSignal;
  },
): Promise<DictationSegmentResponse> {
  const measured = measureAudioSeconds(
    new Uint8Array(await args.file.arrayBuffer()),
  );
  if (measured === null || measured <= 0) {
    throw new ApiError(
      400,
      "invalid_request",
      "Unsupported or unreadable audio. Send WebM or Ogg with Opus, MP4 or M4A with AAC, MP3, or WAV.",
    );
  }
  if (
    measured >
    MAX_SEGMENT_DURATION_MS / 1000 + MEASURED_DURATION_SLACK_SECONDS
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      `Audio is ${Math.round(measured)} seconds long; a dictation segment can be at most ${MAX_SEGMENT_DURATION_MS / 1000} seconds`,
    );
  }
  const settings = getWritingAssistanceSettings(deps.db);
  const day = utcDay();
  const seconds = Math.ceil(measured * 10) / 10;
  const reserved = reserveWritingUsage(
    deps.db,
    day,
    { audioSeconds: seconds },
    (usage) =>
      usage.audioSeconds + seconds <= settings.dailyDictationMinutes * 60,
  );
  if (reserved === null) {
    throw new ApiError(
      429,
      "budget_exhausted",
      `Daily dictation limit of ${settings.dailyDictationMinutes} minutes reached. Raise it in Settings → Writing assistance or with \`bb settings writing set daily-dictation-minutes\`.`,
    );
  }
  const context = args.context.slice(-DICTATION_CONTEXT_CHARS);
  let transcript: string;
  try {
    transcript = await transcribeVoiceInput(deps, {
      file: args.file,
      prompt: transcriptionHint(settings, context),
      signal: args.signal,
    });
  } catch (error) {
    addWritingUsage(deps.db, day, { audioSeconds: -seconds });
    throw error;
  }
  addWritingUsage(deps.db, day, {
    dictationSegments: 1,
    estimatedCostMicros: Math.ceil(seconds * TRANSCRIPTION_MICROS_PER_SECOND),
  });
  if (normalizeDictatedText(transcript).length === 0) {
    return { raw: "", text: "", formatted: false };
  }
  return formatDictation(deps, settings, transcript, context, args.signal);
}

export function buildWritingAssistanceView(
  deps: WritingDeps,
): WritingAssistanceView {
  return {
    settings: getWritingAssistanceSettings(deps.db),
    usage: getWritingUsage(deps.db, utcDay()),
    correctionAvailable: isAiTaskAvailable(deps, "writing"),
  };
}

export function updateWritingAssistance(
  deps: WritingDeps,
  update: WritingAssistanceSettingsUpdate,
): WritingAssistanceView {
  updateWritingAssistanceSettings(deps.db, update);
  deps.hub.notifySystem(["config-changed"]);
  return buildWritingAssistanceView(deps);
}
