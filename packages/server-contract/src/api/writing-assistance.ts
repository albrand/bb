export {
  dictationSegmentResponseSchema,
  writingAssistanceSettingsUpdateSchema,
  writingAssistanceViewSchema,
  writingCorrectionRequestSchema,
  writingCorrectionResponseSchema,
  writingVocabularyEditSchema,
} from "@bb/domain";
export type {
  DictationSegmentResponse,
  WritingAssistanceSettingsUpdate,
  WritingAssistanceView,
  WritingCorrectionRequest,
  WritingCorrectionResponse,
  WritingVocabularyEdit,
} from "@bb/domain";

export interface DictationSegmentForm {
  [key: string]: string | Blob;
}
