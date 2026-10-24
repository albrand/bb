import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Command } from "commander";
import {
  CORRECTION_BEHAVIORS,
  WRITING_MODES,
  correctionBehaviorSchema,
  writingModeSchema,
  type WritingAssistanceSettingsUpdate,
  type WritingAssistanceView,
} from "@bb/domain";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { outputJson } from "./helpers.js";

interface JsonOptions {
  json?: boolean;
}

interface TranscribeOptions extends JsonOptions {
  context?: string;
}

interface CorrectOptions extends JsonOptions {
  context?: string;
  partial?: boolean;
}

const SETTING_KEYS = [
  "mode",
  "typing-correction",
  "dictation-formatting",
  "daily-correction-limit",
  "daily-dictation-minutes",
] as const;

const AUDIO_TYPES: Record<string, string> = {
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

function parseCount(key: string, value: string, max: number): number {
  const parsed = Number(value);
  if (!/^\d+$/u.test(value) || parsed > max) {
    throw new Error(`${key} must be a whole number from 0 to ${max}`);
  }
  return parsed;
}

export function vocabularyTerms(terms: readonly string[]): string[] {
  return [
    ...new Set(terms.map((term) => term.trim()).filter((term) => term !== "")),
  ];
}

export function parseWritingSetting(
  key: string,
  value: string,
): WritingAssistanceSettingsUpdate {
  switch (key) {
    case "mode": {
      const mode = writingModeSchema.safeParse(value);
      if (!mode.success) {
        throw new Error(`mode must be one of: ${WRITING_MODES.join(", ")}`);
      }
      return { mode: mode.data };
    }
    case "typing-correction": {
      const behavior = correctionBehaviorSchema.safeParse(value);
      if (!behavior.success) {
        throw new Error(
          `typing-correction must be one of: ${CORRECTION_BEHAVIORS.join(", ")}`,
        );
      }
      return { typingCorrection: behavior.data };
    }
    case "dictation-formatting":
      if (value !== "on" && value !== "off") {
        throw new Error("dictation-formatting must be on or off");
      }
      return { dictationFormatting: value === "on" };
    case "daily-correction-limit":
      return { dailyCorrectionLimit: parseCount(key, value, 5_000) };
    case "daily-dictation-minutes":
      return { dailyDictationMinutes: parseCount(key, value, 1_440) };
    default:
      throw new Error(
        `Unknown setting '${key}'. Settings: ${SETTING_KEYS.join(", ")}`,
      );
  }
}

function printView(view: WritingAssistanceView): void {
  const { settings, usage } = view;
  console.log(`mode                     ${settings.mode}`);
  console.log(`typing-correction        ${settings.typingCorrection}`);
  console.log(
    `dictation-formatting     ${settings.dictationFormatting ? "on" : "off"}`,
  );
  console.log(`daily-correction-limit   ${settings.dailyCorrectionLimit}`);
  console.log(`daily-dictation-minutes  ${settings.dailyDictationMinutes}`);
  console.log(
    `vocabulary               ${settings.vocabulary.length === 0 ? "(none)" : settings.vocabulary.join(", ")}`,
  );
  console.log(
    `service                  ${view.correctionAvailable ? "ready" : "no writing AI service is ready (bb settings ai-services)"}`,
  );
  console.log("");
  console.log(`Today (${usage.day} UTC)`);
  console.log(
    `  requests      ${usage.corrections} corrections, ${usage.formattings} formattings`,
  );
  console.log(
    `  dictation     ${usage.dictationSegments} segments, ${(usage.audioSeconds / 60).toFixed(1)} min`,
  );
  console.log(
    `  estimated     $${(usage.estimatedCostMicros / 1_000_000).toFixed(4)} (list-price estimate, not a bill)`,
  );
}

export function registerWritingSettingsCommands(
  settings: Command,
  getUrl: () => string,
): void {
  const writing = settings
    .command("writing")
    .description(
      "Configure dictation formatting and typing correction in the composer",
    );

  writing
    .command("show", { isDefault: true })
    .description("Show writing assistance settings and today's usage")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOptions) => {
        const view = await createCliBbSdk(getUrl()).writingAssistance.view();
        if (outputJson(opts, view)) return;
        printView(view);
      }),
    );

  writing
    .command("set <key> <value>")
    .description(
      `Change a setting (${SETTING_KEYS.join(", ")}). Modes: ${WRITING_MODES.join(", ")}`,
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (key: string, value: string, opts: JsonOptions) => {
        const view = await createCliBbSdk(
          getUrl(),
        ).writingAssistance.updateSettings(parseWritingSetting(key, value));
        if (outputJson(opts, view)) return;
        printView(view);
      }),
    );

  const vocabulary = writing
    .command("vocabulary")
    .description(
      "Terms sent to transcription and correction as spelling hints",
    );
  vocabulary
    .command("add <terms...>")
    .description("Add terms")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terms: string[], opts: JsonOptions) => {
        const view = await createCliBbSdk(
          getUrl(),
        ).writingAssistance.editVocabulary({
          add: vocabularyTerms(terms),
          remove: [],
          ifMissing: "fail",
        });
        if (outputJson(opts, view)) return;
        console.log(view.settings.vocabulary.join("\n"));
      }),
    );
  vocabulary
    .command("remove <terms...>")
    .description(
      "Remove terms; changes nothing and fails if any term is not in the vocabulary",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terms: string[], opts: JsonOptions) => {
        const view = await createCliBbSdk(
          getUrl(),
        ).writingAssistance.editVocabulary({
          add: [],
          remove: vocabularyTerms(terms),
          ifMissing: "fail",
        });
        if (outputJson(opts, view)) return;
        console.log(view.settings.vocabulary.join("\n"));
      }),
    );

  writing
    .command("correct <text>")
    .description(
      "Run typing correction on text and print the edits it would apply or suggest",
    )
    .option("--context <text>", "Text that comes before, for context")
    .option("--partial", "The last sentence is still being written")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (text: string, opts: CorrectOptions) => {
        const result = await createCliBbSdk(getUrl()).writingAssistance.correct(
          {
            target: text,
            context: opts.context ?? "",
            complete: opts.partial !== true,
          },
        );
        if (outputJson(opts, result)) return;
        if (result.status === "skipped") {
          console.log(`Skipped (${result.reason}): ${result.message}`);
          return;
        }
        if (result.edits.length === 0) {
          console.log("No changes");
          return;
        }
        for (const edit of result.edits) {
          console.log(
            `${edit.disposition.padEnd(8)}${edit.category.padEnd(20)}"${edit.original}" → "${edit.replacement}"`,
          );
        }
      }),
    );

  writing
    .command("transcribe <audio-file>")
    .description(
      "Transcribe and format one dictation clip the way the composer does",
    )
    .option("--context <text>", "Text already in the message")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (path: string, opts: TranscribeOptions) => {
        const type = AUDIO_TYPES[extname(path).toLowerCase()];
        if (type === undefined) {
          throw new Error(
            `Unsupported audio file. Use ${Object.keys(AUDIO_TYPES).join(", ")}`,
          );
        }
        const file = new File([await readFile(path)], basename(path), { type });
        const result = await createCliBbSdk(
          getUrl(),
        ).writingAssistance.transcribeDictationSegment({
          file,
          context: opts.context ?? "",
        });
        if (outputJson(opts, result)) return;
        console.log(result.text);
      }),
    );
}
