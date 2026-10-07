import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
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
    name.startsWith("scoped-route-"),
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
    name.startsWith("scoped-nested-route-"),
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
      name.startsWith("scoped-nested-route-"),
    ),
  ).toHaveLength(1);
});

it("writes provider and nested credentials under rollback-safe prefixes", async () => {
  const { directory, threads, route, hostToken } = await fixture();
  await threads.forThread(route, hostToken);
  await threads.forNested(
    { hostId: route.hostId, threadId: route.threadId },
    hostToken,
  );
  const [file] = (await fs.readdir(directory)).filter((name) =>
    name.startsWith("scoped-route-"),
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
    name.startsWith("scoped-nested-route-"),
  );
  expect(nestedFile).toBeDefined();
  expect(nestedFile?.startsWith("scoped-route-")).toBe(false);
  expect(nestedFile?.startsWith("thread-route-")).toBe(false);
  expect(nestedFile?.startsWith("nested-route-")).toBe(false);
});

it("reads legacy provider files while new provider files use a rollback-safe prefix", async () => {
  const { directory, hosts, threads, route, hostToken } = await fixture();
  const token = await threads.forThread(route, hostToken);
  const [currentName] = (await fs.readdir(directory)).filter((name) =>
    name.startsWith("scoped-route-"),
  );
  expect(currentName).toBeDefined();
  expect(currentName?.startsWith("thread-route-")).toBe(false);
  const legacyName = currentName
    ?.replace(/^scoped-route-/u, "thread-route-")
    .replace(/-v0\.json$/u, ".json");
  expect(legacyName).toBeDefined();
  await fs.rename(
    path.join(directory, currentName ?? ""),
    path.join(directory, legacyName ?? ""),
  );
  const reloaded = new ThreadTokenStore(directory, hosts);
  await reloaded.initialize([route.hostId]);
  expect(await reloaded.authenticate(token)).toEqual(route);
});

it("reads legacy nested files while new nested files use a rollback-safe prefix", async () => {
  const { directory, hosts, threads, route, hostToken } = await fixture();
  const nestedRoute = { hostId: route.hostId, threadId: route.threadId };
  const token = await threads.forNested(nestedRoute, hostToken);
  const [currentName] = (await fs.readdir(directory)).filter((name) =>
    name.startsWith("scoped-nested-route-"),
  );
  expect(currentName).toBeDefined();
  const legacyName = currentName
    ?.replace(/^scoped-nested-route-/u, "nested-route-")
    .replace(/-v0\.json$/u, ".json");
  await fs.rename(
    path.join(directory, currentName ?? ""),
    path.join(directory, legacyName ?? ""),
  );
  const reloaded = new ThreadTokenStore(directory, hosts);
  await reloaded.initialize([route.hostId]);
  expect(await reloaded.authenticateNested(token)).toEqual(nestedRoute);
});

it("removes legacy provider and nested credential files when archiving", async () => {
  const { directory, threads, route, hostToken } = await fixture();
  await threads.forThread(route, hostToken);
  await threads.forNested(
    { hostId: route.hostId, threadId: route.threadId },
    hostToken,
  );
  const names = await fs.readdir(directory);
  for (const name of names.filter((entry) =>
    entry.startsWith("scoped-route-") || entry.startsWith("scoped-nested-route-"),
  )) {
    const legacy = name
      .replace(/^scoped-route-/u, "thread-route-")
      .replace(/^scoped-nested-route-/u, "nested-route-")
      .replace(/-v0\.json$/u, ".json");
    await fs.rename(path.join(directory, name), path.join(directory, legacy));
  }
  await threads.removeThread(route.threadId);
  expect(
    (await fs.readdir(directory)).filter(
      (name) =>
        name.startsWith("thread-route-") || name.startsWith("nested-route-"),
    ),
  ).toEqual([]);
});

