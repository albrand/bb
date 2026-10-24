import { spawn } from "node:child_process";

const SCRIPT = [
  "import ctypes, os, sys, time",
  "if os.fork():",
  "    os._exit(0)",
  "os.setsid()",
  "if os.fork():",
  "    os._exit(0)",
  "libc = ctypes.CDLL(None)",
  "libc.prctl(4, 0, 0, 0, 0)",
  "libc.prctl(15, b'unlisted-agent', 0, 0, 0)",
  "sys.stdout.write(str(os.getpid()) + chr(10))",
  "sys.stdout.flush()",
  "os.close(1)",
  "time.sleep(900)",
].join("\n");

export async function startUnreadableProcess(): Promise<number | null> {
  if (process.platform !== "linux" || process.getuid?.() === 0) {
    return null;
  }
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", SCRIPT], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.once("error", () => resolve(null));
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const pid = Number(output.trim());
      if (output.includes("\n") && Number.isInteger(pid) && pid > 0) {
        resolve(pid);
      }
    });
    child.once("close", () => resolve(null));
  });
}

export function stopUnreadableProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
}
