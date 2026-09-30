import {
  USER_QUESTION_MAX_OPTIONS,
  USER_QUESTION_MAX_QUESTIONS,
  type PendingInteractionUserAnswer,
  type PendingInteractionUserQuestionQuestion,
  type UserQuestionPendingInteractionPayload,
  userQuestionPendingInteractionResolutionSchema,
} from "@bb/domain";

export interface McpElicitationRequest {
  serverName: string;
  message: string;
  mode?: string | undefined;
  requestedSchema?: unknown;
}

export type McpElicitationValue = string | number | boolean | string[];

export type McpElicitationResult =
  | { action: "accept"; content: Record<string, McpElicitationValue> }
  | { action: "decline"; reason: string }
  | { action: "cancel"; reason: string };

export interface RunMcpElicitationArgs {
  request: McpElicitationRequest;
  ask: (payload: UserQuestionPendingInteractionPayload) => Promise<unknown>;
  signal?: AbortSignal;
}

export const MCP_ELICITATION_MAX_ATTEMPTS = 3;

interface ElicitationOption {
  value: string;
  label: string;
}

type ElicitationFieldShape =
  | {
      kind: "text";
      minLength: number | null;
      maxLength: number | null;
      format: "email" | "uri" | "date" | "date-time" | null;
    }
  | {
      kind: "number";
      integer: boolean;
      minimum: number | null;
      maximum: number | null;
    }
  | { kind: "boolean" }
  | { kind: "single"; options: ElicitationOption[] }
  | {
      kind: "multi";
      options: ElicitationOption[];
      minItems: number | null;
      maxItems: number | null;
    };

type ElicitationField = ElicitationFieldShape & {
  key: string;
  questionId: string;
  label: string;
  description: string | null;
  required: boolean;
};

interface ElicitationForm {
  fields: ElicitationField[];
  confirmOnly: boolean;
}

class UnsupportedElicitationError extends Error {}