it("does not quarantine a legacy nested file whose host and thread split is ambiguous", async () => {
  const { directory, hosts, threads } = await fixture();
  const hostToken = await hosts.forHost("h-a");
  await hosts.forHost("h");
  await threads.forNested({ hostId: "h-a", threadId: "b" }, hostToken);
  const [currentName] = (await fs.readdir(directory)).filter((name) =>
    name.startsWith("scoped-nested-route-h-a-b-"),
  );
  const legacyName = currentName
    ?.replace(/^scoped-nested-route-/u, "nested-route-")
    .replace(/-v0\.json$/u, ".json");
  await fs.rename(
    path.join(directory, currentName ?? ""),
    path.join(directory, legacyName ?? ""),
  );
  const unreadable = new ThreadTokenStore(directory, hosts);
  const originalReadFile = fs.readFile.bind(fs);
  const readFile = vi.spyOn(fs, "readFile").mockImplementation((file, options) => {
    if (String(file) === path.join(directory, legacyName ?? ""))
      return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
    return originalReadFile(file, options);
  });
  try {
    await unreadable.initialize(["h-a", "h"]);
  } finally {
    readFile.mockRestore();
  }
  await unreadable.removeThread("a-b");
  expect(await fs.readdir(directory)).toContain(legacyName);
});

