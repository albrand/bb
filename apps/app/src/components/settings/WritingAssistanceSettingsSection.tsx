import { useEffect, useState } from "react";
import {
  WRITING_VOCABULARY_MAX_TERMS,
  type CorrectionBehavior,
  type WritingMode,
} from "@bb/domain";
import { Input } from "@bb/shared-ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bb/shared-ui/select";
import { Switch } from "@bb/shared-ui/switch";
import { Textarea } from "@bb/shared-ui/textarea";
import {
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section";
import {
  useEditWritingVocabulary,
  useUpdateWritingAssistanceSettings,
  useWritingAssistanceView,
} from "@/hooks/queries/writing-assistance-queries";

const MODE_OPTIONS: readonly { value: WritingMode; label: string }[] = [
  { value: "prompt", label: "Prompt" },
  { value: "developer", label: "Developer" },
  { value: "natural", label: "Natural" },
  { value: "polished", label: "Polished" },
  { value: "verbatim", label: "Verbatim" },
  { value: "literal-code", label: "Literal code" },
];

const BEHAVIOR_OPTIONS: readonly {
  value: CorrectionBehavior;
  label: string;
}[] = [
  { value: "automatic", label: "Fix safe mistakes, suggest the rest" },
  { value: "suggest", label: "Suggest only" },
  { value: "off", label: "Off" },
];

const MODE_DESCRIPTIONS: Record<WritingMode, string> = {
  prompt: "Clear, structured agent instructions without changing requirements.",
  developer: "Technical accuracy; identifiers, paths and commands kept exact.",
  natural: "Everyday punctuation and grammar.",
  polished: "Smoother, more readable wording that keeps every fact.",
  verbatim: "Minimal changes to what you said or typed.",
  "literal-code": "Spoken symbols become code; prose is not corrected.",
};

function parseVocabulary(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/u)
        .map((term) => term.trim())
        .filter((term) => term.length > 0),
    ),
  ].slice(0, WRITING_VOCABULARY_MAX_TERMS);
}

export function vocabularyEdit(
  saved: readonly string[],
  edited: readonly string[],
): { add: string[]; remove: string[] } {
  return {
    add: edited.filter((term) => !saved.includes(term)),
    remove: saved.filter((term) => !edited.includes(term)),
  };
}

export function WritingAssistanceSettingsSection() {
  const view = useWritingAssistanceView();
  const update = useUpdateWritingAssistanceSettings();
  const editVocabulary = useEditWritingVocabulary();
  const settings = view.data?.settings;
  const [vocabulary, setVocabulary] = useState("");
  const savedVocabulary = settings?.vocabulary.join("\n") ?? "";
  useEffect(() => setVocabulary(savedVocabulary), [savedVocabulary]);

  if (settings === undefined) {
    return (
      <SettingsSection title="Writing assistance">
        <p className="text-sm text-muted-foreground">
          {view.isError
            ? "Could not load writing assistance settings."
            : "Loading…"}
        </p>
      </SettingsSection>
    );
  }
  const usage = view.data?.usage;
  const disabled = update.isPending;

  return (
    <SettingsSection
      title="Writing assistance"
      description={
        view.data?.correctionAvailable
          ? "Formats dictation and corrects typing in the native terminal composer. Uses the Writing assistance AI service."
          : "No AI service is ready for Writing assistance. Choose one in AI services; dictation still inserts the plain transcript."
      }
    >
      <div className="space-y-5">
        <SettingsWithControl
          label="Style"
          description={MODE_DESCRIPTIONS[settings.mode]}
        >
          <Select
            value={settings.mode}
            disabled={disabled}
            onValueChange={(value) =>
              update.mutate({ mode: value as WritingMode })
            }
          >
            <SelectTrigger className="w-44" aria-label="Writing style">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsWithControl>
        <SettingsWithControl
          label="Correct while typing"
          description="Only capitalizing a sentence's first word or I, and spacing, inside a sentence that already ends with . ! or ? (other case changes, such as turkey to Turkey, are suggestions), removing a short function word typed twice with only spaces between (such as the, a, I, of or de; never very, had, that, is, her, in or a negation), a lowercase a to an or an to a, and accents on a lowercase nao, voce, tambem, entao or amanha apply by themselves, never inside code, paths, identifiers, vocabulary terms or quoted text. Everything else, including spelling, other punctuation, verb agreement such as is to are, and tense or plural changes, is a suggestion."
        >
          <Select
            value={settings.typingCorrection}
            disabled={disabled}
            onValueChange={(value) =>
              update.mutate({ typingCorrection: value as CorrectionBehavior })
            }
          >
            <SelectTrigger className="w-44" aria-label="Correct while typing">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BEHAVIOR_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsWithControl>
        <SettingsWithControl
          label="Format dictation"
          description="Adds punctuation, paragraphs and lists to what you dictate. Off inserts the transcript as heard."
        >
          <Switch
            checked={settings.dictationFormatting}
            disabled={disabled}
            aria-label="Format dictation"
            onCheckedChange={(checked) =>
              update.mutate({ dictationFormatting: checked })
            }
          />
        </SettingsWithControl>
        <SettingsWithControl
          label="Vocabulary"
          description="Names and terms sent as spelling hints with each request, one per line. Transcription may still mishear them."
          controlPlacement="trailing"
        >
          <Textarea
            value={vocabulary}
            rows={3}
            disabled={disabled}
            aria-label="Vocabulary"
            placeholder={"bb\nHermes\nuseSegmentedDictation"}
            onChange={(event) => setVocabulary(event.target.value)}
            onBlur={() => {
              const edit = vocabularyEdit(
                settings.vocabulary,
                parseVocabulary(vocabulary),
              );
              if (edit.add.length > 0 || edit.remove.length > 0) {
                editVocabulary.mutate({ ...edit, ifMissing: "ignore" });
              }
            }}
          />
        </SettingsWithControl>
        <SettingsWithControl
          label="Daily limits"
          description="Requests and dictation minutes per UTC day. When reached, typing assistance pauses and dictation stops; typing and sending keep working."
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              max={5000}
              className="w-20"
              aria-label="Daily writing requests"
              defaultValue={settings.dailyCorrectionLimit}
              disabled={disabled}
              onBlur={(event) => {
                const value = Number(event.target.value);
                if (
                  Number.isInteger(value) &&
                  value >= 0 &&
                  value <= 5000 &&
                  value !== settings.dailyCorrectionLimit
                ) {
                  update.mutate({ dailyCorrectionLimit: value });
                }
              }}
            />
            <span className="text-xs text-muted-foreground">requests</span>
            <Input
              type="number"
              min={0}
              max={1440}
              className="w-20"
              aria-label="Daily dictation minutes"
              defaultValue={settings.dailyDictationMinutes}
              disabled={disabled}
              onBlur={(event) => {
                const value = Number(event.target.value);
                if (
                  Number.isInteger(value) &&
                  value >= 0 &&
                  value <= 1440 &&
                  value !== settings.dailyDictationMinutes
                ) {
                  update.mutate({ dailyDictationMinutes: value });
                }
              }}
            />
            <span className="text-xs text-muted-foreground">minutes</span>
          </div>
        </SettingsWithControl>
        {usage === undefined ? null : (
          <p className="text-xs text-muted-foreground" data-writing-usage="">
            Today: {usage.corrections + usage.formattings} requests,{" "}
            {(usage.audioSeconds / 60).toFixed(1)} min dictated, about $
            {(usage.estimatedCostMicros / 1_000_000).toFixed(3)} at list prices
            (estimate; bb cloud and Codex bill on their own terms).
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
