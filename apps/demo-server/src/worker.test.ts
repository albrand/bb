import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pluginListResponseSchema,
  sidebarBootstrapResponseSchema,
  systemAppUpdateStatusSchema,
  threadTimelineResponseSchema,
} from "@bb/server-contract";
import { PROVIDERS } from "./fixtures/providers.js";
import { afterAll, beforeAll, expect, it } from "vitest";

let worker: ChildProcess;
let origin: string;
let stateDirectory: string;
let output = "";

beforeAll(async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Expected a TCP address"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
  origin = `http://127.0.0.1:${port}`;
  stateDirectory = await mkdtemp(join(tmpdir(), "bb-demo-worker-"));
  worker = spawn(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "dev",
      "--local",
      "--port",
      String(port),
      "--persist-to",
      stateDirectory,
    ],
    { env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  worker.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  worker.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/health`)).ok) return;
    } catch {
      if (worker.exitCode !== null) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Demo worker did not start: ${output}`);
}, 40_000);

afterAll(async () => {
  if (worker && worker.exitCode === null) {
    const closed = new Promise<void>((resolve) =>
      worker.once("exit", () => resolve()),
    );
    worker.kill("SIGTERM");
    await closed;
  }
  if (stateDirectory)
    await rm(stateDirectory, { recursive: true, force: true });
});

it("serves the shell, deep links, and its JavaScript and styles", async () => {
  const response = await fetch(origin);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  const html = await response.text();
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/gu)];
  expect(assets.length).toBeGreaterThan(1);
  for (const [, path] of assets) {
    const asset = await fetch(new URL(path, origin));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).not.toContain("text/html");
    expect((await asset.text()).length).toBeGreaterThan(0);
  }
  const deepLink = await fetch(
    `${origin}/projects/proj_demo00000001/threads/thr_demo00000001`,
    {
      headers: { "sec-fetch-mode": "navigate" },
    },
  );
  expect(await deepLink.text()).toBe(html);
  expect((await fetch(origin, { method: "HEAD" })).status).toBe(200);
});

it("serves the sidebar plugin frontends and sample conversation in current contract shape", async () => {
  const [catalogResponse, bootstrapResponse] = await Promise.all([
    fetch(`${origin}/api/v1/plugins`),
    fetch(`${origin}/api/v1/sidebar-bootstrap`),
  ]);
  const catalog = pluginListResponseSchema.parse(await catalogResponse.json());
  const bootstrap = sidebarBootstrapResponseSchema.parse(
    await bootstrapResponse.json(),
  );
  expect(catalog.plugins.map((plugin) => plugin.id)).toEqual([
    "navigation",
    "thread-list",
  ]);
  const pluginAssetPaths = catalog.plugins.flatMap((plugin) => {
    const bundle = plugin.app.bundle;
    if (bundle === null) throw new Error("Missing sidebar frontend");
    if (bundle.jsUrl === null || bundle.cssUrl === null)
      throw new Error("Missing sidebar asset URL");
    return [bundle.jsUrl, bundle.cssUrl];
  });
  const providerLogoPaths = PROVIDERS.map((provider) => {
    if (provider.logoUrl === null)
      throw new Error("Missing demo provider logo URL");
    return provider.logoUrl;
  });
  const [pluginAssets, providerLogos] = await Promise.all([
    Promise.all(pluginAssetPaths.map((path) => fetch(new URL(path, origin)))),
    Promise.all(providerLogoPaths.map((path) => fetch(new URL(path, origin)))),
  ]);
  for (const asset of pluginAssets) {
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).not.toContain("text/html");
  }
  for (const logo of providerLogos) {
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toContain("image/svg+xml");
    expect(await logo.text()).toContain("<svg");
  }
  expect(bootstrap.projects[0].threads).toHaveLength(3);
  const thread = bootstrap.projects[0].threads[0];
  const [timelineResponse, rpcResponse, updateStatusResponse] =
    await Promise.all([
      fetch(`${origin}/api/v1/threads/${thread.id}/timeline`),
      fetch(`${origin}/api/v1/plugins/thread-list/rpc/listPreferences`, {
        method: "POST",
        body: "null",
        headers: { "content-type": "application/json" },
      }),
      fetch(`${origin}/api/v1/system/app-update`),
    ]);
  const timeline = threadTimelineResponseSchema.parse(
    await timelineResponse.json(),
  );
  expect(
    timeline.rows.some(
      (row) => row.kind === "conversation" && row.role === "assistant",
    ),
  ).toBe(true);
  expect(await rpcResponse.json()).toEqual({
    ok: true,
    result: { preferences: {} },
  });
  systemAppUpdateStatusSchema.parse(await updateStatusResponse.json());
});

it("keeps unsupported API and mutation requests out of the SPA fallback", async () => {
  for (const [path, method] of [
    ["/api/v1/not-a-route", "GET"],
    ["/api/v1/threads", "POST"],
    ["/", "POST"],
  ]) {
    const response = await fetch(new URL(path, origin), {
      method,
      headers: { "sec-fetch-mode": "navigate" },
    });
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      error: { code: "not_implemented" },
    });
  }
  expect((await fetch(`${origin}/ws`)).status).toBe(426);
});

it("isolates automatic sidebar preference writes by client and validates revisions and values", async () => {
  const key = "sidebar.collapsedThreads";
  const firstClient = {
    "cf-connecting-ip": "192.0.2.1",
    "content-type": "application/json",
  };
  const secondClient = { "cf-connecting-ip": "192.0.2.2" };
  const preferencesUrl = `${origin}/api/v1/preferences/ui`;
  const initial = await (
    await fetch(preferencesUrl, { headers: firstClient })
  ).json();
  expect(initial).toMatchObject({
    preferences: { [key]: { revision: 0, value: [] } },
  });
  const write = (expectedRevision: number, value: unknown) =>
    fetch(`${preferencesUrl}/${key}`, {
      method: "PUT",
      headers: firstClient,
      body: JSON.stringify({ expectedRevision, value }),
    });
  const changed = await write(0, ["thr_demo00000001"]);
  expect(changed.status).toBe(200);
  expect(await changed.json()).toEqual({
    key,
    revision: 1,
    value: ["thr_demo00000001"],
  });
  const own = await (
    await fetch(preferencesUrl, { headers: firstClient })
  ).json();
  expect(own).toMatchObject({
    preferences: { [key]: { revision: 1, value: ["thr_demo00000001"] } },
  });
  const other = await (
    await fetch(preferencesUrl, { headers: secondClient })
  ).json();
  expect(other).toMatchObject({
    preferences: { [key]: { revision: 0, value: [] } },
  });
  expect((await write(0, [])).status).toBe(409);
  expect((await write(1, "invalid")).status).toBe(400);
});
