import type {
  DictationEnvironment,
  LevelMeter,
  SegmentRecorder,
} from "./dictation-session";

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg",
];

export function preferredDictationMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return (
    MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null
  );
}

function createRecorder(
  stream: MediaStream,
  mimeType: string | null,
): SegmentRecorder {
  const recorder = mimeType
    ? new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 })
    : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  let aborted = false;
  recorder.ondataavailable = (event: BlobEvent) => {
    if (!aborted && event.data.size > 0) chunks.push(event.data);
  };
  return {
    get mimeType() {
      return recorder.mimeType || mimeType || "audio/webm";
    },
    start() {
      recorder.start();
    },
    stop() {
      return new Promise<Blob>((resolve, reject) => {
        if (recorder.state === "inactive") {
          resolve(
            new Blob(chunks, {
              type: recorder.mimeType || mimeType || "audio/webm",
            }),
          );
          return;
        }
        recorder.onstop = () => {
          resolve(
            new Blob(chunks, {
              type: recorder.mimeType || mimeType || "audio/webm",
            }),
          );
          chunks.length = 0;
        };
        recorder.onerror = () => reject(new Error("Recording failed"));
        try {
          recorder.stop();
        } catch (error) {
          reject(
            error instanceof Error ? error : new Error("Recording failed"),
          );
        }
      });
    },
    abort() {
      aborted = true;
      chunks.length = 0;
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {}
      }
    },
  };
}

function createLevelMeter(
  stream: MediaStream,
  context: AudioContext | null,
): LevelMeter | null {
  if (context === null) return null;
  try {
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    return {
      read() {
        analyser.getFloatTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) energy += sample * sample;
        return Math.sqrt(energy / samples.length);
      },
      close() {
        source.disconnect();
        analyser.disconnect();
      },
    };
  } catch {
    return null;
  }
}

export function createBrowserDictationEnvironment(
  stream: MediaStream,
  context: AudioContext | null,
): DictationEnvironment {
  const mimeType = preferredDictationMimeType();
  return {
    now: () => performance.now(),
    setInterval: (callback, ms) => window.setInterval(callback, ms),
    clearInterval: (id) => window.clearInterval(id),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    createRecorder: () => createRecorder(stream, mimeType),
    createLevelMeter: () => createLevelMeter(stream, context),
  };
}
