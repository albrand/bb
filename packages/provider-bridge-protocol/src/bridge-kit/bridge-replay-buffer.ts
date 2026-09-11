import { closeSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";

export interface BridgeReplayFrame {
  wseq: number;
  bytes: Buffer;
}

export interface BridgeReplayBufferArgs {
  spillPath: string;
  memoryCapBytes: number;
}

export interface BridgeReplayBufferStats {
  frames: number;
  memoryBytes: number;
  spilledBytes: number;
}

interface SpilledFrame {
  wseq: number;
  offset: number;
  length: number;
}

export class BridgeReplayBuffer {
  private readonly args: BridgeReplayBufferArgs;
  private readonly inMemory: BridgeReplayFrame[] = [];
  private readonly spilled: SpilledFrame[] = [];
  private memoryBytes = 0;
  private spillFd: number | null = null;
  private spillEnd = 0;
  private spilledBytes = 0;

  constructor(args: BridgeReplayBufferArgs) {
    this.args = args;
  }

  append(frame: BridgeReplayFrame): void {
    const spilling =
      this.spilled.length > 0 ||
      this.memoryBytes + frame.bytes.length > this.args.memoryCapBytes;
    if (!spilling) {
      this.inMemory.push(frame);
      this.memoryBytes += frame.bytes.length;
      return;
    }
    const fd = this.openSpill();
    writeSync(fd, frame.bytes, 0, frame.bytes.length, this.spillEnd);
    this.spilled.push({
      wseq: frame.wseq,
      offset: this.spillEnd,
      length: frame.bytes.length,
    });
    this.spillEnd += frame.bytes.length;
    this.spilledBytes += frame.bytes.length;
  }

  ackThrough(wseq: number, keep: readonly number[] = []): void {
    const kept = new Set(keep);
    this.memoryBytes -= dropAckedPrefix(
      this.inMemory,
      wseq,
      kept,
      (frame) => frame.bytes.length,
    );
    this.spilledBytes -= dropAckedPrefix(
      this.spilled,
      wseq,
      kept,
      (frame) => frame.length,
    );
    if (this.spilled.length === 0 && this.spillFd !== null) {
      this.discardSpill();
    }
  }

  *framesAfter(
    wseq: number,
    keep: readonly number[] = [],
  ): Generator<BridgeReplayFrame> {
    const kept = new Set(keep);
    for (const frame of this.inMemory) {
      if (frame.wseq > wseq || kept.has(frame.wseq)) yield frame;
    }
    for (const spilled of [...this.spilled]) {
      if ((spilled.wseq <= wseq && !kept.has(spilled.wseq)) || this.spillFd === null) continue;
      const bytes = Buffer.alloc(spilled.length);
      readSync(this.spillFd, bytes, 0, spilled.length, spilled.offset);
      yield { wseq: spilled.wseq, bytes };
    }
  }

  retainedBytes(): number {
    return this.memoryBytes + this.spilledBytes;
  }

  stats(): BridgeReplayBufferStats {
    return {
      frames: this.inMemory.length + this.spilled.length,
      memoryBytes: this.memoryBytes,
      spilledBytes: this.spilledBytes,
    };
  }

  dispose(): void {
    this.inMemory.length = 0;
    this.spilled.length = 0;
    this.memoryBytes = 0;
    this.spilledBytes = 0;
    this.discardSpill();
  }

  private openSpill(): number {
    if (this.spillFd === null) {
      this.spillFd = openSync(this.args.spillPath, "w+", 0o600);
      this.spillEnd = 0;
    }
    return this.spillFd;
  }

  private discardSpill(): void {
    if (this.spillFd === null) return;
    closeSync(this.spillFd);
    this.spillFd = null;
    this.spillEnd = 0;
    try {
      unlinkSync(this.args.spillPath);
    } catch {}
  }
}

function dropAckedPrefix<TFrame extends { wseq: number }>(
  frames: TFrame[],
  through: number,
  kept: ReadonlySet<number>,
  size: (frame: TFrame) => number,
): number {
  let end = 0;
  while (end < frames.length && (frames[end]?.wseq ?? Infinity) <= through) {
    end += 1;
  }
  const keptFrames: TFrame[] = [];
  let freed = 0;
  for (const frame of frames.splice(0, end)) {
    if (kept.has(frame.wseq)) keptFrames.push(frame);
    else freed += size(frame);
  }
  frames.unshift(...keptFrames);
  return freed;
}