it("quarantines only the exact legacy nested thread id", async () => {
  const { directory, hosts, threads, hostToken } = await fixture();
  await threads.forNested({ hostId: "host-one", threadId: "a-b" }, hostToken);
  const [currentName] = (await fs.readdir(directory)).filter((name) =>
    name.startsWith("scoped-nested-route-host-one-a-b-"),
  );
  const legacyName = currentName
    ?.replace(/^scoped-nested-route-/u, "nested-route-")
    .replace(/-v0\.json$/u, ".json");
  await fs.rename(
    path.join(directory, currentName ?? ""),
    path.join(directory, legacyName ?? ""),
  );
  const unreadable = new ThreadTokenStore(directory, hosts);
  const originalReadFile = fs.readFile.bind(fs);
  const readFile = vi.spyOn(fs, "readFile").mockImplementation((file, options) => {
    if (String(file) === path.join(directory, legacyName ?? ""))
      return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
    return originalReadFile(file, options);
  });
  try {
    await unreadable.initialize(["host-one"]);
  } finally {
    readFile.mockRestore();
  }
  await unreadable.removeThread("a");
  expect(await fs.readdir(directory)).toContain(legacyName);
  await unreadable.removeThread("a-b");
  expect(await fs.readdir(directory)).not.toContain(legacyName);
  expect(
    (await fs.readdir(directory)).some((name) =>
      name.startsWith("revoked-route-"),
    ),
  ).toBe(true);
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
  expect(await credentialFiles("scoped-nested-route-")).toHaveLength(3);
  const lastUsedBefore = (await hosts.list()).map(
    (summary) => summary.lastUsedAt,
  );
  const withinGrace = new ThreadTokenStore(directory, hosts);
  await withinGrace.initialize([route.hostId]);
  expect(await credentialFiles("scoped-nested-route-")).toHaveLength(2);
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
  expect(await credentialFiles("scoped-route-")).toHaveLength(1);
  expect(await credentialFiles("scoped-nested-route-")).toHaveLength(1);
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

it("loads past unreadable or unrecognised credential files and discards them", async () => {
  const { directory, hosts, threads, route, hostToken } = await fixture();
  const nestedRoute = { hostId: route.hostId, threadId: route.threadId };
  const provider = await threads.forThread(route, hostToken);
  const nested = await threads.forNested(nestedRoute, hostToken);
  const [validNested] = (await fs.readdir(directory)).filter((name) =>
    name.startsWith("scoped-nested-route-"),
  );
  const newerNested = {
    ...z
      .record(z.string(), z.unknown())
      .parse(
        JSON.parse(
          await fs.readFile(path.join(directory, validNested ?? ""), "utf8"),
        ),
      ),
    addedLater: true,
  };
  const damaged = [
    ["thread-route-empty.json", ""],
    ["thread-route-garbage.json", "{not json"],
    ["thread-route-wrong-shape.json", JSON.stringify({ hostId: 7 })],
    ["nested-route-empty.json", ""],
    ["nested-route-newer.json", JSON.stringify(newerNested)],
  ] as const;
  for (const [name, content] of damaged)
    await fs.writeFile(path.join(directory, name), content);
  await fs.writeFile(path.join(directory, "account-keep.json"), "{}");
  const reloaded = new ThreadTokenStore(directory, hosts);
  await expect(reloaded.initialize([route.hostId])).resolves.toBeUndefined();
  const remaining = await fs.readdir(directory);
  for (const [name] of damaged) expect(remaining).not.toContain(name);
  expect(remaining).toContain("account-keep.json");
  expect(await reloaded.authenticate(provider)).toEqual(route);
  expect(await reloaded.authenticateNested(nested)).toEqual(nestedRoute);
});

it("starts even when a credential entry cannot be read or removed", async () => {
  const { directory, hosts, threads, route, hostToken } = await fixture();
  const nestedRoute = { hostId: route.hostId, threadId: route.threadId };
  const provider = await threads.forThread(route, hostToken);
  const nested = await threads.forNested(nestedRoute, hostToken);
  await fs.mkdir(path.join(directory, "thread-route-folder.json"));
  await fs.mkdir(path.join(directory, "nested-route-folder.json"));
  const reloaded = new ThreadTokenStore(directory, hosts);
  await expect(reloaded.initialize([route.hostId])).resolves.toBeUndefined();
  expect(await reloaded.authenticate(provider)).toEqual(route);
  expect(await reloaded.authenticateNested(nested)).toEqual(nestedRoute);
});

it.skipIf(process.getuid?.() === 0)(
  "keeps a credential file it could not read instead of deleting it",
  async () => {
    const { directory, hosts, threads, route, hostToken } = await fixture();
    const provider = await threads.forThread(route, hostToken);
    const [name] = (await fs.readdir(directory)).filter((entry) =>
      entry.startsWith("scoped-route-"),
    );
    const file = path.join(directory, name ?? "");
    await fs.chmod(file, 0o000);
    const blocked = new ThreadTokenStore(directory, hosts);
    await expect(blocked.initialize([route.hostId])).resolves.toBeUndefined();
    expect(await blocked.authenticate(provider)).toBeNull();
    await fs.chmod(file, 0o600);
    const reloaded = new ThreadTokenStore(directory, hosts);
    await reloaded.initialize([route.hostId]);
    expect(await reloaded.authenticate(provider)).toEqual(route);
  },
);

it("does not reload an unreadable credential after its thread is archived", async () => {
  const { directory, hosts, threads, route, hostToken } = await fixture();
  const token = await threads.forThread(route, hostToken);
  const [currentName] = (await fs.readdir(directory)).filter((name) =>
    name.startsWith("scoped-route-"),
  );
  const legacyName = currentName
    ?.replace(/^scoped-route-/u, "thread-route-")
    .replace(/-v0\.json$/u, ".json");
  await fs.rename(
    path.join(directory, currentName ?? ""),
    path.join(directory, legacyName ?? ""),
  );
  const unreadable = new ThreadTokenStore(directory, hosts);
  const readFile = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("EIO"));
  try {
    await unreadable.initialize([route.hostId]);
  } finally {
    readFile.mockRestore();
  }
  await unreadable.removeThread(route.threadId);
  const reloaded = new ThreadTokenStore(directory, hosts);
  await reloaded.initialize([route.hostId]);
  expect(await reloaded.authenticate(token)).toBeNull();
  expect(
    (await fs.readdir(directory)).filter((name) =>
      name.startsWith("scoped-route-") || name.startsWith("thread-route-"),
    ),
  ).toEqual([]);
});

it("keeps archive revocation across restart and restores only the current archive generation", async () => {
  const { directory, hosts, threads, route, hostToken } = await fixture();
  const token = await threads.forThread(route, hostToken);
  const staleVersion = threads.archiveVersion(route.threadId);
  await threads.removeThread(route.threadId);
  await expect(threads.forThread(route, hostToken)).rejects.toThrow(
    "Cannot mint a credential for an archived thread.",
  );
  await threads.restoreThread(route.threadId, staleVersion);
  await expect(threads.forThread(route, hostToken)).rejects.toThrow();
  const reloaded = new ThreadTokenStore(directory, hosts);
  await reloaded.initialize([route.hostId]);
  expect(await reloaded.authenticate(token)).toBeNull();
  const currentVersion = reloaded.archiveVersion(route.threadId);
  await reloaded.restoreThread(route.threadId, currentVersion);
  expect(
    await reloaded.authenticate(await reloaded.forThread(route, hostToken)),
  ).toEqual(route);
});

it("keeps an evicted token revoked after failed file cleanup and restoration", async () => {
  const { directory, threads, route, hostToken } = await fixture();
  const oldToken = await threads.forThread(route, hostToken);
  const [routeName] = (await fs.readdir(directory)).filter((name) =>
    name.startsWith("scoped-route-"),
  );
  const routeFile = path.join(directory, routeName ?? "");
  const originalRemove = fs.rm.bind(fs);
  const remove = vi.spyOn(fs, "rm").mockImplementation((file, options) => {
    if (String(file) === routeFile)
      return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
    return originalRemove(file, options);
  });
  const originalRename = fs.rename.bind(fs);
  const rename = vi.spyOn(fs, "rename").mockImplementation((from, to) => {
    if (String(from) === routeFile && String(to).includes("revoked-route-"))
      return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
    return originalRename(from, to);
  });
  try {
    await threads.removeThread(route.threadId);
  } finally {
    remove.mockRestore();
    rename.mockRestore();
  }
  expect(await fs.readdir(directory)).toContain(routeName);
  expect(await threads.authenticate(oldToken)).toBeNull();
  await threads.restoreThread(route.threadId, threads.archiveVersion(route.threadId));
  expect(await threads.authenticate(oldToken)).toBeNull();
});

it("does not persist archive markers for threads without credentials", async () => {
  const { directory, threads } = await fixture();
  await threads.removeThread("thr_empty");
  expect(
    (await fs.readdir(directory)).filter((name) =>
      name.startsWith("archived-thread-"),
    ),
  ).toEqual([]);
});

it("persists revocation when the credential directory cannot be read", async () => {
  const { directory, hosts, threads, route, hostToken } = await fixture();
  const oldToken = await threads.forThread(route, hostToken);
  const archiveOnly = new ThreadTokenStore(directory, hosts);
  expect(
    (await fs.readdir(directory)).filter((name) =>
      name.startsWith("archived-thread-"),
    ),
  ).toEqual([]);
  const readDir = vi
    .spyOn(fs, "readdir")
    .mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
  try {
    await archiveOnly.removeThread(route.threadId);
  } finally {
    readDir.mockRestore();
  }
  const markerName = (await fs.readdir(directory)).find((name) =>
    name.startsWith("archived-thread-"),
  );
  expect(markerName).toBeDefined();
  const marker = JSON.parse(
    await fs.readFile(path.join(directory, markerName ?? ""), "utf8"),
  ) as { threadId: string; epoch: number; archived: boolean };
  expect(marker).toEqual({
    threadId: route.threadId,
    epoch: 1,
    archived: true,
  });
  const reloaded = new ThreadTokenStore(directory, hosts);
  await reloaded.initialize([route.hostId]);
  expect(await reloaded.authenticate(oldToken)).toBeNull();
});

it("does not scan credential files when restoring a never-archived thread", async () => {
  const { threads } = await fixture();
  const readdir = vi.spyOn(fs, "readdir");
  await threads.restoreThread("thr_never_archived", 0);
  expect(readdir).not.toHaveBeenCalled();
  readdir.mockRestore();
});

it("recovers from a transient archive-marker read failure on active lookup", async () => {
  const { directory, hosts, threads, route, hostToken } = await fixture();
  const oldToken = await threads.forThread(route, hostToken);
  await threads.removeThread(route.threadId);
  const reloaded = new ThreadTokenStore(directory, hosts);
  const readFile = vi
    .spyOn(fs, "readFile")
    .mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }));
  try {
    await reloaded.initialize([route.hostId]);
  } finally {
    readFile.mockRestore();
  }
  await reloaded.restoreThread(
    route.threadId,
    reloaded.archiveVersion(route.threadId),
  );
  const newToken = await reloaded.forThread(route, hostToken);
  expect(newToken).not.toBe(oldToken);
  expect(await reloaded.authenticate(oldToken)).toBeNull();
});

