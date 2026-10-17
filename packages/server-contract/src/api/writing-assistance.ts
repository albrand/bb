export {
  dictationSegmentResponseSchema,
  writingAssistanceSettingsUpdateSchema,
  writingAssistanceViewSchema,
  writingCorrectionRequestSchema,
  writingCorrectionResponseSchema,
} from "@bb/domain";
export type {
  DictationSegmentResponse,
  WritingAssistanceSettingsUpdate,
  WritingAssistanceView,
  WritingCorrectionRequest,
  WritingCorrectionResponse,
} from "@bb/domain";

export interface DictationSegmentForm {
  [key: string]: string | Blob;
}
