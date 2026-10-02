import type { Server, Socket } from "node:net";

export type TcpServerSocketErrorHandler = (
  error: Error,
  socket: Socket,
  context: TcpServerSocketContext,
) => void;

export interface TcpServerSocketContext {
  localAddress: string | undefined;
  localPort: number | undefined;
  remoteAddress: string | undefined;
  remotePort: number | undefined;
}

export function superviseTcpServerSockets(
  server: Pick<Server, "on">,
  onError: TcpServerSocketErrorHandler,
): void {
  server.on("connection", (socket) => {
    const context: TcpServerSocketContext = {
      localAddress: socket.localAddress,
      localPort: socket.localPort,
      remoteAddress: undefined,
      remotePort: undefined,
    };
    process.nextTick(() => {
      context.remoteAddress = socket.remoteAddress;
      context.remotePort = socket.remotePort;
    });
    socket.on("error", (error) => {
      try {
        onError(error, socket, context);
      } finally {
        socket.destroy();
      }
    });
  });
}
