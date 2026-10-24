import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  writeSync,
} from "node:fs";
import path from "node:path";

const nextNumbers = new Map<string, number>();

function nameOf(sequence: number): string {
  return String(sequence).padStart(12, "0");
}

function highestNumber(directory: string): number {
  let highest = 0;
  for (const name of readdirSync(directory)) {
    if (!/^\d{12}$/u.test(name)) continue;
    const value = Number(name);
    if (value > highest) highest = value;
  }
  return highest;
}

function startingNumber(directory: string): number {
  const cached = nextNumbers.get(directory);
  if (cached === undefined) return highestNumber(directory) + 1;
  const previous = path.join(directory, nameOf(cached - 1));
  return existsSync(previous) ? cached : highestNumber(directory) + 1;
}

function isExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

export function publishHooks(directory: string, jsonl: string): void {
  mkdirSync(directory, { recursive: true });
  for (const line of jsonl.split("\n")) {
    if (line.trim().length === 0) continue;
    let next = startingNumber(directory);
    let descriptor: number | undefined;
    while (descriptor === undefined) {
      const file = path.join(directory, nameOf(next));
      try {
        descriptor = openSync(file, "wx", 0o600);
      } catch (error) {
        if (!isExists(error)) throw error;
        next = highestNumber(directory) + 1;
      }
    }
    try {
      writeSync(descriptor, line);
    } finally {
      closeSync(descriptor);
    }
    nextNumbers.set(directory, next + 1);
  }
}
