import { Buffer } from "node:buffer";
import {
  addWritingUsage,
  getWritingUsage,
  setAiServiceSelection,
  updateWritingAssistanceSettings,
} from "@bb/db";
import { describe, expect, it, vi } from "vitest";
import {
  cleanFormattedReply,
  parseCorrectionReply,
  utcDay,
} from "../../src/services/ai/writing-assistance.js";
import { registerFakeAiService } from "../helpers/ai-services.js";
import { gappedWebm } from "../helpers/audio-fixtures.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function wav(seconds: number, sampleRate = 1_000, metadataBytes = 0): File {
  const data = Math.round(seconds * sampleRate);
  const trailer = metadataBytes > 0 ? 8 + metadataBytes : 0;
  const bytes = Buffer.alloc(44 + data + trailer, 0x80);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + data + trailer, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(data, 40);
  if (metadataBytes > 0) {
    bytes.write("LIST", 44 + data, "ascii");
    bytes.writeUInt32LE(metadataBytes, 48 + data);
  }
  return new File([bytes], "dictation-1.wav", { type: "audio/wav" });
}

async function postSegment(
  harness: TestAppHarness,
  fields: { durationMs?: string; context?: string; file?: File } = {},
): Promise<Response> {
  const form = new FormData();
  form.set("file", fields.file ?? wav(0.5));
  if (fields.durationMs !== undefined)
    form.set("durationMs", fields.durationMs);
  form.set("context", fields.context ?? "");
  return harness.app.request("/api/v1/writing-assistance/dictation-segments", {
    body: form,
    method: "POST",
  });
}

async function postCorrection(
  harness: TestAppHarness,
  body: { target: string; context?: string; complete?: boolean },
): Promise<Response> {
  return harness.app.request("/api/v1/writing-assistance/corrections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      target: body.target,
      context: body.context ?? "",
      complete: body.complete ?? true,
    }),
  });
}

function editsReply(edits: unknown[]): string {
  return JSON.stringify({ edits });
}