it("preserves a credential when its archive marker has a transient read error", async () => {
  const { directory, hosts, threads, route, hostToken } = await fixture();
  const oldToken = await threads.forThread(route, hostToken);
  const [name] = (await fs.readdir(directory)).filter((entry) =>
    entry.startsWith("scoped-route-"),
  );
  const contents = await fs.readFile(path.join(directory, name ?? ""));
  await threads.removeThread(route.threadId);
  await fs.writeFile(path.join(directory, name ?? ""), contents);
  const reloaded = new ThreadTokenStore(directory, hosts);
  const originalReadFile = fs.readFile.bind(fs);
  const readFile = vi.spyOn(fs, "readFile").mockImplementation((file, options) => {
    if (String(file).includes("archived-thread-"))
      return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
    return originalReadFile(file, options);
  });
  try {
    await reloaded.initialize([route.hostId]);
  } finally {
    readFile.mockRestore();
  }
  expect(await fs.readdir(directory)).toContain(name);
  expect(await reloaded.authenticate(oldToken)).toBeNull();
  await reloaded.restoreThread(route.threadId, reloaded.archiveVersion(route.threadId));
  expect(await reloaded.authenticate(oldToken)).toBeNull();
});

it("recovers an active thread from a corrupt archive marker", async () => {
  const { directory, hosts, threads, route, hostToken } = await fixture();
  const oldToken = await threads.forThread(route, hostToken);
  await threads.removeThread(route.threadId);
  const marker = (await fs.readdir(directory)).find((name) =>
    name.startsWith("archived-thread-"),
  );
  expect(marker).toBeDefined();
  await fs.writeFile(path.join(directory, marker ?? ""), "{broken");
  const reloaded = new ThreadTokenStore(directory, hosts);
  await reloaded.initialize([route.hostId]);
  expect(await reloaded.authenticate(oldToken)).toBeNull();
  await reloaded.restoreThread(route.threadId, reloaded.archiveVersion(route.threadId));
  const newToken = await reloaded.forThread(route, hostToken);
  expect(await reloaded.authenticate(oldToken)).toBeNull();
  const afterRestart = new ThreadTokenStore(directory, hosts);
  await afterRestart.initialize([route.hostId]);
  expect(await afterRestart.authenticate(oldToken)).toBeNull();
  expect(await afterRestart.authenticate(newToken)).toEqual(route);
});

