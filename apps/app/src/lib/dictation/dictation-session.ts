export interface SegmentRecorder {
  readonly mimeType: string;
  start(): void;
  stop(): Promise<Blob>;
  abort(): void;
}

export interface LevelMeter {
  read(): number;
  close(): void;
}

export interface DictationEnvironment {
  now(): number;
  setInterval(callback: () => void, ms: number): number;
  clearInterval(id: number): void;
  setTimeout(callback: () => void, ms: number): number;
  createRecorder(): SegmentRecorder;
  createLevelMeter(): LevelMeter | null;
}

export interface DictationSegment {
  file: File;
  durationMs: number;
  signal: AbortSignal;
}

export type DictationFailureKind = "budget" | "transient";

export class DictationTranscribeError extends Error {
  constructor(
    message: string,
    readonly kind: DictationFailureKind,
  ) {
    super(message);
    this.name = "DictationTranscribeError";
  }
}

export interface DictationSnapshot {
  phase: "recording" | "finalizing" | "done";
  pending: number;
  failure: string | null;
  speaking: boolean;
}

export interface DictationSessionOptions {
  env: DictationEnvironment;
  transcribe(segment: DictationSegment): Promise<string>;
  onText(text: string): void;
  onSnapshot(snapshot: DictationSnapshot): void;
  onAutoStop(message: string): void;
}

export const DICTATION_TICK_MS = 60;
export const DICTATION_PAUSE_MS = 650;
export const DICTATION_MIN_SEGMENT_MS = 1_200;
export const DICTATION_SOFT_MAX_SEGMENT_MS = 14_000;
export const DICTATION_HARD_MAX_SEGMENT_MS = 22_000;
export const DICTATION_MIN_SPEECH_MS = 250;
export const DICTATION_MAX_IN_FLIGHT = 2;
export const DICTATION_MAX_QUEUED = 8;
const SPEECH_FLOOR = 0.012;
const NOISE_MULTIPLIER = 3;
const RETRY_DELAY_MS = 800;

interface QueuedSegment {
  file: File;
  durationMs: number;
  state: "queued" | "sending" | "done" | "failed";
  attempts: number;
  text: string;
  failure: string | null;
  controller: AbortController;
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

export class DictationSession {
  private readonly env: DictationEnvironment;
  private readonly options: DictationSessionOptions;
  private recorder: SegmentRecorder | null = null;
  private meter: LevelMeter | null = null;
  private timer: number | null = null;
  private segmentStartedAt = 0;
  private lastSpeechAt = 0;
  private speechMs = 0;
  private noise = SPEECH_FLOOR / NOISE_MULTIPLIER;
  private speaking = false;
  private cutting: Promise<void> = Promise.resolve();
  private queue: QueuedSegment[] = [];
  private phase: DictationSnapshot["phase"] = "recording";
  private cancelled = false;
  private vad = false;
  private segmentCounter = 0;

  constructor(options: DictationSessionOptions) {
    this.options = options;
    this.env = options.env;
  }

