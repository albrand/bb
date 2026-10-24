import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform === "linux") {
  const preload = pathToFileURL(
    fileURLToPath(new URL("./helpers/own-processes-only.mjs", import.meta.url)),
  ).href;
  const flag = `--import=${preload}`;
  const current = process.env.NODE_OPTIONS ?? "";
  if (!current.includes(flag)) {
    process.env.PROCESS_VIEW_ROOT_PID = String(process.pid);
    process.env.NODE_OPTIONS = current === "" ? flag : `${current} ${flag}`;
    await import(preload);
  }
}
