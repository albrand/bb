import fs, { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const unreadablePid = Number(process.env.UNREADABLE_PROCESS_PID);
const applies =
  process.platform === "linux" &&
  process.getuid?.() !== 0 &&
  process.env.UNREADABLE_PROCESS_PID !== undefined;

describe.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
  "the process table of the integration tests",
  () => {
    it("has a same-user process that this user cannot inspect, started by the global setup", async () => {
      expect(applies).toBe(true);
      expect(Number.isInteger(unreadablePid) && unreadablePid > 0).toBe(true);
      await expect(
        fs.readlink(`/proc/${unreadablePid}/cwd`),
      ).rejects.toMatchObject({ code: "EACCES" });
      expect(
        await fs.readFile(`/proc/${unreadablePid}/status`, "utf8"),
      ).toMatch(/^Name:\tunlisted-agent$/mu);
    });

    it("lists only the processes below the test worker, however the listing is imported", async () => {
      expect(await fs.readdir("/proc")).not.toContain(String(unreadablePid));
      expect(await readdir("/proc")).not.toContain(String(unreadablePid));
      expect(await readdir("/proc")).toContain(String(process.pid));
    });
  },
);
