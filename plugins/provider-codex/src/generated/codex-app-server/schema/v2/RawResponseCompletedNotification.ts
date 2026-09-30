
import type { ResponseUsageMetadata } from "./ResponseUsageMetadata.js";
import type { TokenUsageBreakdown } from "./TokenUsageBreakdown.js";


export type RawResponseCompletedNotification = { threadId: string, turnId: string, responseId: string, usage: TokenUsageBreakdown | null, usageMetadata: ResponseUsageMetadata | null, };
