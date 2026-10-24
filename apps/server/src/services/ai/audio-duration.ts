const WEBM_SEGMENT = 0x18538067;
const WEBM_CLUSTER = 0x1f43b675;
const WEBM_BLOCK_GROUP = 0xa0;
const WEBM_BLOCK = 0xa1;
const WEBM_SIMPLE_BLOCK = 0xa3;
const WEBM_TRACKS = 0x1654ae6b;
const WEBM_TRACK_ENTRY = 0xae;
const WEBM_CODEC_ID = 0x86;
const WEBM_INFO = 0x1549a966;
const WEBM_TIMECODE_SCALE = 0x2ad7b1;
const WEBM_CLUSTER_TIMECODE = 0xe7;
const WEBM_CONTAINERS = new Set([
  WEBM_SEGMENT,
  WEBM_INFO,
  WEBM_CLUSTER,
  WEBM_BLOCK_GROUP,
  WEBM_TRACKS,
  WEBM_TRACK_ENTRY,
]);

const MP4_CONTAINERS = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "moof",
  "traf",
  "edts",
  "mvex",
]);

const MP4_MAX_DEPTH = 16;

const AAC_SAMPLE_RATES = [
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000,
  12_000, 11_025, 8_000, 7_350,
];

const MP3_BITRATES_KBPS: Record<string, readonly number[]> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const MP3_SAMPLE_RATES: Record<number, readonly number[]> = {
  3: [44_100, 48_000, 32_000],
  2: [22_050, 24_000, 16_000],
  0: [11_025, 12_000, 8_000],
};

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function opusPacketSeconds(packet: Uint8Array): number | null {
  if (packet.length === 0) return null;
  const toc = packet[0]!;
  const config = toc >> 3;
  const frameMs =
    config < 12
      ? [10, 20, 40, 60][config % 4]!
      : config < 16
        ? [10, 20][config % 2]!
        : [2.5, 5, 10, 20][config % 4]!;
  const code = toc & 3;
  let frames = code === 0 ? 1 : 2;
  if (code === 3) {
    if (packet.length < 2) return null;
    frames = packet[1]! & 0x3f;
  }
  return (frames * frameMs) / 1000;
}

function readVint(
  bytes: Uint8Array,
  offset: number,
  keepMarker: boolean,
): { value: number; length: number; unknown: boolean } | null {
  const first = bytes[offset];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > 8 || offset + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let index = 1; index < length; index += 1) {
    const byte = bytes[offset + index]!;
    value = value * 256 + byte;
    allOnes &&= byte === 0xff;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function readUintBE(bytes: Uint8Array, start: number, length: number): number {
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    value = value * 256 + bytes[start + index]!;
  }
  return value;
}

function webmSeconds(bytes: Uint8Array): number | null {
  let offset = 0;
  let seconds = 0;
  let opus = false;
  let blocks = 0;
  let timecodeScale = 1_000_000;
  let clusterTimecode = 0;
  let firstStart = 0;
  let lastEnd = 0;
  while (offset < bytes.length) {
    const id = readVint(bytes, offset, true);
    if (id === null) return null;
    const size = readVint(bytes, offset + id.length, false);
    if (size === null) return null;
    const start = offset + id.length + size.length;
    if (WEBM_CONTAINERS.has(id.value)) {
      offset = start;
      continue;
    }
    if (size.unknown || start + size.value > bytes.length) return null;
    const end = start + size.value;
    if (id.value === WEBM_CODEC_ID) {
      if (size.value !== 6 || ascii(bytes, start, 6) !== "A_OPUS") return null;
      opus = true;
    }
    if (
      id.value === WEBM_TIMECODE_SCALE ||
      id.value === WEBM_CLUSTER_TIMECODE
    ) {
      if (size.value > 8) return null;
      const value = readUintBE(bytes, start, size.value);
      if (id.value === WEBM_TIMECODE_SCALE) {
        if (value === 0) return null;
        timecodeScale = value;
      } else {
        clusterTimecode = value;
      }
    }
    if (id.value === WEBM_SIMPLE_BLOCK || id.value === WEBM_BLOCK) {
      const track = readVint(bytes, start, false);
      if (track === null) return null;
      const flags = bytes[start + track.length + 2];
      if (flags === undefined || (flags & 0x06) !== 0) return null;
      const packet = opusPacketSeconds(
        bytes.subarray(start + track.length + 3, end),
      );
      if (packet === null) return null;
      const relative = (readUintBE(bytes, start + track.length, 2) << 16) >> 16;
      const at = ((clusterTimecode + relative) * timecodeScale) / 1e9;
      firstStart = Math.min(firstStart, at);
      lastEnd = Math.max(lastEnd, at + packet);
      seconds += packet;
      blocks += 1;
    }
    offset = end;
  }
  return opus && blocks > 0 ? Math.max(seconds, lastEnd - firstStart) : null;
}