const CONFIRM_QUESTION_ID = "confirm";
const CONFIRM_ACCEPT_VALUE = "confirm:accept";
const CONFIRM_DECLINE_VALUE = "confirm:decline";
const TEXT_FORMATS = ["email", "uri", "date", "date-time"] as const;
const ANNOTATION_KEYWORDS = ["title", "description", "default"];
const FORM_KEYWORDS = [
  "$schema",
  "type",
  "properties",
  "required",
  "additionalProperties",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

function allowOnlyKeywords(
  record: Record<string, unknown>,
  keywords: readonly string[],
  context: string,
): void {
  const unsupported = Object.keys(record).find(
    (key) => !keywords.includes(key) && !ANNOTATION_KEYWORDS.includes(key),
  );
  if (unsupported !== undefined) {
    throw new UnsupportedElicitationError(
      `${context} uses the unsupported keyword ${unsupported}`,
    );
  }
}

function optionalText(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = ownValue(record, key);
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new UnsupportedElicitationError(`"${key}" must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = ownValue(record, key);
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new UnsupportedElicitationError(`"${key}" must be a finite number`);
  }
  return value;
}

function optionsFromConstList(list: unknown): ElicitationOption[] {
  if (!Array.isArray(list)) {
    throw new UnsupportedElicitationError("choices must be a list");
  }
  return list.map((entry) => {
    if (!isPlainObject(entry)) {
      throw new UnsupportedElicitationError("choices must be objects");
    }
    allowOnlyKeywords(entry, ["const"], "a choice");
    const value = ownValue(entry, "const");
    if (typeof value !== "string") {
      throw new UnsupportedElicitationError("choice values must be strings");
    }
    const title = optionalText(entry, "title");
    return { value, label: title ?? value };
  });
}

function optionsFromEnum(
  values: unknown,
  titles: unknown,
): ElicitationOption[] {
  if (!Array.isArray(values)) {
    throw new UnsupportedElicitationError("enum must be a list");
  }
  if (
    titles !== undefined &&
    (!Array.isArray(titles) || titles.length !== values.length)
  ) {
    throw new UnsupportedElicitationError("enumNames must match enum");
  }
  return values.map((value, index) => {
    if (typeof value !== "string") {
      throw new UnsupportedElicitationError("enum values must be strings");
    }
    const title: unknown = Array.isArray(titles) ? titles[index] : undefined;
    if (title !== undefined && typeof title !== "string") {
      throw new UnsupportedElicitationError("enumNames must be strings");
    }
    const label =
      typeof title === "string" && title.trim() ? title.trim() : value;
    return { value, label };
  });
}

function checkedOptions(options: ElicitationOption[]): ElicitationOption[] {
  if (options.length === 0) {
    throw new UnsupportedElicitationError("a choice field has no choices");
  }
  if (options.length > USER_QUESTION_MAX_OPTIONS) {
    throw new UnsupportedElicitationError(
      `a choice field has more than ${USER_QUESTION_MAX_OPTIONS} choices`,
    );
  }
  if (options.some((option) => option.value.trim().length === 0)) {
    throw new UnsupportedElicitationError("choice values cannot be blank");
  }
  if (new Set(options.map((option) => option.value)).size !== options.length) {
    throw new UnsupportedElicitationError("choice values must be unique");
  }
  return options;
}

function parseFieldShape(
  property: Record<string, unknown>,
): ElicitationFieldShape {
  const type = ownValue(property, "type");
  const oneOf = ownValue(property, "oneOf");
  const anyOf = ownValue(property, "anyOf");
  const enumValues = ownValue(property, "enum");
  if (type === "boolean") {
    allowOnlyKeywords(property, ["type"], "a yes/no field");
    return { kind: "boolean" };
  }
  if (type === "number" || type === "integer") {
    allowOnlyKeywords(
      property,
      ["type", "minimum", "maximum"],
      "a number field",
    );
    return {
      kind: "number",
      integer: type === "integer",
      minimum: optionalNumber(property, "minimum"),
      maximum: optionalNumber(property, "maximum"),
    };
  }
  if (type === "array") {
    allowOnlyKeywords(
      property,
      ["type", "items", "minItems", "maxItems", "uniqueItems"],
      "a list field",
    );
    const uniqueItems = ownValue(property, "uniqueItems");
    if (uniqueItems !== undefined && typeof uniqueItems !== "boolean") {
      throw new UnsupportedElicitationError("uniqueItems must be a boolean");
    }
    const items = ownValue(property, "items");
    if (!isPlainObject(items)) {
      throw new UnsupportedElicitationError("a list field has no items");
    }
    allowOnlyKeywords(
      items,
      ["type", "enum", "anyOf", "oneOf"],
      "a list field's items",
    );
    const itemType = ownValue(items, "type");
    if (itemType !== undefined && itemType !== "string") {
      throw new UnsupportedElicitationError("list items must be strings");
    }
    if (
      ["enum", "anyOf", "oneOf"].filter(
        (key) => ownValue(items, key) !== undefined,
      ).length > 1
    ) {
      throw new UnsupportedElicitationError(
        "list items combine several choice lists",
      );
    }
    const itemChoices = ownValue(items, "anyOf") ?? ownValue(items, "oneOf");
    const options =
      itemChoices !== undefined
        ? optionsFromConstList(itemChoices)
        : optionsFromEnum(ownValue(items, "enum"), undefined);
    return {
      kind: "multi",
      options: checkedOptions(options),
      minItems: optionalNumber(property, "minItems"),
      maxItems: optionalNumber(property, "maxItems"),
    };
  }
  if (type === "string" || type === undefined) {
    if (
      [oneOf, anyOf, enumValues].filter((choices) => choices !== undefined)
        .length > 1
    ) {
      throw new UnsupportedElicitationError(
        "a field combines several choice lists",
      );
    }
    if (oneOf !== undefined || anyOf !== undefined) {
      allowOnlyKeywords(property, ["type", "oneOf", "anyOf"], "a choice field");
      return {
        kind: "single",
        options: checkedOptions(optionsFromConstList(oneOf ?? anyOf)),
      };
    }
    if (enumValues !== undefined) {
      allowOnlyKeywords(
        property,
        ["type", "enum", "enumNames"],
        "a choice field",
      );
      return {
        kind: "single",
        options: checkedOptions(
          optionsFromEnum(enumValues, ownValue(property, "enumNames")),
        ),
      };
    }
    if (type === undefined) {
      throw new UnsupportedElicitationError("a field has no type");
    }
    allowOnlyKeywords(
      property,
      ["type", "minLength", "maxLength", "format"],
      "a text field",
    );
    const format = ownValue(property, "format");
    if (
      format !== undefined &&
      !TEXT_FORMATS.some((candidate) => candidate === format)
    ) {
      throw new UnsupportedElicitationError(
        `unsupported format ${String(format)}`,
      );
    }
    return {
      kind: "text",
      minLength: optionalNumber(property, "minLength"),
      maxLength: optionalNumber(property, "maxLength"),
      format: TEXT_FORMATS.find((candidate) => candidate === format) ?? null,
    };
  }
  throw new UnsupportedElicitationError(
    `unsupported field type ${String(type)}`,
  );
}

function parseElicitationForm(requestedSchema: unknown): ElicitationForm {
  if (!isPlainObject(requestedSchema)) {
    throw new UnsupportedElicitationError("the form has no schema");
  }
  allowOnlyKeywords(requestedSchema, FORM_KEYWORDS, "the form");
  const schemaType = ownValue(requestedSchema, "type");
  if (schemaType !== undefined && schemaType !== "object") {
    throw new UnsupportedElicitationError("the form schema is not an object");
  }
  const properties = ownValue(requestedSchema, "properties") ?? {};
  if (!isPlainObject(properties)) {
    throw new UnsupportedElicitationError(
      "the form properties are not an object",
    );
  }
  const entries = Object.entries(properties);
  const requiredValue = ownValue(requestedSchema, "required") ?? [];
  if (
    !Array.isArray(requiredValue) ||
    requiredValue.some(
      (key) =>
        typeof key !== "string" ||
        !Object.prototype.hasOwnProperty.call(properties, key),
    )
  ) {
    throw new UnsupportedElicitationError(
      "the form requires a field it does not define",
    );
  }
  const required = new Set<unknown>(requiredValue);
  if (entries.length > USER_QUESTION_MAX_QUESTIONS) {
    throw new UnsupportedElicitationError(
      `the form has more than ${USER_QUESTION_MAX_QUESTIONS} fields`,
    );
  }
  const fields = entries.map(([key, property], index): ElicitationField => {
    if (!isPlainObject(property)) {
      throw new UnsupportedElicitationError(`field ${key} is not an object`);
    }
    return {
      ...parseFieldShape(property),
      key,
      questionId: `field-${index + 1}`,
      label: optionalText(property, "title") ?? key,
      description: optionalText(property, "description"),
      required: required.has(key),
    };
  });
  return { fields, confirmOnly: fields.length === 0 };
}

function describeNumberRange(field: {
  integer: boolean;
  minimum: number | null;
  maximum: number | null;
}): string {
  const noun = field.integer ? "a whole number" : "a number";
  if (field.minimum !== null && field.maximum !== null) {
    return `${noun} from ${field.minimum} to ${field.maximum}`;
  }
  if (field.minimum !== null) {
    return `${noun} of at least ${field.minimum}`;
  }
  if (field.maximum !== null) {
    return `${noun} of at most ${field.maximum}`;
  }
  return noun;
}

function describeTextRule(field: {
  minLength: number | null;
  maxLength: number | null;
  format: string | null;
}): string | null {
  const parts: string[] = [];
  if (field.format === "email") parts.push("an email address");
  if (field.format === "uri") parts.push("an http:// or https:// address");
  if (field.format === "date") parts.push("a date as YYYY-MM-DD");
  if (field.format === "date-time") {
    parts.push("a date and time as YYYY-MM-DDTHH:MM:SSZ");
  }
  if (field.minLength !== null && field.maxLength !== null) {
    parts.push(`${field.minLength} to ${field.maxLength} characters`);
  } else if (field.minLength !== null) {
    parts.push(`at least ${field.minLength} characters`);
  } else if (field.maxLength !== null) {
    parts.push(`at most ${field.maxLength} characters`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

function fieldHint(field: ElicitationField): string | null {
  switch (field.kind) {
    case "number":
      return describeNumberRange(field);
    case "text":
      return describeTextRule(field);
    case "multi":
      return "choose one or more";
    default:
      return null;
  }
}

function skipValue(field: ElicitationField): string {
  return `${field.questionId}:skip`;
}

function optionValue(field: ElicitationField, index: number): string {
  return `${field.questionId}:option-${index + 1}`;
}

function fieldOptions(field: ElicitationField): ElicitationOption[] {
  switch (field.kind) {
    case "boolean":
      return [
        { value: "true", label: "Yes" },
        { value: "false", label: "No" },
      ];
    case "single":
    case "multi":
      return field.options;
    default:
      return [];
  }
}

function canSkip(field: ElicitationField): boolean {
  return (
    !field.required && fieldOptions(field).length < USER_QUESTION_MAX_OPTIONS
  );
}

function questionFor(args: {
  field: ElicitationField;
  intro: string | null;
  error: string | null;
}): PendingInteractionUserQuestionQuestion {
  const { field } = args;
  const hint = fieldHint(field);
  const parts = [
    args.intro,
    field.description === null
      ? field.label
      : `${field.label}: ${field.description}`,
    hint === null ? null : `(${hint})`,
    args.error === null ? null : `${args.error}.`,
  ].filter((part): part is string => part !== null);
  const options = fieldOptions(field).map((option, index) => ({
    value: optionValue(field, index),
    label: option.label,
  }));
  if (canSkip(field)) {
    options.push({ value: skipValue(field), label: "Skip" });
  }
  const freeText = field.kind === "text" || field.kind === "number";
  return {
    id: field.questionId,
    prompt: parts.join(" "),
    shortLabel: field.label,
    multiSelect: field.kind === "multi",
    ...(options.length > 0 ? { options } : {}),
    allowFreeText: freeText,
  };
}

function introFor(request: McpElicitationRequest): string {
  return `The ${request.serverName} MCP server asks: ${request.message.trim()}`;
}

function buildPayload(args: {
  request: McpElicitationRequest;
  form: ElicitationForm;
  errors: ReadonlyMap<string, string>;
}): UserQuestionPendingInteractionPayload {
  if (args.form.confirmOnly) {
    return {
      kind: "user_question",
      questions: [
        {
          id: CONFIRM_QUESTION_ID,
          prompt: introFor(args.request),
          shortLabel: args.request.serverName,
          multiSelect: false,
          options: [
            { value: CONFIRM_ACCEPT_VALUE, label: "Continue" },
            { value: CONFIRM_DECLINE_VALUE, label: "Decline" },
          ],
          allowFreeText: false,
        },
      ],
    };
  }
  return {
    kind: "user_question",
    questions: args.form.fields.map((field, index) =>
      questionFor({
        field,
        intro: index === 0 ? introFor(args.request) : null,
        error: args.errors.get(field.questionId) ?? null,
      }),
    ),
  };
}

function codePointLength(value: string): number {
  return [...value].length;
}

const DECIMAL_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const EMAIL =
  /^[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const WEB_URL =
  /^https?:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isValidDate(year: string, month: string, day: string): boolean {
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (dayNumber < 1) {
    return false;
  }
  const leapYear =
    yearNumber % 4 === 0 && (yearNumber % 100 !== 0 || yearNumber % 400 === 0);
  const daysInMonth =
    monthNumber === 2 && leapYear ? 29 : (DAYS_IN_MONTH[monthNumber - 1] ?? 0);
  return dayNumber <= daysInMonth;
}

function formatError(
  format: "email" | "uri" | "date" | "date-time",
  value: string,
): string | null {
  switch (format) {
    case "email":
      return EMAIL.test(value) ? null : "Enter an email address";
    case "uri":
      return WEB_URL.test(value)
        ? null
        : "Enter a web address starting with http:// or https://";
    case "date": {
      const match = DATE.exec(value);
      return match !== null && isValidDate(match[1]!, match[2]!, match[3]!)
        ? null
        : "Enter a date as YYYY-MM-DD";
    }
    case "date-time": {
      const match = DATE_TIME.exec(value);
      return match !== null &&
        isValidDate(match[1]!, match[2]!, match[3]!) &&
        Number(match[4]) < 24 &&
        Number(match[5]) < 60 &&
        Number(match[6]) < 60 &&
        Number(match[7] ?? 0) < 24 &&
        Number(match[8] ?? 0) < 60
        ? null
        : "Enter a date and time as YYYY-MM-DDTHH:MM:SSZ, or with an offset such as +02:00";
    }
  }
}

type FieldReading =
  | { kind: "value"; value: McpElicitationValue }
  | { kind: "skip" }
  | { kind: "error"; message: string };

function selectedOptionIndexes(
  field: ElicitationField,
  selected: readonly string[],
): number[] | null {
  const options = fieldOptions(field);
  const indexes: number[] = [];
  for (const value of selected) {
    const index = options.findIndex(
      (_option, optionIndex) => optionValue(field, optionIndex) === value,
    );
    if (index < 0) {
      return null;
    }
    indexes.push(index);
  }
  return indexes;
}

function readField(
  field: ElicitationField,
  answer: PendingInteractionUserAnswer | undefined,
): FieldReading {
  if (answer === undefined) {
    return field.required
      ? { kind: "error", message: `${field.label} needs an answer` }
      : { kind: "skip" };
  }
  const freeText = answer.freeText?.trim() ?? "";
  const skipped = answer.selected.includes(skipValue(field));
  if (skipped) {
    return answer.selected.length === 1 &&
      freeText.length === 0 &&
      canSkip(field)
      ? { kind: "skip" }
      : { kind: "error", message: `Choose Skip on its own for ${field.label}` };
  }
  switch (field.kind) {
    case "text": {
      if (answer.selected.length > 0 || freeText.length === 0) {
        return { kind: "error", message: `Type an answer for ${field.label}` };
      }
      const length = codePointLength(freeText);
      if (field.minLength !== null && length < field.minLength) {
        return {
          kind: "error",
          message: `${field.label} needs at least ${field.minLength} characters`,
        };
      }
      if (field.maxLength !== null && length > field.maxLength) {
        return {
          kind: "error",
          message: `${field.label} allows at most ${field.maxLength} characters`,
        };
      }
      const invalidFormat =
        field.format === null ? null : formatError(field.format, freeText);
      return invalidFormat === null
        ? { kind: "value", value: freeText }
        : { kind: "error", message: `${invalidFormat} for ${field.label}` };
    }
    case "number": {
      const number = Number(freeText);
      if (
        answer.selected.length > 0 ||
        !DECIMAL_NUMBER.test(freeText) ||
        !Number.isFinite(number) ||
        (field.integer && !Number.isSafeInteger(number)) ||
        (field.minimum !== null && number < field.minimum) ||
        (field.maximum !== null && number > field.maximum)
      ) {
        return {
          kind: "error",
          message: `${field.label} must be ${describeNumberRange(field)}`,
        };
      }
      return { kind: "value", value: number };
    }
    case "boolean":
    case "single": {
      const indexes = selectedOptionIndexes(field, answer.selected);
      if (indexes === null || indexes.length !== 1 || freeText.length > 0) {
        return {
          kind: "error",
          message: `Choose one answer for ${field.label}`,
        };
      }
      const index = indexes[0]!;
      if (field.kind === "boolean") {
        return { kind: "value", value: index === 0 };
      }
      return { kind: "value", value: field.options[index]!.value };
    }
    case "multi": {
      const indexes = selectedOptionIndexes(field, answer.selected);
      if (indexes === null || freeText.length > 0 || indexes.length === 0) {
        return {
          kind: "error",
          message: `Choose from the list for ${field.label}`,
        };
      }
      if (field.minItems !== null && indexes.length < field.minItems) {
        return {
          kind: "error",
          message: `Choose at least ${field.minItems} for ${field.label}`,
        };
      }
      if (field.maxItems !== null && indexes.length > field.maxItems) {
        return {
          kind: "error",
          message: `Choose at most ${field.maxItems} for ${field.label}`,
        };
      }
      return {
        kind: "value",
        value: [...new Set(indexes)].map(
          (index) => field.options[index]!.value,
        ),
      };
    }
  }
}

type FormReading =
  | { kind: "accept"; content: Record<string, McpElicitationValue> }
  | { kind: "decline" }
  | { kind: "retry"; errors: Map<string, string> };

function readForm(
  form: ElicitationForm,
  answers: ReadonlyMap<string, PendingInteractionUserAnswer>,
): FormReading {
  if (form.confirmOnly) {
    const selected = answers.get(CONFIRM_QUESTION_ID)?.selected ?? [];
    if (selected.length === 1 && selected[0] === CONFIRM_ACCEPT_VALUE) {
      return { kind: "accept", content: {} };
    }
    if (selected.length === 1 && selected[0] === CONFIRM_DECLINE_VALUE) {
      return { kind: "decline" };
    }
    return {
      kind: "retry",
      errors: new Map([[CONFIRM_QUESTION_ID, "Choose Continue or Decline"]]),
    };
  }
  const errors = new Map<string, string>();
  const content: Array<[string, McpElicitationValue]> = [];
  for (const field of form.fields) {
    const reading = readField(field, answers.get(field.questionId));
    if (reading.kind === "error") {
      errors.set(field.questionId, reading.message);
    } else if (reading.kind === "value") {
      content.push([field.key, reading.value]);
    }
  }
  if (errors.size > 0) {
    return { kind: "retry", errors };
  }
  return { kind: "accept", content: Object.fromEntries(content) };
}

export async function runMcpElicitation(
  args: RunMcpElicitationArgs,
): Promise<McpElicitationResult> {
  const { request } = args;
  if (request.mode !== undefined && request.mode !== "form") {
    return {
      action: "decline",
      reason: `bb does not support ${request.mode} MCP elicitations`,
    };
  }
  let form: ElicitationForm;
  try {
    form = parseElicitationForm(request.requestedSchema);
  } catch (error) {
    if (error instanceof UnsupportedElicitationError) {
      return {
        action: "decline",
        reason: `bb cannot show this MCP form: ${error.message}`,
      };
    }
    throw error;
  }
  if (request.message.trim().length === 0) {
    return { action: "decline", reason: "the MCP form has no message" };
  }
  let errors = new Map<string, string>();
  for (let attempt = 1; attempt <= MCP_ELICITATION_MAX_ATTEMPTS; attempt += 1) {
    if (args.signal?.aborted) {
      return { action: "cancel", reason: "the request was cancelled" };
    }
    let resolution: unknown;
    try {
      resolution = await args.ask(buildPayload({ request, form, errors }));
    } catch (error) {
      return {
        action: "cancel",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const parsed =
      userQuestionPendingInteractionResolutionSchema.safeParse(resolution);
    if (!parsed.success) {
      return { action: "cancel", reason: "the answer was not a form answer" };
    }
    const reading = readForm(
      form,
      new Map(Object.entries(parsed.data.answers)),
    );
    if (reading.kind === "accept") {
      return { action: "accept", content: reading.content };
    }
    if (reading.kind === "decline") {
      return { action: "decline", reason: "the user declined" };
    }
    errors = reading.errors;
  }
  return {
    action: "cancel",
    reason: `the answers were still invalid after ${MCP_ELICITATION_MAX_ATTEMPTS} attempts`,
  };
}
