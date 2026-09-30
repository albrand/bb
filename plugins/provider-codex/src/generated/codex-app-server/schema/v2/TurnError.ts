
import type { CodexErrorInfo } from "./CodexErrorInfo.js";
import type { MisalignmentErrorDetails } from "./MisalignmentErrorDetails.js";

export type TurnError = { message: string, codexErrorInfo: CodexErrorInfo | null, additionalDetails: string | null,

misalignment: MisalignmentErrorDetails | null, };
