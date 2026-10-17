import {
  dictationSegmentResponseSchema,
  type DictationSegmentResponse,
  type WritingAssistanceSettingsUpdate,
  type WritingAssistanceView,
  type WritingCorrectionRequest,
  type WritingCorrectionResponse,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface WritingAssistanceViewArgs {
  signal?: AbortSignal;
}

export interface WritingAssistanceUpdateSettingsArgs extends WritingAssistanceSettingsUpdate {
  signal?: AbortSignal;
}

export interface WritingAssistanceCorrectArgs extends WritingCorrectionRequest {
  signal?: AbortSignal;
}

export interface WritingAssistanceDictationSegmentArgs {
  file: File;
  context: string;
  signal?: AbortSignal;
}

export type WritingAssistanceViewResult = WritingAssistanceView;
export type WritingAssistanceCorrectResult = WritingCorrectionResponse;
export type WritingAssistanceDictationSegmentResult = DictationSegmentResponse;

export interface WritingAssistanceArea {
  view(args?: WritingAssistanceViewArgs): Promise<WritingAssistanceViewResult>;
  updateSettings(
    args: WritingAssistanceUpdateSettingsArgs,
  ): Promise<WritingAssistanceViewResult>;
  correct(
    args: WritingAssistanceCorrectArgs,
  ): Promise<WritingAssistanceCorrectResult>;
  transcribeDictationSegment(
    args: WritingAssistanceDictationSegmentArgs,
  ): Promise<WritingAssistanceDictationSegmentResult>;
}

export function createWritingAssistanceArea(
  args: CreateSdkAreaArgs,
): WritingAssistanceArea {
  const { transport } = args;
  return {
    async view(input = {}) {
      return transport.readJson(
        transport.api.v1["writing-assistance"].$get(
          {},
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async updateSettings(input) {
      const { signal, ...update } = input;
      return transport.readJson(
        transport.api.v1["writing-assistance"].settings.$put(
          { json: update },
          ...signalRequestArgs(signal),
        ),
      );
    },
    async correct(input) {
      const { signal, ...request } = input;
      return transport.readJson(
        transport.api.v1["writing-assistance"].corrections.$post(
          { json: request },
          ...signalRequestArgs(signal),
        ),
      );
    },
    async transcribeDictationSegment(input) {
      if (input.file.size === 0) {
        throw new Error("Audio file must not be empty");
      }
      const form = new FormData();
      form.set("file", input.file);
      form.set("context", input.context);
      const baseUrl = transport.baseUrl.replace(/\/$/u, "");
      const response = await transport.resolve(
        transport.fetch(
          `${baseUrl}/api/v1/writing-assistance/dictation-segments`,
          { method: "POST", body: form, signal: input.signal },
        ),
      );
      return dictationSegmentResponseSchema.parse(await response.json());
    },
  };
}
