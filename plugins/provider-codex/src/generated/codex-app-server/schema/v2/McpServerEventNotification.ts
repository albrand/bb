
import type { JsonValue } from "../serde_json/JsonValue.js";

export type McpServerEventNotification = { method: string, params: JsonValue, };
