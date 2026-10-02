import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { supervisePortProbeSockets } from "./host-probes.js";

describe("server-move port probe sockets", () => {
  it("logs and closes a reset TCP client socket", async () => {
    const logger = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = createServer((socket) => socket.resume());
    supervisePortProbeSockets(server, "127.0.0.1", 0);

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP server address");
      }
      const client = createConnection(address.port, "127.0.0.1");
      await once(client, "connect");
      client.resetAndDestroy();

      await vi.waitFor(() => {
        expect(logger).toHaveBeenCalledWith(
          expect.objectContaining({
            err: expect.objectContaining({ code: "ECONNRESET" }),
            host: "127.0.0.1",
            localPort: address.port,
            port: 0,
          }),
          "Host daemon port availability probe TCP client socket failed",
        );
      });
    } finally {
      logger.mockRestore();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
