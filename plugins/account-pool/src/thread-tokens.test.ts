import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
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
