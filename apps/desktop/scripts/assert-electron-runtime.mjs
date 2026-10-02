import { existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MINIMUM_MACOS_EXECUTABLE_BYTES = 16 * 1024;
const MINIMUM_EXECUTABLE_BYTES = 1024 * 1024;
const MINIMUM_MACOS_FRAMEWORK_BYTES = 128 * 1024 * 1024;

export function assertElectronRuntime(
  executablePath,
  { platform = process.platform } = {},
) {
  const binary = resolve(executablePath);
  let binarySize;
  try {
    binarySize = statSync(binary).size;
  } catch {
    throw new Error(`Electron runtime is missing its executable: ${binary}`);
  }
  const minimumExecutableBytes =
    platform === "darwin"
      ? MINIMUM_MACOS_EXECUTABLE_BYTES
      : MINIMUM_EXECUTABLE_BYTES;
  if (binarySize < minimumExecutableBytes) {
    throw new Error(
      `Electron runtime executable is truncated (${binarySize} bytes; expected at least ${minimumExecutableBytes}): ${binary}`,
    );
  }

  if (platform !== "darwin") return;

  const appBundle = resolve(dirname(binary), "..", "..");
  const frameworkNames = [
    `${basename(binary)} Framework`,
    "Electron Framework",
  ];
  const frameworkPaths = frameworkNames.map((frameworkName) =>
    resolve(
      appBundle,
      `Contents/Frameworks/${frameworkName}.framework/Versions/A/${frameworkName}`,
    ),
  );
  const framework =
    frameworkPaths.find((path) => existsSync(path)) ?? frameworkPaths[0];
  let frameworkSize;
  try {
    frameworkSize = statSync(framework).size;
  } catch {
    throw new Error(
      `Electron runtime is missing its framework binary: ${frameworkPaths.join(" or ")}`,
    );
  }
  if (frameworkSize < MINIMUM_MACOS_FRAMEWORK_BYTES) {
    throw new Error(
      `Electron framework is truncated (${frameworkSize} bytes; expected at least ${MINIMUM_MACOS_FRAMEWORK_BYTES}): ${framework}. Reinstall Electron with pnpm rebuild electron or rebuild the packaged app.`,
    );
  }
}

const scriptPath = fileURLToPath(import.meta.url);
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(scriptPath)
) {
  try {
    const electronExecutable = createRequire(import.meta.url)("electron");
    assertElectronRuntime(electronExecutable);
    process.stdout.write(`Electron runtime is valid: ${electronExecutable}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
