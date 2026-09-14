import type { JsonValue } from "@bb/domain";

interface QuestionOption {
  value: string;
  label: string;
}

interface Question {
  id: string;
  prompt: string;
  options?: QuestionOption[];
}

function readQuestions(payload: unknown): Question[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return [];
  const questions = (data as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  return questions.filter(
    (question): question is Question =>
      typeof question === "object" &&
      question !== null &&
      typeof (question as Question).id === "string" &&
      typeof (question as Question).prompt === "string",
  );
}

function readAnswers(value: JsonValue): Record<string, string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const answers = (value as { answers?: unknown }).answers;
  if (typeof answers !== "object" || answers === null) return {};
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(answers)) {
    const list = Array.isArray(raw) ? raw : [raw];
    out[key] = list.filter((item): item is string => typeof item === "string");
  }
  return out;
}

function labelFor(question: Question, optionValue: string): string {
  const option = question.options?.find((item) => item.value === optionValue);
  return option?.label ?? optionValue;
}

export function buildUnclaimedAnswerMessage(
  payload: unknown,
  value: JsonValue,
): string | null {
  const questions = readQuestions(payload);
  const answers = readAnswers(value);
  const lines: string[] = [];
  for (const question of questions) {
    const chosen = answers[question.id];
    if (chosen === undefined || chosen.length === 0) continue;
    const labels = chosen.map((option) => labelFor(question, option));
    lines.push(`${question.prompt} — ${labels.join(", ")}`);
  }
  if (lines.length === 0) return null;
  return [
    "I answered the question you asked, but it had already timed out on your side, so you never received it. My answers:",
    ...lines.map((line) => `- ${line}`),
    "Continue from these.",
  ].join("\n");
}
