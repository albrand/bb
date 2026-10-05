import { jsonValueSchema } from "@bb/domain";
import type { JsonValue } from "@get-bb/plugin-sdk";

const drafts = new Map<string, Record<string, JsonValue>>();

export function getComposerCreateData(
  key: string,
): Record<string, JsonValue> | undefined {
  const data = drafts.get(key);
  return data === undefined ? undefined : structuredClone(data);
}

export function setComposerCreateData(
  key: string,
  pluginId: string,
  value: JsonValue | null,
): void {
  const data = { ...drafts.get(key) };
  if (value === null) delete data[pluginId];
  else data[pluginId] = structuredClone(jsonValueSchema.parse(value));
  if (Object.keys(data).length > 32 || JSON.stringify(data).length > 16_384) {
    throw new Error("Plugin creation data exceeds its limit.");
  }
  if (Object.keys(data).length === 0) drafts.delete(key);
  else drafts.set(key, data);
}

export function clearSubmittedComposerCreateData(
  key: string,
  submitted: Record<string, JsonValue> | undefined,
): void {
  if (JSON.stringify(drafts.get(key)) === JSON.stringify(submitted))
    drafts.delete(key);
}
