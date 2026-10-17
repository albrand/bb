import { readFileSync } from "node:fs";

export function audioFixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`../fixtures/audio/${name}`, import.meta.url)),
  );
}

function element(
  id: number[],
  payload: number[],
  unknownSize = false,
): number[] {
  const size = unknownSize
    ? [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
    : [
        0x10 | (payload.length >> 24),
        (payload.length >> 16) & 0xff,
        (payload.length >> 8) & 0xff,
        payload.length & 0xff,
      ];
  return [...id, ...size, ...payload];
}

function uint32(value: number): number[] {
  return [
    value >>> 24,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

export function webmWithClusters(
  clusters: [timecode: number, blocks: number[][]][],
  codec = "A_OPUS",
): Uint8Array {
  const codecId = [...codec].map((char) => char.charCodeAt(0));
  const tracks = element(
    [0x16, 0x54, 0xae, 0x6b],
    element([0xae], element([0x86], codecId)),
  );
  const body = clusters.flatMap(([timecode, blocks]) =>
    element(
      [0x1f, 0x43, 0xb6, 0x75],
      [
        ...element([0xe7], uint32(timecode)),
        ...blocks.flatMap((block) => element([0xa3], block)),
      ],
      true,
    ),
  );
  return Uint8Array.from([
    ...element(
      [0x1a, 0x45, 0xdf, 0xa3],
      element([0x42, 0x82], [0x77, 0x65, 0x62, 0x6d]),
    ),
    ...element([0x18, 0x53, 0x80, 0x67], [...tracks, ...body], true),
  ]);
}

export function liveWebm(blocks: number[][], codec = "A_OPUS"): Uint8Array {
  return webmWithClusters([[0, blocks]], codec);
}

export function opusBlock(
  toc: number[],
  flags = 0x80,
  relativeMs = 0,
): number[] {
  return [
    0x81,
    (relativeMs >> 8) & 0xff,
    relativeMs & 0xff,
    flags,
    ...toc,
    0x00,
    0x00,
  ];
}

export function gappedWebm(gapSeconds: number): Uint8Array {
  const twentyMs = opusBlock([0xf8]);
  return webmWithClusters([
    [0, [twentyMs]],
    [gapSeconds * 1000, [twentyMs]],
  ]);
}

export function wavWithMetadata(
  name: string,
  metadataBytes: number,
): Uint8Array {
  const audio = audioFixture(name);
  const bytes = new Uint8Array(audio.length + 8 + metadataBytes);
  bytes.set(audio);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4c, 0x49, 0x53, 0x54], audio.length);
  view.setUint32(audio.length + 4, metadataBytes, true);
  view.setUint32(4, bytes.length - 8, true);
  return bytes;
}

const OGG_CRC = Array.from({ length: 256 }, (_, index) => {
  let crc = index << 24;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
});

export function oggWithLastGranule(name: string, granule: number): Uint8Array {
  const bytes = Uint8Array.from(audioFixture(name));
  const view = new DataView(bytes.buffer);
  let last = 0;
  for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
    if (view.getUint32(offset) === 0x4f676753) last = offset;
  }
  view.setBigUint64(last + 6, BigInt(granule), true);
  view.setUint32(last + 22, 0, true);
  let crc = 0;
  for (let offset = last; offset < bytes.length; offset += 1) {
    crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ bytes[offset]!) & 0xff]!) >>> 0;
  }
  view.setUint32(last + 22, crc, true);
  return bytes;
}

function boxBody(
  bytes: Uint8Array,
  type: string,
  which: "first" | "last",
): number {
  const code = [...type].map((char) => char.charCodeAt(0));
  let found = -1;
  for (let offset = 4; offset + 4 <= bytes.length; offset += 1) {
    if (code.every((byte, index) => bytes[offset + index] === byte)) {
      found = offset + 4;
      if (which === "first") break;
    }
  }
  if (found < 0) throw new Error(`no ${type} box`);
  return found;
}

export function mp4WithTimeline(
  name: string,
  field: "mvhd" | "stts" | "tfdt",
  seconds: number,
): Uint8Array {
  const bytes = Uint8Array.from(audioFixture(name));
  const view = new DataView(bytes.buffer);
  if (field === "mvhd") {
    const body = boxBody(bytes, "mvhd", "first");
    if (bytes[body] !== 0) throw new Error("expected a version 0 mvhd");
    view.setUint32(body + 16, seconds * view.getUint32(body + 12));
    return bytes;
  }
  const mdhd = boxBody(bytes, "mdhd", "first");
  if (bytes[mdhd] !== 0) throw new Error("expected a version 0 mdhd");
  const scale = view.getUint32(mdhd + 12);
  if (field === "stts") {
    const body = boxBody(bytes, "stts", "first");
    view.setUint32(body + 12, seconds * scale);
    return bytes;
  }
  const body = boxBody(bytes, "tfdt", "last");
  if (bytes[body] === 1) view.setBigUint64(body + 4, BigInt(seconds * scale));
  else view.setUint32(body + 4, seconds * scale);
  return bytes;
}