it("quarantines unreadable legacy entries and sweeps their token material", async () => {
  const { directory, hosts, threads, route, hostToken } = await fixture();
  await threads.forThread(route, hostToken);
  const [currentName] = (await fs.readdir(directory)).filter((name) =>
    name.startsWith("scoped-route-"),
  );
  const legacyName = currentName
    ?.replace(/^scoped-route-/u, "thread-route-")
    .replace(/-v0\.json$/u, ".json");
  await fs.rename(
    path.join(directory, currentName ?? ""),
    path.join(directory, legacyName ?? ""),
  );
  const unreadable = new ThreadTokenStore(directory, hosts);
  const originalReadFile = fs.readFile.bind(fs);
  const readFile = vi.spyOn(fs, "readFile").mockImplementation((file, options) => {
    if (String(file) === path.join(directory, legacyName ?? ""))
      return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
    return originalReadFile(file, options);
  });
  try {
    await unreadable.initialize([route.hostId]);
  } finally {
    readFile.mockRestore();
  }
  await unreadable.removeThread(route.threadId);
  const quarantine = (await fs.readdir(directory)).filter((name) =>
    name.startsWith("revoked-route-"),
  );
  expect(quarantine).toHaveLength(1);
  const reloaded = new ThreadTokenStore(directory, hosts);
  await reloaded.initialize([route.hostId]);
  expect(
    (await fs.readdir(directory)).some((name) =>
      name.startsWith("revoked-route-"),
    ),
  ).toBe(false);
});

