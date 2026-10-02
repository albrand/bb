import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertElectronRuntime } from "../scripts/assert-electron-runtime.mjs";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("assertElectronRuntime", () => {
  it("rejects a truncated macOS Electron Framework before launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-electron-runtime-"));
    tempDirs.push(root);
    const executable = join(root, "Electron.app/Contents/MacOS/Electron");
    const framework = join(
      root,
      "Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
    );
    await mkdir(join(root, "Electron.app/Contents/MacOS"), {
      recursive: true,
    });
    await mkdir(join(framework, ".."), { recursive: true });
    await writeFile(executable, Buffer.alloc(33_968));
    await writeFile(framework, Buffer.alloc(4096));

    expect(() =>
      assertElectronRuntime(executable, { platform: "darwin" }),
    ).toThrow(/Electron Framework is truncated \(4096 bytes/);
  });
});