function oggSeconds(bytes: Uint8Array): number | null {
  let offset = 0;
  let packets = 0;
  let seconds = 0;
  let current: number[] = [];
  let lastGranule = 0;
  const finish = (packet: Uint8Array): boolean => {
    packets += 1;
    if (packets === 1) return ascii(packet, 0, 8) === "OpusHead";
    if (packets === 2) return ascii(packet, 0, 8) === "OpusTags";
    const packetSeconds = opusPacketSeconds(packet);
    if (packetSeconds === null) return false;
    seconds += packetSeconds;
    return true;
  };
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || ascii(bytes, offset, 4) !== "OggS") {
      return null;
    }
    const granuleLow = readUint32LE(bytes, offset + 6);
    const granuleHigh = readUint32LE(bytes, offset + 10);
    if (granuleLow !== 0xffffffff || granuleHigh !== 0xffffffff) {
      lastGranule = Math.max(
        lastGranule,
        granuleHigh * 0x100000000 + granuleLow,
      );
    }
    const segments = bytes[offset + 26]!;
    const tableEnd = offset + 27 + segments;
    if (tableEnd > bytes.length) return null;
    let dataOffset = tableEnd;
    for (let index = 0; index < segments; index += 1) {
      const lace = bytes[offset + 27 + index]!;
      if (dataOffset + lace > bytes.length) return null;
      for (let byte = 0; byte < lace && current.length < 8; byte += 1) {
        current.push(bytes[dataOffset + byte]!);
      }
      dataOffset += lace;
      if (lace < 255) {
        if (!finish(Uint8Array.from(current))) return null;
        current = [];
      }
    }
    offset = dataOffset;
  }
  return packets > 2 ? Math.max(seconds, lastGranule / 48_000) : null;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    ((bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) +
    bytes[offset + 3]! * 0x1000000
  );
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    ((bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!)
  );
}