it("uses a fallback archive marker when the primary marker cannot be written", async () => {
  const { directory, hosts, threads, route, hostToken } = await fixture();
  const oldToken = await threads.forThread(route, hostToken);
  const [routeName] = (await fs.readdir(directory)).filter((name) =>
    name.startsWith("scoped-route-"),
  );
  const writeFile = vi
    .spyOn(fs, "writeFile")
    .mockRejectedValueOnce(new Error("EIO"));
  const remove = vi.spyOn(fs, "rm").mockImplementationOnce(async () => {
    throw new Error("EIO");
  });
  try {
    await expect(threads.removeThread(route.threadId)).resolves.toBeUndefined();
  } finally {
    writeFile.mockRestore();
    remove.mockRestore();
  }
  expect(await threads.authenticate(oldToken)).toBeNull();
  expect((await fs.readdir(directory)).some((name) => name === routeName)).toBe(
    false,
  );
  const restoreWrite = vi
    .spyOn(fs, "writeFile")
    .mockRejectedValueOnce(new Error("EIO"));
  try {
    await expect(
      threads.restoreThread(
        route.threadId,
        threads.archiveVersion(route.threadId),
      ),
    ).rejects.toThrow("EIO");
  } finally {
    restoreWrite.mockRestore();
  }
  await expect(threads.forThread(route, hostToken)).rejects.toThrow();
  expect(await threads.authenticate(oldToken)).toBeNull();
  await threads.restoreThread(
    route.threadId,
    threads.archiveVersion(route.threadId),
  );
  const newToken = await threads.forThread(route, hostToken);
  expect(await threads.authenticate(oldToken)).toBeNull();
  const reloaded = new ThreadTokenStore(directory, hosts);
  await reloaded.initialize([route.hostId]);
  expect(await reloaded.authenticate(oldToken)).toBeNull();
  expect(await reloaded.authenticate(newToken)).toEqual(route);
  expect(
    (await fs.readdir(directory)).filter((name) =>
      name.startsWith("revoked-route-"),
    ),
  ).toEqual([]);
});

it("keeps revocation across restart when primary marker and route cleanup fail", async () => {
  const { directory, hosts, threads, route, hostToken } = await fixture();
  const oldToken = await threads.forThread(route, hostToken);
  const [routeName] = (await fs.readdir(directory)).filter((name) =>
    name.startsWith("scoped-route-"),
  );
  const routeFile = path.join(directory, routeName ?? "");
  const originalWriteFile = fs.writeFile.bind(fs);
  const writeFile = vi.spyOn(fs, "writeFile").mockImplementation((file, ...args) => {
    if (String(file).includes("archived-thread-"))
      return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
    return originalWriteFile(file, ...args);
  });
  const originalRemove = fs.rm.bind(fs);
  const remove = vi.spyOn(fs, "rm").mockImplementation((file, options) => {
    if (String(file) === routeFile)
      return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
    return originalRemove(file, options);
  });
  const originalRename = fs.rename.bind(fs);
  const rename = vi.spyOn(fs, "rename").mockImplementation((from, to) => {
    if (String(from) === routeFile && String(to).includes("revoked-route-"))
      return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" }));
    return originalRename(from, to);
  });
  try {
    await threads.removeThread(route.threadId);
  } finally {
    writeFile.mockRestore();
    remove.mockRestore();
    rename.mockRestore();
  }
  expect(await fs.readdir(directory)).toContain(routeName);
  expect(await threads.authenticate(oldToken)).toBeNull();
  expect(
    (await fs.readdir(directory)).some((name) =>
      name.startsWith("archive-revocation-"),
    ),
  ).toBe(true);

  const reloaded = new ThreadTokenStore(directory, hosts);
  await reloaded.initialize([route.hostId]);
  expect(await reloaded.authenticate(oldToken)).toBeNull();
  expect(await fs.readdir(directory)).not.toContain(routeName);
});

it("does not revive an unreadable pre-archive credential after unarchive", async () => {
  const { directory, hosts, threads, route, hostToken } = await fixture();
  const oldToken = await threads.forThread(route, hostToken);
  const unreadable = new ThreadTokenStore(directory, hosts);
  const readFile = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("EIO"));
  try {
    await unreadable.initialize([route.hostId]);
  } finally {
    readFile.mockRestore();
  }
  await unreadable.removeThread(route.threadId);
  await unreadable.restoreThread(
    route.threadId,
    unreadable.archiveVersion(route.threadId),
  );
  const reloaded = new ThreadTokenStore(directory, hosts);
  await reloaded.initialize([route.hostId]);
  expect(await reloaded.authenticate(oldToken)).toBeNull();
  const newToken = await reloaded.forThread(route, hostToken);
  expect(newToken).not.toBe(oldToken);
  expect(await reloaded.authenticate(newToken)).toEqual(route);
  const afterRestart = new ThreadTokenStore(directory, hosts);
  await afterRestart.initialize([route.hostId]);
  expect(await afterRestart.authenticate(oldToken)).toBeNull();
  expect(await afterRestart.authenticate(newToken)).toEqual(route);
});

