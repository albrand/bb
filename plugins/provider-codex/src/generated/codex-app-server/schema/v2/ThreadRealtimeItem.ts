
import type { ThreadRealtimeBemItemPresentation } from "./ThreadRealtimeBemItemPresentation.js";
import type { ThreadRealtimeSessionOutcome } from "./ThreadRealtimeSessionOutcome.js";
import type { ThreadRealtimeTranscriptRole } from "./ThreadRealtimeTranscriptRole.js";


export type ThreadRealtimeItem = { id: string, realtimeSessionId: string, } & ({ "type": "realtimeSessionStarted" } | { "type": "transcriptSegment", role: ThreadRealtimeTranscriptRole, text: string, } | { "type": "bemItemPromoted", turnId: string, itemId: string, presentation: ThreadRealtimeBemItemPresentation, } | { "type": "realtimeSessionClosed", outcome: ThreadRealtimeSessionOutcome, });
