import {
  terminalServerMessageSchema,
  type TerminalOutputChunk,
  type TerminalServerMessage,
  type TerminalSession,
} from "@bb/server-contract";

export interface ChildTerminalReplayFrame {
  chunks: TerminalOutputChunk[];
  nextSeq: number;
  replayStartSeq: number;
  session: TerminalSession;
}

export type ChildTerminalBroadcastMessage = Extract<
  TerminalServerMessage,
  { type: "session-updated" | "exited" | "error" }
>;

export type ChildTerminalReplyMessage =
  | Extract<TerminalServerMessage, { type: "features" | "resize-applied" }>
  | (Extract<TerminalServerMessage, { type: "session-updated" }> & {
      resizeSeq: number;
    });

export interface ChildTerminalSocketSink {
  broadcast(
    terminalId: string,
    message: ChildTerminalBroadcastMessage,
    bytes: number,
  ): void;
  close(attachId: string, code: number, reason: string): void;
  relayOutput(terminalId: string, chunk: TerminalOutputChunk): void;
  reply(attachId: string, message: ChildTerminalReplyMessage): void;
  replay(
    socket: ChildTerminalSocket,
    frame: ChildTerminalReplayFrame,
    trailing: ChildTerminalBroadcastMessage[],
  ): void;
}

export class ChildTerminalSocket {
  private collecting: {
    chunks: TerminalOutputChunk[];
    frame: Omit<ChildTerminalReplayFrame, "chunks">;
    trailing: ChildTerminalBroadcastMessage[];
  } | null = null;
  private closed = false;

  constructor(
    readonly attachId: string,
    readonly terminalId: string,
    private readonly sink: ChildTerminalSocketSink,
    readonly outputAcks: boolean,
    readonly resizeAcks: boolean,
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  markClosed(): void {
    this.closed = true;
  }

  send(data: string): void {
    if (this.closed) {
      return;
    }
    const message = terminalServerMessageSchema.parse(JSON.parse(data));
    switch (message.type) {
      case "pong":
        return;
      case "features":
      case "resize-applied":
        this.sink.reply(this.attachId, message);
        return;
      case "attached":
        this.collecting = {
          chunks: [],
          frame: {
            nextSeq: message.nextSeq,
            replayStartSeq: message.replayStartSeq,
            session: message.session,
          },
          trailing: [],
        };
        queueMicrotask(() => this.flushReplay());
        return;
      case "output":
        if (this.collecting !== null) {
          this.collecting.chunks.push(message.chunk);
          return;
        }
        this.sink.relayOutput(this.terminalId, message.chunk);
        return;
      case "exited":
      case "error":
        if (this.collecting !== null) {
          this.collecting.trailing.push(message);
          return;
        }
        this.sink.broadcast(this.terminalId, message, data.length);
        return;
      case "session-updated":
        const resizeSeq = message.resizeSeq;
        if (typeof resizeSeq === "number") {
          this.sink.reply(this.attachId, {
            ...message,
            resizeSeq,
          });
          return;
        }
        if (this.collecting !== null) {
          this.collecting.trailing.push(message);
          return;
        }
        this.sink.broadcast(this.terminalId, message, data.length);
        return;
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) {
      return;
    }
    this.flushReplay();
    this.closed = true;
    this.sink.close(this.attachId, code, reason);
  }

  private flushReplay(): void {
    const collecting = this.collecting;
    if (collecting === null) {
      return;
    }
    this.collecting = null;
    if (this.closed) {
      return;
    }
    this.sink.replay(
      this,
      { ...collecting.frame, chunks: collecting.chunks },
      collecting.trailing,
    );
  }
}
