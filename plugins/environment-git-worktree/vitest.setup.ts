import { beforeAll } from "vitest";
import { descendantsOnly } from "./host/descendants-only.js";
import { hostProc, useProcReaderForTests } from "./host/holders.js";

beforeAll(() => {
  useProcReaderForTests(descendantsOnly(hostProc, process.pid));
});
