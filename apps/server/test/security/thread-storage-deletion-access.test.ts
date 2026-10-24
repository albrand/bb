import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  seedHost,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import {
  startTestServer,
  type RunningTestServer,
} from "../helpers/test-app.js";

let server: RunningTestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

interface RawResponse {
  body: string;
  status: number;
}

function rawGet(
  baseUrl: string,
  headers: Record<string, string>,
  path: string,
): Promise<RawResponse> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: response.statusCode ?? 0,
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function seedThreads(running: RunningTestServer) {
  const host = seedHost(running, { id: "host-access" });
  const { project } = seedProjectWithSource(running, { hostId: host.id });
  const live = seedThread(running, { projectId: project.id });
  const deleted = seedThread(running, { projectId: project.id });
  running.db.$client
    .prepare(
      "UPDATE threads SET deleted_at = ?, storage_delete_refusal = ? WHERE id = ?",
    )
    .run(Date.now(), "Refusing to delete thread storage: pid 4242", deleted.id);
  return { deleted, live };
}

describe("GET /api/v1/threads/:id/storage-deletion", () => {
  it("is refused to a caller that reaches the server under a non-loopback host or origin, exactly as its sibling thread route is", async () => {
    server = await startTestServer();
    const { deleted, live } = seedThreads(server);
    const port = new URL(server.baseUrl).port;
    const attacker = `attacker.example:${port}`;
    const routes = [
      `/api/v1/threads/${deleted.id}/storage-deletion`,
      `/api/v1/threads/${live.id}/child-summary`,
    ];

    for (const path of routes) {
      const hostileHeaders: Record<string, string>[] = [
        { host: attacker },
        { host: attacker, origin: `http://${attacker}` },
        { host: `127.0.0.1:${port}`, origin: "https://attacker.example" },
        {
          host: `127.0.0.1:${port}`,
          origin: "https://attacker.example",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "https",
        },
      ];
      for (const headers of hostileHeaders) {
        const refused = await rawGet(server.baseUrl, headers, path);
        expect(refused.status, `${path} ${JSON.stringify(headers)}`).toBe(403);
        expect(refused.body).not.toContain("Refusing to delete");
        expect(refused.body).not.toContain("pid 4242");
      }
    }
  });

  it("answers a caller the server accepts, with the recorded state and nothing else", async () => {
    server = await startTestServer();
    const { deleted, live } = seedThreads(server);
    const port = new URL(server.baseUrl).port;

    const acceptedHeaders: Record<string, string>[] = [
      { host: `127.0.0.1:${port}` },
      { host: `localhost:${port}`, origin: `http://localhost:${port}` },
    ];
    for (const headers of acceptedHeaders) {
      const answered = await rawGet(
        server.baseUrl,
        headers,
        `/api/v1/threads/${deleted.id}/storage-deletion`,
      );
      expect(answered.status).toBe(200);
      expect(JSON.parse(answered.body)).toEqual({
        deletedAt: expect.any(Number),
        keptReason: "Refusing to delete thread storage: pid 4242",
      });
      const sibling = await rawGet(
        server.baseUrl,
        headers,
        `/api/v1/threads/${live.id}/child-summary`,
      );
      expect(sibling.status).toBe(200);
    }
    const unknown = await rawGet(
      server.baseUrl,
      { host: `127.0.0.1:${port}` },
      "/api/v1/threads/thr_does_not_exist/storage-deletion",
    );
    expect(unknown.status).toBe(404);
  });
});