describe("writing assistance corrections", () => {
  it("applies safe edits and only suggests meaning changes", async () => {
    await withTestHarness({}, async (harness) => {
      const service = registerFakeAiService(harness.deps.aiServices, {
        complete: async () =>
          `<think>checking</think>${editsReply([
            {
              original: "user are",
              replacement: "user is",
              category: "grammar",
              confidence: "high",
              semanticImpact: "none",
              explanation: "agreement",
            },
            {
              original: "talking",
              replacement: "token",
              category: "speech-recognition",
              confidence: "high",
              semanticImpact: "none",
              explanation: null,
            },
            {
              original: "refreshTokn()",
              replacement: "refreshToken()",
              category: "spelling",
              confidence: "high",
              semanticImpact: "none",
              explanation: null,
            },
          ])}`,
      });
      const target =
        "The user are sure the talking expires.\nIt comes from refreshTokn().";
      const response = await postCorrection(harness, { target });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        status: "ok",
        edits: [
          expect.objectContaining({
            original: "are",
            replacement: "is",
            disposition: "apply",
          }),
          expect.objectContaining({
            original: "talking",
            replacement: "token",
            disposition: "suggest",
          }),
        ],
      });
      expect(service.completeCalls[0]?.prompt).toContain(target);
      expect(getWritingUsage(harness.deps.db, utcDay()).corrections).toBe(1);
    });
  });

  it("only suggests a safe edit on a line that contains code", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        complete: async () =>
          editsReply([
            {
              original: "user are",
              replacement: "user is",
              category: "grammar",
              confidence: "high",
              semanticImpact: "none",
              explanation: null,
            },
          ]),
      });
      const response = await postCorrection(harness, {
        target: "The user are sure refreshTokn() expires.",
      });
      await expect(response.json()).resolves.toEqual({
        status: "ok",
        edits: [
          expect.objectContaining({
            original: "are",
            replacement: "is",
            disposition: "suggest",
          }),
        ],
      });
    });
  });

  it("returns only the complete edits of a reply cut off by the output limit", async () => {
    await withTestHarness({}, async (harness) => {
      const complete = JSON.stringify({
        original: "user are",
        replacement: "user is",
        category: "grammar",
        confidence: "high",
        semanticImpact: "none",
        explanation: null,
      });
      const replies = [
        `{"edits":[${complete},{"original":"talking","replacement":"tok`,
        '{"edits":[{"original":"user are","repla',
      ];
      registerFakeAiService(harness.deps.aiServices, {
        complete: async () => replies.shift() ?? "",
      });
      const target = "The user are sure the talking expires.";
      await expect(
        (await postCorrection(harness, { target })).json(),
      ).resolves.toEqual({
        status: "ok",
        edits: [
          expect.objectContaining({
            original: "are",
            replacement: "is",
            disposition: "apply",
          }),
        ],
      });
      await expect(
        (await postCorrection(harness, { target })).json(),
      ).resolves.toEqual({ status: "ok", edits: [] });
    });
  });

  it("degrades to a skipped result instead of failing the composer", async () => {
    await withTestHarness({}, async (harness) => {
      const none = await (
        await postCorrection(harness, { target: "Hi there." })
      ).json();
      expect(none).toMatchObject({ status: "skipped", reason: "unavailable" });

      registerFakeAiService(harness.deps.aiServices, {
        complete: async () => "Sure! Here are some thoughts.",
      });
      const unreadable = await (
        await postCorrection(harness, { target: "Hi there." })
      ).json();
      expect(unreadable).toMatchObject({ status: "skipped", reason: "failed" });

      setAiServiceSelection(harness.deps.db, "writing", { mode: "off" });
      const off = await (
        await postCorrection(harness, { target: "Hi there." })
      ).json();
      expect(off).toMatchObject({ status: "skipped", reason: "off" });
    });
  });

  it("stops calling the service once the daily request limit is reached", async () => {
    await withTestHarness({}, async (harness) => {
      const service = registerFakeAiService(harness.deps.aiServices, {
        complete: async () => editsReply([]),
      });
      updateWritingAssistanceSettings(harness.deps.db, {
        dailyCorrectionLimit: 1,
      });
      expect(
        (await (await postCorrection(harness, { target: "One." })).json())
          .status,
      ).toBe("ok");
      const limited = await (
        await postCorrection(harness, { target: "Two." })
      ).json();
      expect(limited).toMatchObject({ status: "skipped", reason: "budget" });
      expect(service.completeCalls).toHaveLength(1);
    });
  });

  it("holds the last request for a correction still in flight", async () => {
    await withTestHarness({}, async (harness) => {
      let release = (_reply: string) => {};
      const service = registerFakeAiService(harness.deps.aiServices, {
        complete: () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      });
      updateWritingAssistanceSettings(harness.deps.db, {
        dailyCorrectionLimit: 1,
      });
      const first = postCorrection(harness, { target: "One." });
      await vi.waitFor(() => expect(service.completeCalls).toHaveLength(1));
      const limited = await (
        await postCorrection(harness, { target: "Two." })
      ).json();
      expect(limited).toMatchObject({ status: "skipped", reason: "budget" });
      expect(service.completeCalls).toHaveLength(1);
      release(editsReply([]));
      expect(await (await first).json()).toMatchObject({ status: "ok" });
      expect(getWritingUsage(harness.deps.db, utcDay()).corrections).toBe(1);
    });
  });

  it("returns the reserved request when the correction fails", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        complete: async () => {
          throw new Error("down");
        },
      });
      const failed = await (
        await postCorrection(harness, { target: "One." })
      ).json();
      expect(failed).toMatchObject({ status: "skipped", reason: "failed" });
      expect(getWritingUsage(harness.deps.db, utcDay()).corrections).toBe(0);
    });
  });

  it("does not call the service when typing correction is off", async () => {
    await withTestHarness({}, async (harness) => {
      const service = registerFakeAiService(harness.deps.aiServices);
      updateWritingAssistanceSettings(harness.deps.db, {
        typingCorrection: "off",
      });
      const off = await (
        await postCorrection(harness, { target: "Hi." })
      ).json();
      expect(off).toMatchObject({ status: "skipped", reason: "off" });
      expect(service.completeCalls).toHaveLength(0);
    });
  });

  it("rejects oversized targets at the boundary", async () => {
    await withTestHarness({}, async (harness) => {
      const response = await postCorrection(harness, {
        target: "a".repeat(2_001),
      });
      expect(response.status).toBe(400);
    });
  });
});

