import { useCallback, useEffect, useRef, useState } from "react";
import { BbHttpError } from "@bb/sdk/browser";
import {
  requestAudioInputStream,
  useAudioInputDevicePreferenceValue,
} from "@/lib/audio-input-device-preference";
import { createBrowserDictationEnvironment } from "@/lib/dictation/browser-dictation-environment";
import {
  DictationSession,
  DictationTranscribeError,
  type DictationSnapshot,
} from "@/lib/dictation/dictation-session";
import {
  readVoiceSupportEnvironment,
  resolveVoiceSupport,
  voiceUnsupportedMessage,
} from "./voice-input-support";

export type DictationPhase = "idle" | "starting" | "recording" | "finalizing";

export interface SegmentedDictationState {
  phase: DictationPhase;
  pending: number;
  failure: string | null;
  speaking: boolean;
  startedAt: number | null;
  stream: MediaStream | null;
}

interface UseSegmentedDictationOptions {
  transcribe(args: {
    file: File;
    durationMs: number;
    signal: AbortSignal;
  }): Promise<string>;
  onText(text: string): void;
  onError(message: string): void;
  onFinished?(): void;
}

const IDLE: SegmentedDictationState = {
  phase: "idle",
  pending: 0,
  failure: null,
  speaking: false,
  startedAt: null,
  stream: null,
};

export function microphoneErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Microphone permission denied. Allow microphone access for bb and try again.";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "No microphone was found";
      case "NotReadableError":
      case "TrackStartError":
        return "The microphone is unavailable or already in use";
      default:
        return "Could not start the microphone";
    }
  }
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Could not start the microphone";
}

function toTranscribeError(error: unknown): unknown {
  if (error instanceof BbHttpError && error.status === 429) {
    return new DictationTranscribeError(
      error.message.replace(/^HTTP \d+:\s*/u, ""),
      "budget",
    );
  }
  return error;
}

export function useSegmentedDictation(options: UseSegmentedDictationOptions) {
  const preferredDeviceId = useAudioInputDevicePreferenceValue();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sessionRef = useRef<DictationSession | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const startRequestRef = useRef(0);
  const startingRef = useRef(false);
  const [state, setState] = useState<SegmentedDictationState>(IDLE);

  const releaseDevices = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const context = contextRef.current;
    contextRef.current = null;
    if (context !== null) void context.close().catch(() => {});
  }, []);

  const applySnapshot = useCallback(
    (session: DictationSession, snapshot: DictationSnapshot) => {
      if (sessionRef.current !== session) return;
      if (snapshot.phase === "done") {
        sessionRef.current = null;
        releaseDevices();
        setState(IDLE);
        optionsRef.current.onFinished?.();
        return;
      }
      setState((previous) => {
        const phase =
          snapshot.phase === "recording" ? "recording" : "finalizing";
        if (
          previous.phase === phase &&
          previous.pending === snapshot.pending &&
          previous.failure === snapshot.failure &&
          previous.speaking === snapshot.speaking
        ) {
          return previous;
        }
        return {
          ...previous,
          phase,
          pending: snapshot.pending,
          failure: snapshot.failure,
          speaking: snapshot.speaking,
          stream: phase === "recording" ? previous.stream : null,
        };
      });
    },
    [releaseDevices],
  );

  const stop = useCallback(() => {
    startRequestRef.current += 1;
    const session = sessionRef.current;
    if (session === null) {
      const wasStarting = startingRef.current;
      startingRef.current = false;
      releaseDevices();
      setState((previous) => (previous.phase === "starting" ? IDLE : previous));
      if (wasStarting) optionsRef.current.onFinished?.();
      return;
    }
    void session.stop();
    releaseDevices();
  }, [releaseDevices]);

  const cancel = useCallback(() => {
    startRequestRef.current += 1;
    startingRef.current = false;
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.cancel();
    releaseDevices();
    setState(IDLE);
  }, [releaseDevices]);

  const start = useCallback(async () => {
    if (sessionRef.current !== null) return;
    const support = resolveVoiceSupport(readVoiceSupportEnvironment());
    if (!support.isSupported) {
      optionsRef.current.onError(voiceUnsupportedMessage(support.reason));
      return;
    }
    const request = ++startRequestRef.current;
    let context: AudioContext | null = null;
    if (typeof AudioContext !== "undefined") {
      try {
        context = new AudioContext();
        void context.resume().catch(() => {});
      } catch {
        context = null;
      }
    }
    contextRef.current = context;
    setState({ ...IDLE, phase: "starting" });
    startingRef.current = true;
    let stream: MediaStream;
    try {
      stream = await requestAudioInputStream(
        navigator.mediaDevices,
        preferredDeviceId,
      );
    } catch (error) {
      if (request === startRequestRef.current) {
        startingRef.current = false;
        releaseDevices();
        setState(IDLE);
        optionsRef.current.onError(microphoneErrorMessage(error));
      }
      return;
    }
    if (request !== startRequestRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    startingRef.current = false;
    streamRef.current = stream;
    const session = new DictationSession({
      env: createBrowserDictationEnvironment(stream, context),
      transcribe: (segment) =>
        optionsRef.current
          .transcribe(segment)
          .catch((error: unknown) => Promise.reject(toTranscribeError(error))),
      onText: (text) => {
        if (sessionRef.current === session) optionsRef.current.onText(text);
      },
      onSnapshot: (snapshot) => applySnapshot(session, snapshot),
      onAutoStop: (message) => {
        if (sessionRef.current === session) optionsRef.current.onError(message);
      },
    });
    sessionRef.current = session;
    setState({
      ...IDLE,
      phase: "recording",
      startedAt: Date.now(),
      stream,
    });
    try {
      session.start();
    } catch (error) {
      cancel();
      optionsRef.current.onError(microphoneErrorMessage(error));
      return;
    }
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (sessionRef.current === session) {
          optionsRef.current.onError("The microphone disconnected");
          stop();
        }
      });
    }
  }, [applySnapshot, cancel, preferredDeviceId, releaseDevices, stop]);

  const retry = useCallback(() => sessionRef.current?.retryFailed(), []);
  const discardFailed = useCallback(
    () => sessionRef.current?.discardFailed(),
    [],
  );

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") stop();
    };
    const onPageHide = () => stop();
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [stop]);

  useEffect(() => cancel, [cancel]);

  return { ...state, start, stop, cancel, retry, discardFailed };
}
