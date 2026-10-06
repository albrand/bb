import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { HubTokenStore } from "./store.js";
import { ThreadTokenStore } from "./thread-tokens.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "bb-thread-token-"));
  directories.push(directory);
  let now = 1_000_000;
  const hosts = new HubTokenStore(directory, () => now);
  await hosts.initialize();
  const threads = new ThreadTokenStore(directory, hosts);
  await threads.initialize(["host-one"]);
  const route = {
    hostId: "host-one",
    threadId: "thr_one",
    provider: "claude" as const,
    accountId: null,
  };
  const hostToken = await hosts.forHost(route.hostId);
  return {
    directory,
    hosts,
    threads,
    route,
    hostToken,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

it("binds credentials to a thread, provider, and account snapshot and removes them on deletion", async () => {
  const { directory, threads, route, hostToken } = await fixture();
  const [first, same] = await Promise.all([
    threads.forThread(route, hostToken),
    threads.forThread(route, hostToken),
  ]);
  expect(first === same).toBe(true);
  const selected = {
    ...route,
    accountId: "11111111-1111-4111-8111-111111111111",
  };
  const second = await threads.forThread(selected, hostToken);
  expect(second === first).toBe(false);
  expect(await threads.authenticate(first, "codex")).toBeNull();
  expect(await threads.authenticate(second, "claude")).toEqual(selected);
  expect(await threads.authenticate(first, "claude")).toEqual(route);
  for (const file of (await fs.readdir(directory)).filter((name) =>
    name.startsWith("thread-route-"),
  )) {
    expect((await fs.stat(path.join(directory, file))).mode & 0o777).toBe(
      0o600,
    );
  }
  await threads.removeThread(route.threadId);
  expect(await threads.authenticate(first)).toBeNull();
  expect(await threads.authenticate(second)).toBeNull();
});

it("issues nested credentials per thread, apart from provider credentials", async () => {
  const { directory, threads, route, hostToken } = await fixture();
  const nestedRoute = { hostId: route.hostId, threadId: route.threadId };
  const [first, same] = await Promise.all([
    threads.forNested(nestedRoute, hostToken),
    threads.forNested(nestedRoute, hostToken),
  ]);
  expect(first).toBe(same);
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  const other = await threads.forNested(
    { ...nestedRoute, threadId: "thr_two" },
    hostToken,
  );
  expect(other).not.toBe(first);
  const provider = await threads.forThread(route, hostToken);
  expect(await threads.authenticateNested(first)).toEqual(nestedRoute);
  expect(await threads.authenticateNested(provider)).toBeNull();
  expect(await threads.authenticate(first)).toBeNull();
  expect(await threads.authenticateNested(hostToken)).toBeNull();
  expect(await threads.authenticateNested(null)).toBeNull();
  expect(await threads.authenticateNested("A".repeat(43))).toBeNull();
  const files = (await fs.readdir(directory)).filter((name) =>
    name.startsWith("nested-route-"),
  );
  expect(files).toHaveLength(2);
  for (const file of files) {
    expect((await fs.stat(path.join(directory, file))).mode & 0o777).toBe(
      0o600,
    );
  }
  await threads.removeThread(route.threadId);
  expect(await threads.authenticateNested(first)).toBeNull();
  expect(await threads.authenticate(provider)).toBeNull();
  expect(await threads.authenticateNested(other)).toEqual({
    ...nestedRoute,
    threadId: "thr_two",
  });
  expect(
    (await fs.readdir(directory)).filter((name) =>
      name.startsWith("nested-route-"),
    ),
  ).toHaveLength(1);
});

it("keeps the stored provider credential format readable by builds without nested credentials", async () => {
  const { directory, threads, route, hostToken } = await fixture();
  await threads.forThread(route, hostToken);
  await threads.forNested(
    { hostId: route.hostId, threadId: route.threadId },
    hostToken,
  );
  const [file] = (await fs.readdir(directory)).filter((name) =>
    name.startsWith("thread-route-"),
  );
  const record: unknown = JSON.parse(
    await fs.readFile(path.join(directory, file ?? ""), "utf8"),
  );
  expect(
    Object.keys(z.record(z.string(), z.unknown()).parse(record)).sort(),
  ).toEqual([
    "accountId",
    "hostId",
    "hostTokenDigest",
    "provider",
    "threadId",
    "token",
  ]);
  const nestedFile = (await fs.readdir(directory)).find((name) =>
    name.startsWith("nested-route-"),
  );
  expect(nestedFile).toBeDefined();
  expect(nestedFile?.startsWith("thread-route-")).toBe(false);
});

it("sweeps dead and unenrolled credentials on startup and leaves other secrets alone", async () => {
  const { directory, hosts, threads, route, hostToken, advance } =
    await fixture();
  const nestedRoute = { hostId: route.hostId, threadId: route.threadId };
  const staleProvider = await threads.forThread(route, hostToken);
  const staleNested = await threads.forNested(nestedRoute, hostToken);
  const goneHostToken = await hosts.forHost("host-gone");
  await threads.forNested(
    { hostId: "host-gone", threadId: route.threadId },
    goneHostToken,
  );
  await hosts.rotate(route.hostId);
  const currentHostToken = await hosts.forHost(route.hostId);
  const currentProvider = await threads.forThread(route, currentHostToken);
  const currentNested = await threads.forNested(nestedRoute, currentHostToken);
  await fs.writeFile(path.join(directory, "account-keep.json"), "{}");
  const credentialFiles = async (prefix: string) =>
    (await fs.readdir(directory)).filter((name) => name.startsWith(prefix));
  expect(await credentialFiles("nested-route-")).toHaveLength(3);
  const lastUsedBefore = (await hosts.list()).map(
    (summary) => summary.lastUsedAt,
  );
  const withinGrace = new ThreadTokenStore(directory, hosts);
  await withinGrace.initialize([route.hostId]);
  expect(await credentialFiles("nested-route-")).toHaveLength(2);
  expect((await hosts.list()).map((summary) => summary.lastUsedAt)).toEqual(
    lastUsedBefore,
  );
  expect(await withinGrace.authenticate(staleProvider)).toEqual(route);
  expect(await withinGrace.authenticateNested(staleNested)).toEqual(
    nestedRoute,
  );
  advance(10 * 60_000 + 1);
  const reloaded = new ThreadTokenStore(directory, hosts);
  await reloaded.initialize([route.hostId]);
  expect(await reloaded.authenticate(staleProvider)).toBeNull();
  expect(await reloaded.authenticateNested(staleNested)).toBeNull();
  expect(await reloaded.authenticate(currentProvider)).toEqual(route);
  expect(await reloaded.authenticateNested(currentNested)).toEqual(nestedRoute);
  expect(await credentialFiles("thread-route-")).toHaveLength(1);
  expect(await credentialFiles("nested-route-")).toHaveLength(1);
  expect(await credentialFiles("account-keep")).toHaveLength(1);
  expect(await credentialFiles("hub-token-")).toHaveLength(2);
});

it("preserves machine rotation grace and revokes expired or unenrolled credentials after reload", async () => {
  const { directory, hosts, threads, route, hostToken, advance } =
    await fixture();
  const old = await threads.forThread(route, hostToken);
  await hosts.rotate(route.hostId);
  const current = await threads.forThread(
    route,
    await hosts.forHost(route.hostId),
  );
  expect(await threads.authenticate(old)).toEqual(route);
  advance(10 * 60_000 + 1);
  const reloaded = new ThreadTokenStore(directory, hosts);
  await reloaded.initialize([route.hostId]);
  expect(await reloaded.authenticate(old)).toBeNull();
  expect(await reloaded.authenticate(current)).toEqual(route);
  await hosts.prune([]);
  expect(await reloaded.authenticate(current)).toBeNull();
});
