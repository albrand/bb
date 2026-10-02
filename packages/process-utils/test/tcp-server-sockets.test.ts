import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("superviseTcpServerSockets", () => {
  it("reproduces an uncaught reset on an accepted socket without supervision", async () => {
    const script = `
      import { createServer, connect } from "node:net";
      const server = createServer((socket) =>
        socket.on("data", () => socket.write("ack")),
      );
      server.listen(0, "127.0.0.1", () => {
        const client = connect(server.address().port, "127.0.0.1", () => {
          client.write("hello");
        });
        client.on("data", () => client.resetAndDestroy());
        client.on("error", () => undefined);
      });
      setTimeout(() => server.close(), 100);
    `;
    const result = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { cwd: import.meta.dirname },
    ).then(
      (output) => ({ status: "resolved", output }),
      (error: unknown) => ({ status: "rejected", error }),
    );

    expect(result).toMatchObject({
      status: "rejected",
      error: {
        code: 1,
        stderr: expect.stringContaining("Unhandled 'error' event"),
      },
    });
  });

  it("turns a reset accepted socket from an uncaught process error into a logged cleanup", async () => {
    const script = `
      import { createServer, connect } from "node:net";
      import { superviseTcpServerSockets } from "../src/tcp-server-sockets.ts";

      const server = createServer((socket) =>
        socket.on("data", () => socket.write("ack")),
      );
      superviseTcpServerSockets(server, (error, _socket, context) => {
        process.stdout.write(
          "warn:" + error.code + ":" + String(context.remotePort !== undefined),
        );
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const client = connect(address.port, "127.0.0.1", () => {
          client.write("hello");
        });
        client.on("data", () => client.resetAndDestroy());
        client.on("error", () => undefined);
      });
      setTimeout(() => server.close(), 100);
    `;
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: import.meta.dirname },
    );

    expect(result).toMatchObject({
      stdout: "warn:ECONNRESET:true",
      stderr: "",
    });
  });
});