  start(): void {
    this.meter = this.env.createLevelMeter();
    this.vad = this.meter !== null;
    this.beginSegment();
    this.timer = this.env.setInterval(() => this.tick(), DICTATION_TICK_MS);
    this.publish();
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  stop(): Promise<void> {
    if (this.phase !== "recording") return this.cutting;
    this.phase = "finalizing";
    this.stopTimer();
    const done = this.cut(true);
    this.meter?.close();
    this.meter = null;
    this.publish();
    return done;
  }

  cancel(): void {
    this.cancelled = true;
    this.phase = "done";
    this.stopTimer();
    this.meter?.close();
    this.meter = null;
    this.recorder?.abort();
    this.recorder = null;
    for (const segment of this.queue) segment.controller.abort();
    this.queue = [];
    this.publish();
  }

  retryFailed(): void {
    for (const segment of this.queue) {
      if (segment.state === "failed") {
        segment.state = "queued";
        segment.failure = null;
        segment.controller = new AbortController();
      }
    }
    this.pump();
  }

  discardFailed(): void {
    this.queue = this.queue.filter((segment) => segment.state !== "failed");
    this.pump();
  }

  private stopTimer(): void {
    if (this.timer !== null) this.env.clearInterval(this.timer);
    this.timer = null;
  }

  private beginSegment(): void {
    const recorder = this.env.createRecorder();
    recorder.start();
    this.recorder = recorder;
    const now = this.env.now();
    this.segmentStartedAt = now;
    this.lastSpeechAt = now;
    this.speechMs = 0;
  }

  private tick(): void {
    if (this.phase !== "recording" || this.meter === null) return;
    const level = this.meter.read();
    const now = this.env.now();
    const threshold = Math.max(SPEECH_FLOOR, this.noise * NOISE_MULTIPLIER);
    const speaking = level >= threshold;
    if (speaking) {
      this.lastSpeechAt = now;
      this.speechMs += DICTATION_TICK_MS;
    } else {
      this.noise = this.noise * 0.95 + level * 0.05;
    }
    if (speaking !== this.speaking) {
      this.speaking = speaking;
      this.publish();
    }
    const age = now - this.segmentStartedAt;
    const silence = now - this.lastSpeechAt;
    const hadSpeech = this.speechMs >= DICTATION_MIN_SPEECH_MS;
    if (
      (hadSpeech &&
        age >= DICTATION_MIN_SEGMENT_MS &&
        silence >= DICTATION_PAUSE_MS) ||
      (age >= DICTATION_SOFT_MAX_SEGMENT_MS && silence >= 200) ||
      age >= DICTATION_HARD_MAX_SEGMENT_MS
    ) {
      void this.cut(false);
    }
  }

  private cut(final: boolean): Promise<void> {
    const recorder = this.recorder;
    if (recorder === null) return this.cutting;
    const durationMs = this.env.now() - this.segmentStartedAt;
    const hadSpeech = !this.vad || this.speechMs >= DICTATION_MIN_SPEECH_MS;
    this.recorder = null;
    if (!final) this.beginSegment();
    const stopped = recorder.stop().catch(() => null);
    const previous = this.cutting;
    this.cutting = previous.then(async () => {
      const blob = await stopped;
      if (this.cancelled || blob === null || blob.size === 0 || !hadSpeech) {
        this.settleIfDone();
        return;
      }
      if (durationMs < 300) {
        this.settleIfDone();
        return;
      }
      this.segmentCounter += 1;
      const type = blob.type || recorder.mimeType || "audio/webm";
      this.queue.push({
        file: new File(
          [blob],
          `dictation-${this.segmentCounter}.${extensionFor(type)}`,
          { type },
        ),
        durationMs,
        state: "queued",
        attempts: 0,
        text: "",
        failure: null,
        controller: new AbortController(),
      });
      if (this.queue.length > DICTATION_MAX_QUEUED) {
        this.options.onAutoStop(
          "Transcription is falling behind; stopped recording so nothing is lost.",
        );
        void this.stop();
      }
      this.pump();
    });
    return this.cutting;
  }

  private pump(): void {
    if (this.cancelled) return;
    while (this.queue[0]?.state === "done") {
      const segment = this.queue.shift()!;
      if (segment.text.length > 0) this.options.onText(segment.text);
    }
    let sending = this.queue.filter((s) => s.state === "sending").length;
    for (const segment of this.queue) {
      if (sending >= DICTATION_MAX_IN_FLIGHT) break;
      if (segment.state !== "queued") continue;
      sending += 1;
      void this.send(segment);
    }
    this.settleIfDone();
    this.publish();
  }

  private async send(segment: QueuedSegment): Promise<void> {
    segment.state = "sending";
    segment.attempts += 1;
    try {
      const text = await this.options.transcribe({
        file: segment.file,
        durationMs: segment.durationMs,
        signal: segment.controller.signal,
      });
      if (this.cancelled || segment.controller.signal.aborted) return;
      segment.text = text;
      segment.state = "done";
    } catch (error) {
      if (this.cancelled || segment.controller.signal.aborted) return;
      const message =
        error instanceof Error && error.message.length > 0
          ? error.message
          : "Transcription failed";
      if (
        error instanceof DictationTranscribeError &&
        error.kind === "budget"
      ) {
        segment.state = "failed";
        segment.failure = message;
        this.options.onAutoStop(message);
        void this.stop();
      } else if (segment.attempts < 2) {
        segment.state = "queued";
        await new Promise<void>((resolve) =>
          this.env.setTimeout(resolve, RETRY_DELAY_MS),
        );
      } else {
        segment.state = "failed";
        segment.failure = message;
      }
    }
    this.pump();
  }

  private settleIfDone(): void {
    if (
      this.phase === "finalizing" &&
      this.recorder === null &&
      this.queue.length === 0
    ) {
      this.phase = "done";
      this.publish();
    }
  }

  private publish(): void {
    this.options.onSnapshot({
      phase: this.phase,
      pending: this.queue.filter((s) => s.state !== "failed").length,
      failure: this.queue.find((s) => s.state === "failed")?.failure ?? null,
      speaking: this.speaking,
    });
  }
}
