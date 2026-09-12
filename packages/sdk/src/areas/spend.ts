import type {
  SpendAnalysisPayloadResponse,
  SpendAssessment,
  SpendAssessmentListResponse,
  SpendBackfillResponse,
  SpendGroupByQueryValue,
  SpendRollupResponse,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface SpendRollupArgs {
  from?: string;
  groupBy?: SpendGroupByQueryValue;
  providerId?: string;
  signal?: AbortSignal;
  threadId?: string;
  to?: string;
}

export interface SpendBackfillArgs {
  signal?: AbortSignal;
}

export type SpendRollupResult = SpendRollupResponse;
export type SpendBackfillResult = SpendBackfillResponse;
export type SpendAnalysisPayloadResult = SpendAnalysisPayloadResponse;
export type SpendAssessmentListResult = SpendAssessmentListResponse;

export interface SpendAnalysisPayloadArgs {
  from?: string;
  signal?: AbortSignal;
  to?: string;
}

export interface SpendAssessmentListArgs {
  signal?: AbortSignal;
  topic?: string;
}

export interface SpendRecordAssessmentArgs extends SpendAssessment {
  signal?: AbortSignal;
}

/**
 * Fork (albrand/bb): the server's own token totals.
 *
 * Present so an agent and a plugin read the same number the CLI prints, instead
 * of each re-deriving it from an event log the pruner is emptying underneath
 * them.
 */
export interface SpendArea {
  /**
   * Exactly what an analysis request would send, and its digest. Nothing is
   * sent by reading it.
   */
  analysisPayload(
    args?: SpendAnalysisPayloadArgs,
  ): Promise<SpendAnalysisPayloadResult>;
  assessments(args?: SpendAssessmentListArgs): Promise<SpendAssessmentListResult>;
  /** Replay the usage events still in the store. Safe to run repeatedly. */
  backfill(args?: SpendBackfillArgs): Promise<SpendBackfillResult>;
  recordAssessment(args: SpendRecordAssessmentArgs): Promise<SpendAssessment>;
  rollup(args?: SpendRollupArgs): Promise<SpendRollupResult>;
}

export function createSpendArea(args: CreateSdkAreaArgs): SpendArea {
  const { transport } = args;
  return {
    async analysisPayload(input = {}) {
      const query: Record<string, string> = {};
      if (input.from !== undefined) query.from = input.from;
      if (input.to !== undefined) query.to = input.to;
      return transport.readJson(
        transport.api.v1.spend["analysis-payload"].$get(
          { query },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async assessments(input = {}) {
      const query: Record<string, string> = {};
      if (input.topic !== undefined) query.topic = input.topic;
      return transport.readJson(
        transport.api.v1.spend.assessments.$get(
          { query },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async recordAssessment(input) {
      const { signal, ...assessment } = input;
      return transport.readJson(
        transport.api.v1.spend.assessments.$post(
          { json: assessment },
          ...signalRequestArgs(signal),
        ),
      );
    },
    async backfill(input = {}) {
      return transport.readJson(
        transport.api.v1.spend.backfill.$post(
          {},
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async rollup(input = {}) {
      const query: Record<string, string> = {};
      if (input.from !== undefined) query.from = input.from;
      if (input.to !== undefined) query.to = input.to;
      if (input.groupBy !== undefined) query.groupBy = input.groupBy;
      if (input.threadId !== undefined) query.threadId = input.threadId;
      if (input.providerId !== undefined) query.providerId = input.providerId;
      return transport.readJson(
        transport.api.v1.spend.rollup.$get(
          { query },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
  };
}