describe("dictation segments", () => {
  it("transcribes, formats, validates and records usage", async () => {
    await withTestHarness({}, async (harness) => {
      updateWritingAssistanceSettings(harness.deps.db, {
        vocabulary: ["Hermes"],
      });
      const service = registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () =>
          "first check authentication second verify refresh tokens third add integration tests",
        complete: async () =>
          "1. Check authentication.\n2. Verify refresh tokens.\n3. Add integration tests.",
      });
      const response = await postSegment(harness, {
        context: "Plan for Hermes:",
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        raw: "first check authentication second verify refresh tokens third add integration tests",
        text: "1. Check authentication.\n2. Verify refresh tokens.\n3. Add integration tests.",
        formatted: true,
      });
      expect(service.transcribeCalls[0]?.options.hint).toBe(
        "Terms: Hermes. Plan for Hermes:",
      );
      const usage = getWritingUsage(harness.deps.db, utcDay());
      expect(usage).toMatchObject({
        dictationSegments: 1,
        audioSeconds: 0.5,
        formattings: 1,
      });
      expect(usage.estimatedCostMicros).toBeGreaterThan(0);
    });
  });

  it("keeps the transcript when formatting adds words the speaker did not say", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "add integration tests",
        complete: async () =>
          "Add comprehensive integration tests for every endpoint.",
      });
      await expect((await postSegment(harness)).json()).resolves.toEqual({
        raw: "add integration tests",
        text: "add integration tests",
        formatted: false,
      });
    });
  });

  it("does not ask for formatting a segment too long for the reply limit", async () => {
    await withTestHarness({}, async (harness) => {
      const long = Array.from(
        { length: 80 },
        (_, index) => `word${index}`,
      ).join(" ");
      const service = registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => long,
      });
      await expect((await postSegment(harness)).json()).resolves.toEqual({
        raw: long,
        text: long,
        formatted: false,
      });
      expect(service.completeCalls).toHaveLength(0);
    });
  });

  it("keeps the transcript when formatting drops a negation", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "do not run the migration",
        complete: async () => "Run the migration.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "do not run the migration",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when a list drops a spoken quantity", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () =>
          "check the first endpoint then preserve seven retries",
        complete: async () => "1. Check the endpoint.\n2. Preserve retries.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "check the first endpoint then preserve seven retries",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when a list drops a quantity spoken as its next number", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "first check auth second run two migrations",
        complete: async () => "1. Check auth.\n2. Run migrations.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "first check auth second run two migrations",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when formatting adds a number that was not spoken", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "deploy code",
        complete: async () => "Deploy 7 code.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "deploy code",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when formatting numbers a list nobody enumerated", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "deploy code",
        complete: async () => "7. Deploy code.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "deploy code",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when formatting swaps list items that share a first word", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "first check auth second check tokens",
        complete: async () => "1. Check tokens.\n2. Check auth.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "first check auth second check tokens",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when formatting repeats an accent-restored negation", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "nao",
        complete: async () => "Não não.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "nao",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when formatting turns a question into a statement", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "vai funcionar, né?",
        complete: async () => "Vai funcionar.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "vai funcionar, né?",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when formatting moves a question mark to another sentence", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "Is the build green? Deploy it tomorrow.",
        complete: async () => "Is the build green. Deploy it tomorrow?",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "Is the build green? Deploy it tomorrow.",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when formatting turns a full-width exclamation into a question", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "Deploy！ Is it ready",
        complete: async () => "Deploy? Is it ready.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "Deploy！ Is it ready",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when formatting drops a repeat that can be meant", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "I had had enough of the flaky test",
        complete: async () => "I had enough of the flaky test.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "I had had enough of the flaky test",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when formatting drops the sign of a number", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "set the offset to -5",
        complete: async () => "Set the offset to 5.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "set the offset to -5",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when a no-wait phrase is not a correction", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "no wait is required",
        complete: async () => "Wait is required.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "no wait is required",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when a self-correction drops more than it replaces", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () =>
          "deploy auth service at noon no wait at midnight",
        complete: async () => "Deploy at midnight.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "deploy auth service at noon no wait at midnight",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when formatting reorders spoken words", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "validate config before deploy",
        complete: async () => "Validate deploy before config.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "validate config before deploy",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when formatting inserts an unspoken vocabulary term", async () => {
    await withTestHarness({}, async (harness) => {
      updateWritingAssistanceSettings(harness.deps.db, {
        vocabulary: ["not"],
      });
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "run the migration",
        complete: async () => "Not run the migration.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "run the migration",
        formatted: false,
      });
    });
  });

  it("keeps the transcript when formatting swaps a spoken word for a similar vocabulary term", async () => {
    await withTestHarness({}, async (harness) => {
      updateWritingAssistanceSettings(harness.deps.db, {
        vocabulary: ["pubic"],
      });
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "make the endpoint public",
        complete: async () => "Make the endpoint pubic.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "make the endpoint public",
        formatted: false,
      });
    });
  });

  it("formats a numbered list built from spoken ordinals", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "first check auth second run the tests",
        complete: async () => "1. Check auth.\n2. Run the tests.",
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "1. Check auth.\n2. Run the tests.",
        formatted: true,
      });
    });
  });

  it("keeps the transcript when the writing service fails or formatting is off", async () => {
    await withTestHarness({}, async (harness) => {
      const service = registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "hello there",
        complete: async () => {
          throw new Error("down");
        },
      });
      await expect((await postSegment(harness)).json()).resolves.toMatchObject({
        text: "hello there",
        formatted: false,
      });
      updateWritingAssistanceSettings(harness.deps.db, {
        dictationFormatting: false,
      });
      await postSegment(harness);
      expect(service.completeCalls).toHaveLength(1);
    });
  });

  it("refuses new audio once the daily dictation minutes are used", async () => {
    await withTestHarness({}, async (harness) => {
      const service = registerFakeAiService(harness.deps.aiServices);
      updateWritingAssistanceSettings(harness.deps.db, {
        dailyDictationMinutes: 1,
      });
      addWritingUsage(harness.deps.db, utcDay(), { audioSeconds: 60 });
      const response = await postSegment(harness);
      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({
        code: "budget_exhausted",
      });
      expect(service.transcribeCalls).toHaveLength(0);
    });
  });

  it("refuses a segment longer than the minutes left today", async () => {
    await withTestHarness({}, async (harness) => {
      const service = registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "hello there",
      });
      updateWritingAssistanceSettings(harness.deps.db, {
        dailyDictationMinutes: 1,
      });
      addWritingUsage(harness.deps.db, utcDay(), { audioSeconds: 50 });
      expect((await postSegment(harness, { file: wav(4) })).status).toBe(200);
      const refused = await postSegment(harness, { file: wav(8) });
      expect(refused.status).toBe(429);
      await expect(refused.json()).resolves.toMatchObject({
        code: "budget_exhausted",
      });
      expect(service.transcribeCalls).toHaveLength(1);
    });
  });

  it("refuses a concurrent segment that the one still transcribing has reserved", async () => {
    await withTestHarness({}, async (harness) => {
      let release = (_text: string) => {};
      const service = registerFakeAiService(harness.deps.aiServices, {
        transcribe: () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      });
      updateWritingAssistanceSettings(harness.deps.db, {
        dailyDictationMinutes: 1,
        dictationFormatting: false,
      });
      addWritingUsage(harness.deps.db, utcDay(), { audioSeconds: 50 });
      const first = postSegment(harness, { file: wav(6) });
      await vi.waitFor(() => expect(service.transcribeCalls).toHaveLength(1));
      const second = await postSegment(harness, { file: wav(6) });
      expect(second.status).toBe(429);
      await expect(second.json()).resolves.toMatchObject({
        code: "budget_exhausted",
      });
      expect(service.transcribeCalls).toHaveLength(1);
      release("hello there");
      expect((await first).status).toBe(200);
      expect(getWritingUsage(harness.deps.db, utcDay())).toMatchObject({
        audioSeconds: 56,
        dictationSegments: 1,
      });
    });
  });

  it("returns the reserved seconds when transcription fails", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => {
          throw new Error("down");
        },
      });
      addWritingUsage(harness.deps.db, utcDay(), { audioSeconds: 10 });
      expect((await postSegment(harness, { file: wav(4) })).status).toBe(502);
      expect(getWritingUsage(harness.deps.db, utcDay())).toMatchObject({
        audioSeconds: 10,
        dictationSegments: 0,
      });
    });
  });

  it("charges the measured length of a clip, whatever length the request claims", async () => {
    await withTestHarness({}, async (harness) => {
      const service = registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "hello there",
      });
      updateWritingAssistanceSettings(harness.deps.db, {
        dailyDictationMinutes: 2,
        dictationFormatting: false,
      });
      expect(
        (await postSegment(harness, { durationMs: "120000", file: wav(0.5) }))
          .status,
      ).toBe(200);
      expect(getWritingUsage(harness.deps.db, utcDay())).toMatchObject({
        audioSeconds: 0.5,
        dictationSegments: 1,
      });
      expect(
        (await postSegment(harness, { durationMs: "1000", file: wav(60) }))
          .status,
      ).toBe(200);
      expect(getWritingUsage(harness.deps.db, utcDay())).toMatchObject({
        audioSeconds: 60.5,
        dictationSegments: 2,
      });
      addWritingUsage(harness.deps.db, utcDay(), { audioSeconds: 10 });
      const refused = await postSegment(harness, { file: wav(60) });
      expect(refused.status).toBe(429);
      await expect(refused.json()).resolves.toMatchObject({
        code: "budget_exhausted",
      });
      expect(getWritingUsage(harness.deps.db, utcDay()).audioSeconds).toBe(
        70.5,
      );
      expect(service.transcribeCalls).toHaveLength(2);
    });
  });

  it("reserves the timeline of a WebM whose timestamps leave a gap and refuses one past the segment cap", async () => {
    await withTestHarness({}, async (harness) => {
      const service = registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "hello there",
      });
      updateWritingAssistanceSettings(harness.deps.db, {
        dictationFormatting: false,
      });
      const webm = (seconds: number) =>
        new File([Buffer.from(gappedWebm(seconds))], "dictation-1.webm", {
          type: "audio/webm",
        });
      expect((await postSegment(harness, { file: webm(30) })).status).toBe(200);
      expect(getWritingUsage(harness.deps.db, utcDay()).audioSeconds).toBe(
        30.1,
      );
      const tooLong = await postSegment(harness, { file: webm(130) });
      expect(tooLong.status).toBe(400);
      expect(getWritingUsage(harness.deps.db, utcDay()).audioSeconds).toBe(
        30.1,
      );
      expect(service.transcribeCalls).toHaveLength(1);
    });
  });

  it("measures a WAV by its declared audio data, not the metadata chunk after it", async () => {
    await withTestHarness({}, async (harness) => {
      registerFakeAiService(harness.deps.aiServices, {
        transcribe: async () => "hello there",
      });
      updateWritingAssistanceSettings(harness.deps.db, {
        dictationFormatting: false,
      });
      expect(
        (
          await postSegment(harness, {
            file: wav(2, 1_000, 200_000),
          })
        ).status,
      ).toBe(200);
      expect(getWritingUsage(harness.deps.db, utcDay()).audioSeconds).toBe(2);
    });
  });

  it("refuses audio longer than a segment, empty, or that it cannot measure, without reserving", async () => {
    await withTestHarness({}, async (harness) => {
      const service = registerFakeAiService(harness.deps.aiServices);
      const tooLong = await postSegment(harness, { file: wav(130) });
      expect(tooLong.status).toBe(400);
      await expect(tooLong.json()).resolves.toMatchObject({
        message: expect.stringContaining("at most 120 seconds"),
      });
      const unreadable = await postSegment(harness, {
        file: new File([Buffer.alloc(64, 1)], "dictation-1.webm", {
          type: "audio/webm",
        }),
      });
      expect(unreadable.status).toBe(400);
      await expect(unreadable.json()).resolves.toMatchObject({
        message: expect.stringContaining("Unsupported or unreadable audio"),
      });
      const empty = await postSegment(harness, { file: wav(0) });
      expect(empty.status).toBe(400);
      expect(service.transcribeCalls).toHaveLength(0);
      expect(getWritingUsage(harness.deps.db, utcDay()).audioSeconds).toBe(0);
    });
  });
});