function aacSampleRate(esds: Uint8Array): number | null {
  let offset = 4;
  while (offset < esds.length) {
    const tag = esds[offset]!;
    offset += 1;
    let length = 0;
    for (let index = 0; index < 4; index += 1) {
      const byte = esds[offset];
      if (byte === undefined) return null;
      offset += 1;
      length = (length << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    if (tag === 0x03) {
      const flags = esds[offset + 2];
      if (flags === undefined) return null;
      offset += 3;
      if (flags & 0x80) offset += 2;
      if (flags & 0x40) offset += 1 + (esds[offset] ?? 0);
      if (flags & 0x20) offset += 2;
      continue;
    }
    if (tag === 0x04) {
      offset += 13;
      continue;
    }
    if (tag === 0x05) {
      if (offset + 2 > esds.length) return null;
      const bits = (esds[offset]! << 8) | esds[offset + 1]!;
      const objectType = bits >> 11;
      const index = (bits >> 7) & 0x0f;
      if (objectType === 31 || index > 12) return null;
      return AAC_SAMPLE_RATES[index]!;
    }
    offset += length;
  }
  return null;
}

function mp4Seconds(bytes: Uint8Array): number | null {
  const found: { samples: number; sampleRate: number | null; tracks: number } =
    { samples: 0, sampleRate: null, tracks: 0 };
  const time = {
    movieScale: 0,
    movieDuration: 0,
    editDuration: 0,
    mediaScale: 0,
    mediaDuration: 0,
    sampleTable: 0,
    defaultDuration: 0,
    fragmentDefault: 0,
    fragmentTime: 0,
    fragmentEnd: 0,
  };
  const readTime = (at: number, version: number): number =>
    version === 1
      ? readUint32(bytes, at) * 0x100000000 + readUint32(bytes, at + 4)
      : readUint32(bytes, at);
  const walk = (start: number, end: number, depth: number): boolean => {
    if (depth > MP4_MAX_DEPTH) return false;
    let offset = start;
    while (offset < end) {
      if (offset + 8 > end) return false;
      let size = readUint32(bytes, offset);
      const type = ascii(bytes, offset + 4, 4);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) return false;
        size =
          readUint32(bytes, offset + 8) * 0x100000000 +
          readUint32(bytes, offset + 12);
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < header || offset + size > end) return false;
      const body = offset + header;
      const boxEnd = offset + size;
      const version = bytes[body] ?? 0;
      const flags = body + 4 <= boxEnd ? readUint32(bytes, body) & 0xffffff : 0;
      if (MP4_CONTAINERS.has(type)) {
        if (type === "trak") found.tracks += 1;
        if (type === "traf") {
          time.fragmentDefault = time.defaultDuration;
          time.fragmentTime = 0;
        }
        if (!walk(body, boxEnd, depth + 1)) return false;
      } else if (type === "mvhd" || type === "mdhd") {
        const scaleAt = body + (version === 1 ? 20 : 12);
        if (scaleAt + (version === 1 ? 12 : 8) > boxEnd) return false;
        const scale = readUint32(bytes, scaleAt);
        const duration = readTime(scaleAt + 4, version);
        const known = duration !== 0xffffffff && duration !== 2 ** 64 - 1;
        if (type === "mvhd") {
          time.movieScale = scale;
          time.movieDuration = known ? duration : 0;
        } else {
          time.mediaScale = scale;
          time.mediaDuration = known ? duration : 0;
        }
      } else if (type === "elst") {
        if (body + 8 > boxEnd) return false;
        const entry = version === 1 ? 20 : 12;
        const count = readUint32(bytes, body + 4);
        if (body + 8 + count * entry > boxEnd) return false;
        for (let index = 0; index < count; index += 1) {
          time.editDuration += readTime(body + 8 + index * entry, version);
        }
      } else if (type === "stts") {
        if (body + 8 > boxEnd) return false;
        const count = readUint32(bytes, body + 4);
        if (body + 8 + count * 8 > boxEnd) return false;
        for (let index = 0; index < count; index += 1) {
          const at = body + 8 + index * 8;
          time.sampleTable += readUint32(bytes, at) * readUint32(bytes, at + 4);
        }
      } else if (type === "trex") {
        if (body + 16 > boxEnd) return false;
        time.defaultDuration = readUint32(bytes, body + 12);
      } else if (type === "tfhd") {
        const at = body + 8 + (flags & 0x01 ? 8 : 0) + (flags & 0x02 ? 4 : 0);
        if (flags & 0x08) {
          if (at + 4 > boxEnd) return false;
          time.fragmentDefault = readUint32(bytes, at);
        }
      } else if (type === "tfdt") {
        if (body + (version === 1 ? 12 : 8) > boxEnd) return false;
        time.fragmentTime = readTime(body + 4, version);
      } else if (type === "stsd") {
        if (!walk(body + 8, boxEnd, depth + 1)) return false;
      } else if (type === "mp4a") {
        if (body + 28 > boxEnd) return false;
        const version = (bytes[body + 8]! << 8) | bytes[body + 9]!;
        const entry = [28, 44, 64][version];
        if (entry === undefined || !walk(body + entry, boxEnd, depth + 1))
          return false;
      } else if (type === "esds") {
        found.sampleRate = aacSampleRate(bytes.subarray(body, boxEnd));
        if (found.sampleRate === null) return false;
      } else if (type === "stsz") {
        if (body + 12 > boxEnd) return false;
        found.samples += readUint32(bytes, body + 8);
      } else if (type === "trun") {
        if (body + 8 > boxEnd) return false;
        const count = readUint32(bytes, body + 4);
        found.samples += count;
        let at = body + 8 + (flags & 0x01 ? 4 : 0) + (flags & 0x04 ? 4 : 0);
        const entry =
          [0x100, 0x200, 0x400, 0x800].filter((bit) => flags & bit).length * 4;
        if (at + count * entry > boxEnd) return false;
        for (let index = 0; index < count; index += 1) {
          time.fragmentTime +=
            flags & 0x100 ? readUint32(bytes, at) : time.fragmentDefault;
          at += entry;
        }
        time.fragmentEnd = Math.max(time.fragmentEnd, time.fragmentTime);
      }
      offset = boxEnd;
    }
    return true;
  };
  if (!walk(0, bytes.length, 0) || found.tracks !== 1) return null;
  if (found.sampleRate === null || found.samples === 0) return null;
  const movie =
    time.movieScale > 0
      ? Math.max(time.movieDuration, time.editDuration) / time.movieScale
      : 0;
  const media =
    time.mediaScale > 0
      ? Math.max(time.mediaDuration, time.sampleTable, time.fragmentEnd) /
        time.mediaScale
      : 0;
  return Math.max((found.samples * 1024) / found.sampleRate, movie, media);
}

