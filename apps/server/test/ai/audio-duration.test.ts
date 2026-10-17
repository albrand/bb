import { describe, expect, it } from "vitest";
import { measureAudioSeconds } from "../../src/services/ai/audio-duration.js";
import {
  audioFixture as fixture,
  gappedWebm,
  liveWebm,
  mp4WithTimeline,
  oggWithLastGranule,
  opusBlock,
  wavWithMetadata,
  webmWithClusters,
} from "../helpers/audio-fixtures.js";

describe("measureAudioSeconds", () => {
  it.each([
    ["chromium-mediarecorder-3s.webm", 3],
    ["tone-3s.webm", 3],
    ["tone-3s.ogg", 3],
    ["tone-3s.m4a", 3],
    ["tone-3s-fragmented.mp4", 3],
    ["tone-3s-he-aac.m4a", 3],
    ["tone-3s.mp3", 3],
    ["tone-1s.wav", 1],
  ])("measures %s from its encoded frames", (name, seconds) => {
    const measured = measureAudioSeconds(fixture(name));
    expect(measured).not.toBeNull();
    expect(measured!).toBeGreaterThanOrEqual(seconds);
    expect(measured!).toBeLessThan(seconds * 1.1);
  });

  it("counts every Opus frame in a live recording with unknown-size segment and cluster", () => {
    const twentyMs = opusBlock([0xf8]);
    expect(
      measureAudioSeconds(liveWebm(Array(150).fill(twentyMs))),
    ).toBeCloseTo(3, 5);
    const tenFrames = opusBlock([0xfb, 0x0a]);
    expect(
      measureAudioSeconds(liveWebm(Array(30).fill(tenFrames))),
    ).toBeCloseTo(6, 5);
    const twoFrames = opusBlock([0xf9]);
    expect(
      measureAudioSeconds(liveWebm(Array(10).fill(twoFrames))),
    ).toBeCloseTo(0.4, 5);
  });

  it("measures the timeline a decoder plays when timestamps leave gaps between packets", () => {
    expect(measureAudioSeconds(gappedWebm(130))).toBeCloseTo(130.02, 5);
    const farBlock = opusBlock([0xf8], 0x80, 32_000);
    expect(
      measureAudioSeconds(
        webmWithClusters([[0, [opusBlock([0xf8]), farBlock]]]),
      ),
    ).toBeCloseTo(32.02, 5);
    expect(
      measureAudioSeconds(oggWithLastGranule("tone-3s.ogg", 130 * 48_000)),
    ).toBeCloseTo(130, 5);
    expect(
      measureAudioSeconds(mp4WithTimeline("tone-3s.m4a", "mvhd", 130)),
    ).toBeGreaterThanOrEqual(130);
    expect(
      measureAudioSeconds(mp4WithTimeline("tone-3s.m4a", "stts", 130)),
    ).toBeGreaterThanOrEqual(130);
    expect(
      measureAudioSeconds(
        mp4WithTimeline("tone-3s-fragmented.mp4", "tfdt", 130),
      ),
    ).toBeGreaterThanOrEqual(130);
  });

  it("measures a WAV by its declared data chunk, not metadata after it", () => {
    expect(
      measureAudioSeconds(wavWithMetadata("tone-1s.wav", 200_000)),
    ).toBeCloseTo(1, 5);
  });

  it("refuses laced blocks, other codecs, truncated files and unknown formats", () => {
    expect(measureAudioSeconds(liveWebm([opusBlock([0xf8], 0x82)]))).toBeNull();
    expect(
      measureAudioSeconds(liveWebm([opusBlock([0xf8])], "A_VORBIS")),
    ).toBeNull();
    const webm = fixture("tone-3s.webm");
    expect(measureAudioSeconds(webm.subarray(0, webm.length - 3))).toBeNull();
    const mp4 = fixture("tone-3s.m4a");
    expect(measureAudioSeconds(mp4.subarray(0, mp4.length - 3))).toBeNull();
    expect(measureAudioSeconds(new Uint8Array(64).fill(1))).toBeNull();
  });
});