describe("writing assistance settings route", () => {
  it("round-trips settings and rejects unknown values", async () => {
    await withTestHarness({}, async (harness) => {
      const put = await harness.app.request(
        "/api/v1/writing-assistance/settings",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "developer",
            vocabulary: ["bb", "Hermes"],
          }),
        },
      );
      expect(put.status).toBe(200);
      await expect(put.json()).resolves.toMatchObject({
        settings: { mode: "developer", vocabulary: ["bb", "Hermes"] },
      });
      const bad = await harness.app.request(
        "/api/v1/writing-assistance/settings",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "shouty" }),
        },
      );
      expect(bad.status).toBe(400);
      const view = await (
        await harness.app.request("/api/v1/writing-assistance")
      ).json();
      expect(view.settings.mode).toBe("developer");
    });
  });
});

describe("reply parsing", () => {
  it("keeps valid edits and drops malformed ones", () => {
    expect(
      parseCorrectionReply(
        'Here you go: {"edits":[{"original":"a","replacement":"b","category":"spelling","confidence":"high","semanticImpact":"none"},{"original":"","replacement":"x"}]}',
      ),
    ).toEqual([
      {
        original: "a",
        replacement: "b",
        category: "spelling",
        confidence: "high",
        semanticImpact: "none",
        explanation: null,
      },
    ]);
    expect(parseCorrectionReply("no json")).toBeNull();
  });

  it("keeps the complete edits of a reply cut off by the output limit", () => {
    const edit =
      '{"original":"acessing","replacement":"accessing","category":"spelling","confidence":"high","semanticImpact":"none","explanation":"typo {x}"}';
    expect(
      parseCorrectionReply(`{"edits":[${edit},{"original":"user are","repla`),
    ).toEqual([
      {
        original: "acessing",
        replacement: "accessing",
        category: "spelling",
        confidence: "high",
        semanticImpact: "none",
        explanation: "typo {x}",
      },
    ]);
    expect(parseCorrectionReply('{"edits":[{"original":"a')).toEqual([]);
  });

  it("unwraps fenced formatting replies", () => {
    expect(cleanFormattedReply("```\nHello there.\n```")).toBe("Hello there.");
    expect(cleanFormattedReply("   ")).toBeNull();
  });
});
