import { describe, expect, it } from "vitest";
import { describeThreadStorageRefusal } from "./thread-storage-refusal.js";

describe("describeThreadStorageRefusal", () => {
  it("names the processes by id and drops every path the host reported", () => {
    const reason = describeThreadStorageRefusal(
      "Refusing to delete thread storage /data/thread-storage/thr_x: 2 processes are still working inside it (pid 4242 in /data/thread-storage/thr_x/app/secrets; pid 17 in /data/thread-storage/thr_x). Nothing was stopped and nothing was removed.",
    );

    expect(reason).toContain("processes are still working inside it");
    expect(reason).toContain("pid 4242, pid 17");
    expect(reason).toContain("about every ten seconds");
    expect(reason).not.toContain("/");
    expect(reason).not.toContain("secrets");
  });

  it("says so when the host could not establish whether a process is inside, without the host's detail", () => {
    const reason = describeThreadStorageRefusal(
      'Refusing to delete thread storage /data/thread-storage/thr_x: whether a process is still working inside it could not be established (1 processes could not be inspected, such as process 1899 mount namespace (EACCES), named "/usr/bin/tool --token=abc"). Nothing was stopped and nothing was removed.',
    );

    expect(reason).toContain("could not be established (pid 1899)");
    expect(reason).not.toContain("token");
    expect(reason).not.toContain("/usr");
    expect(reason).not.toContain("EACCES");
  });

  it("names at most five processes and each one once", () => {
    const reason = describeThreadStorageRefusal(
      `Refusing to delete thread storage /x: 7 processes are still working inside it (${[1, 2, 3, 4, 5, 6, 7, 1].map((id) => `pid ${id} in /x`).join("; ")}).`,
    );

    expect(reason).toContain("(pid 1, pid 2, pid 3, pid 4, pid 5)");
    expect(reason).not.toContain("pid 6");
  });
});
