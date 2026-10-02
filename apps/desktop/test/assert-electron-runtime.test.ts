import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertElectronRuntime } from "../scripts/assert-electron-runtime.mjs";

const tempDirs: string[] = [];

async function createMacRuntimeFixture(
  executableName = "Electron",
  frameworkName = `${executableName} Framework`,
) {
  const root = await mkdtemp(join(tmpdir(), "bb-electron-runtime-"));
  tempDirs.push(root);
  const executable = join(
    root,
    `${executableName}.app/Contents/MacOS/${executableName}`,
  );
  const framework = join(
    root,
    `${executableName}.app/Contents/Frameworks/${frameworkName}.framework/Versions/A/${frameworkName}`,
  );
  await mkdir(join(root, `${executableName}.app/Contents/MacOS`), {
    recursive: true,
  });
  await mkdir(join(framework, ".."), { recursive: true });
  await writeFile(executable, Buffer.alloc(33_968));
  await writeFile(framework, Buffer.alloc(0));
  return { executable, framework, root };
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("assertElectronRuntime", () => {
  it("rejects a truncated macOS Electron Framework before launch", async () => {
    const { executable, framework } = await createMacRuntimeFixture();
    await writeFile(framework, Buffer.alloc(4096));

    expect(() =>
      assertElectronRuntime(executable, { platform: "darwin" }),
    ).toThrow(/Electron framework is truncated \(4096 bytes/);
  });

  it("rejects a missing macOS Electron Framework", async () => {
    const { executable, framework } = await createMacRuntimeFixture();
    await rm(framework);

    expect(() =>
      assertElectronRuntime(executable, { platform: "darwin" }),
    ).toThrow(/Electron runtime is missing its framework binary/);
  });

  it("rejects a truncated macOS Electron launcher", async () => {
    const { executable } = await createMacRuntimeFixture();
    await writeFile(executable, Buffer.alloc(4096));

    expect(() =>
      assertElectronRuntime(executable, { platform: "darwin" }),
    ).toThrow(/Electron runtime executable is truncated \(4096 bytes/);
  });

  it("accepts a macOS framework above the measured size floor", async () => {
    const { executable, framework } = await createMacRuntimeFixture();
    await truncate(framework, 190_000_000);

    expect(() =>
      assertElectronRuntime(executable, { platform: "darwin" }),
    ).not.toThrow();
  });

  it("accepts the renamed framework binary in a packaged macOS app", async () => {
    const { executable, framework } = await createMacRuntimeFixture("bb");
    await truncate(framework, 190_000_000);

    expect(() =>
      assertElectronRuntime(executable, { platform: "darwin" }),
    ).not.toThrow();
  });

  it("accepts Electron Framework in a packaged macOS app", async () => {
    const { executable, framework } = await createMacRuntimeFixture(
      "bb",
      "Electron Framework",
    );
    await truncate(framework, 190_000_000);

    expect(() =>
      assertElectronRuntime(executable, { platform: "darwin" }),
    ).not.toThrow();
  });

  it("validates the standalone executable layout on Linux", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-electron-runtime-"));
    tempDirs.push(root);
    const executable = join(root, "electron");
    await writeFile(executable, Buffer.alloc(1024 * 1024));

    expect(() =>
      assertElectronRuntime(executable, { platform: "linux" }),
    ).not.toThrow();
  });
});