const RIFF_CHUNK_IDS: ReadonlySet<string> = new Set([
  "LIST",
  "JUNK",
  "PAD ",
  "bext",
  "cue ",
  "smpl",
  "fact",
  "iXML",
  "axml",
  "id3 ",
  "ID3 ",
  "inst",
  "acid",
  "cart",
  "umid",
  "plst",
  "fmt ",
  "data",
]);

function riffChunkAt(bytes: Uint8Array, offset: number): boolean {
  if (offset + 8 > bytes.length) return false;
  if (!RIFF_CHUNK_IDS.has(ascii(bytes, offset, 4))) return false;
  const size = readUint32LE(bytes, offset + 4);
  return offset + 8 + size <= bytes.length;
}

function wavSeconds(bytes: Uint8Array): number | null {
  let offset = 12;
  let bytesPerSecond = 0;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const size = readUint32LE(bytes, offset + 4);
    const body = offset + 8;
    if (type === "fmt ") {
      if (body + 16 > bytes.length) return null;
      const format = bytes[body]! | (bytes[body + 1]! << 8);
      if (format !== 1 && format !== 3 && format !== 0xfffe) return null;
      const channels = bytes[body + 2]! | (bytes[body + 3]! << 8);
      const sampleRate = readUint32LE(bytes, body + 4);
      const bits = bytes[body + 14]! | (bytes[body + 15]! << 8);
      bytesPerSecond = (sampleRate * channels * bits) / 8;
    }
    if (type === "data" && size === 0 && riffChunkAt(bytes, body)) {
      return null;
    }
    if (type === "data") {
      const present = bytes.length - body;
      const streamed = size === 0 || size === 0xffffffff;
      const audio = streamed ? present : Math.min(size, present);
      return bytesPerSecond > 0 ? audio / bytesPerSecond : null;
    }
    offset = body + size + (size % 2);
  }
  return null;
}

function mp3Seconds(bytes: Uint8Array): number | null {
  let offset = 0;
  if (ascii(bytes, 0, 3) === "ID3") {
    if (bytes.length < 10) return null;
    offset =
      10 +
      ((bytes[6]! & 0x7f) << 21) +
      ((bytes[7]! & 0x7f) << 14) +
      ((bytes[8]! & 0x7f) << 7) +
      (bytes[9]! & 0x7f);
  }
  let seconds = 0;
  let frames = 0;
  while (offset + 4 <= bytes.length) {
    if (bytes.length - offset === 128 && ascii(bytes, offset, 3) === "TAG") {
      break;
    }
    const b1 = bytes[offset + 1]!;
    const b2 = bytes[offset + 2]!;
    if (bytes[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
    const version = (b1 >> 3) & 3;
    const layer = 4 - ((b1 >> 1) & 3);
    const rates = MP3_SAMPLE_RATES[version];
    const bitrates = MP3_BITRATES_KBPS[`${version === 3 ? 1 : 2}-${layer}`];
    const sampleRate = rates?.[(b2 >> 2) & 3];
    const bitrate = bitrates?.[b2 >> 4];
    if (sampleRate === undefined || bitrate === undefined || bitrate === 0) {
      return null;
    }
    const padding = (b2 >> 1) & 1;
    const samples =
      layer === 1 ? 384 : layer === 3 && version !== 3 ? 576 : 1152;
    const length =
      layer === 1
        ? (Math.floor((12_000 * bitrate) / sampleRate) + padding) * 4
        : Math.floor(((samples / 8) * 1000 * bitrate) / sampleRate) + padding;
    seconds += samples / sampleRate;
    frames += 1;
    offset += length;
  }
  return frames > 0 ? seconds : null;
}

export function measureAudioSeconds(bytes: Uint8Array): number | null {
  if (bytes.length < 12) return null;
  if (readUint32(bytes, 0) === 0x1a45dfa3) return webmSeconds(bytes);
  if (ascii(bytes, 0, 4) === "OggS") return oggSeconds(bytes);
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") {
    return wavSeconds(bytes);
  }
  if (ascii(bytes, 4, 4) === "ftyp") return mp4Seconds(bytes);
  if (ascii(bytes, 0, 3) === "ID3" || bytes[0] === 0xff) {
    return mp3Seconds(bytes);
  }
  return null;
}
