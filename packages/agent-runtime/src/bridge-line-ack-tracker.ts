export interface BridgeLineDelivery {
  replayKey: string;
  onSettled: () => void;
}

interface TrackedLine {
  wseq: number;
  outstanding: number;
  emitted: number;
  awaitingResponseId: string | number | null;
  heldByPendingOutput: boolean;
  blockedUntilWseq: number | null;
}

export interface BridgeLineAckTrackerArgs {
  workerId: string;
  onAckable: (through: number) => void;
}

export class BridgeLineAckTracker {
  private readonly args: BridgeLineAckTrackerArgs;
  private readonly lines: TrackedLine[] = [];
  private current: TrackedLine | null = null;
  private ackable = 0;
  private readonly settledWaiters: (() => void)[] = [];

  constructor(args: BridgeLineAckTrackerArgs) {
    this.args = args;
  }

  beginLine(wseq: number, awaitingResponseId: string | number | null): void {
    const line: TrackedLine = {
      wseq,
      outstanding: 0,
      emitted: 0,
      awaitingResponseId,
      heldByPendingOutput: false,
      blockedUntilWseq: null,
    };
    this.lines.push(line);
    this.current = line;
  }

  endLine(pendingOutput: boolean): void {
    const line = this.current;
    this.current = null;
    if (line === null) return;
    if (pendingOutput) {
      for (const earlier of this.lines) earlier.heldByPendingOutput = true;
    } else {
      this.releaseHeldLinesInto(line);
    }
    this.advance();
  }

  withLastLine(run: () => void): void {
    const last = this.lines.at(-1) ?? null;
    if (last === null) {
      run();
      return;
    }
    const previous = this.current;
    this.current = last;
    try {
      run();
    } finally {
      this.current = previous;
    }
  }

  releasePendingOutput(): void {
    const last = this.lines.at(-1);
    if (last !== undefined) this.releaseHeldLinesInto(last);
    this.advance();
  }

  private releaseHeldLinesInto(releasing: TrackedLine): void {
    for (const line of this.lines) {
      if (!line.heldByPendingOutput) continue;
      line.heldByPendingOutput = false;
      if (line !== releasing) line.blockedUntilWseq = releasing.wseq;
    }
  }

  delivery(): BridgeLineDelivery | undefined {
    const line = this.current;
    if (line === null) return undefined;
    const index = line.emitted;
    line.emitted += 1;
    line.outstanding += 1;
    let settled = false;
    return {
      replayKey: `${this.args.workerId}:${line.wseq}:${index}`,
      onSettled: () => {
        if (settled) return;
        settled = true;
        line.outstanding -= 1;
        this.advance();
      },
    };
  }

  responded(id: string | number): void {
    for (const line of this.lines) {
      if (line.awaitingResponseId === id) line.awaitingResponseId = null;
    }
    this.advance();
  }

  ackableThrough(): number {
    return this.ackable;
  }

  hasOutstandingEvents(): boolean {
    return this.lines.some((line) => line.outstanding > 0);
  }

  whenEventsSettled(timeoutMs: number): Promise<void> {
    if (!this.hasOutstandingEvents()) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      timer.unref();
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.settledWaiters.push(done);
    });
  }

  private advance(): void {
    let through = this.ackable;
    for (const line of this.lines) {
      if (
        line === this.current ||
        line.outstanding > 0 ||
        line.awaitingResponseId !== null
      ) {
        break;
      }
      if (!line.heldByPendingOutput && line.blockedUntilWseq === null) {
        through = line.wseq;
      }
    }
    if (through > this.ackable) {
      this.ackable = through;
      while ((this.lines[0]?.wseq ?? Infinity) <= through) this.lines.shift();
      this.args.onAckable(through);
    }
    if (!this.hasOutstandingEvents()) {
      for (const waiter of this.settledWaiters.splice(0)) waiter();
    }
  }
}