it("mints even when an expired-generation record cannot be removed", async () => {
  const { directory, hosts, threads, route, hostToken, advance } =
    await fixture();
  await threads.forThread(route, hostToken);
  await threads.forNested(
    { hostId: route.hostId, threadId: route.threadId },
    hostToken,
  );
  const stale = (await fs.readdir(directory)).filter(
    (entry) =>
      entry.startsWith("scoped-route-") ||
      entry.startsWith("thread-route-") ||
      entry.startsWith("scoped-nested-route-"),
  );
  expect(stale).toHaveLength(2);
  await hosts.rotate(route.hostId);
  const nextHostToken = await hosts.forHost(route.hostId);
  advance(10 * 60_000 + 1);
  for (const entry of stale) {
    await fs.rm(path.join(directory, entry));
    await fs.mkdir(path.join(directory, entry));
  }
  const current = await threads.forThread(route, nextHostToken);
  expect(await threads.authenticate(current)).toEqual(route);
});

it("keeps routes apart when identifiers contain the separator", async () => {
  const { directory, hosts, threads } = await fixture();
  const first = { hostId: "host-a", threadId: "b-c" };
  const second = { hostId: "host-a-b", threadId: "c" };
  const firstNested = await threads.forNested(
    first,
    await hosts.forHost(first.hostId),
  );
  const secondNested = await threads.forNested(
    second,
    await hosts.forHost(second.hostId),
  );
  expect(firstNested).not.toBe(secondNested);
  expect(await threads.authenticateNested(firstNested)).toEqual(first);
  expect(await threads.authenticateNested(secondNested)).toEqual(second);
  expect(
    (await fs.readdir(directory)).filter((name) =>
      name.startsWith("scoped-nested-route-"),
    ),
  ).toHaveLength(2);
  await threads.removeThread("c");
  expect(await threads.authenticateNested(secondNested)).toBeNull();
  expect(await threads.authenticateNested(firstNested)).toEqual(first);
});

it("reclaims expired-generation credentials for a thread when minting, and keeps live ones", async () => {
  const { directory, hosts, threads, route, hostToken, advance } =
    await fixture();
  const nestedRoute = { hostId: route.hostId, threadId: route.threadId };
  const otherNested = { hostId: route.hostId, threadId: "thr_two" };
  await threads.forThread(route, hostToken);
  await threads.forNested(nestedRoute, hostToken);
  await threads.forNested(otherNested, hostToken);
  await hosts.rotate(route.hostId);
  const nextHostToken = await hosts.forHost(route.hostId);
  const credentialFiles = async (prefix: string) =>
    (await fs.readdir(directory)).filter((name) => name.startsWith(prefix));
  await threads.forNested(nestedRoute, nextHostToken);
  expect(await credentialFiles("scoped-nested-route-")).toHaveLength(3);
  expect(await credentialFiles("scoped-route-")).toHaveLength(1);
  advance(10 * 60_000 + 1);
  const current = await threads.forThread(route, nextHostToken);
  expect(await credentialFiles("scoped-route-")).toHaveLength(1);
  expect(await credentialFiles("scoped-nested-route-")).toHaveLength(2);
  expect(await threads.authenticate(current)).toEqual(route);
  const reloaded = new ThreadTokenStore(directory, hosts);
  await reloaded.initialize([route.hostId]);
  expect(await credentialFiles("scoped-route-")).toHaveLength(1);
  expect(await credentialFiles("scoped-nested-route-")).toHaveLength(1);
  await hosts.rotate(route.hostId);
  const thirdHostToken = await hosts.forHost(route.hostId);
  advance(10 * 60_000 + 1);
  const nextNested = await threads.forNested(nestedRoute, thirdHostToken);
  expect(await credentialFiles("scoped-route-")).toHaveLength(0);
  expect(await credentialFiles("scoped-nested-route-")).toHaveLength(1);
  expect(await threads.authenticateNested(nextNested)).toEqual(nestedRoute);
});
