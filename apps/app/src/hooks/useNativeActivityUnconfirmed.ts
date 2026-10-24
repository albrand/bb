import {
  isNativeActivityUnconfirmed,
  nativeActivityEvidenceKind,
} from "@bb/client-core";
import type {
  NativeActivityEvidenceKind,
  ThreadRuntimeState,
} from "@bb/domain";
import { useSecondTick } from "./useSecondTick";

export function useNativeActivityUnconfirmed(
  runtime: ThreadRuntimeState | undefined,
): boolean {
  const now = useSecondTick(runtime?.nativeActivity !== undefined);
  return runtime === undefined || runtime.nativeActivity === undefined
    ? false
    : isNativeActivityUnconfirmed(runtime, now);
}

export interface NativeActivityNotice {
  evidenceKind: NativeActivityEvidenceKind;
  lastToolCallAt: number | null;
  now: number;
  unconfirmed: boolean;
}

export function useNativeActivityNotice(
  runtime: ThreadRuntimeState | undefined,
): NativeActivityNotice {
  const now = useSecondTick(runtime?.nativeActivity !== undefined);
  if (runtime === undefined || runtime.nativeActivity === undefined) {
    return {
      evidenceKind: "unknown",
      lastToolCallAt: null,
      now,
      unconfirmed: false,
    };
  }
  return {
    evidenceKind: nativeActivityEvidenceKind(runtime, now),
    lastToolCallAt: runtime.nativeActivity.lastToolCallAt ?? null,
    now,
    unconfirmed: isNativeActivityUnconfirmed(runtime, now),
  };
}
