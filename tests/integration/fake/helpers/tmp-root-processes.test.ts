import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HARNESS_TMP_ROOT_PREFIX,
  integrationTmpBase,
} from "../../helpers/tmp-base.js";
import {
  assertHarnessTmpRoot,
  killProcessesHoldingFilesUnder,
} from "../../helpers/tmp-root-processes.js";

describe("killing processes under a harness temp root", () => {
  it("accepts only a harness-created root directly under the temp base", () => {
    const root = path.join(
      integrationTmpBase(),
      `${HARNESS_TMP_ROOT_PREFIX}abc123`,
    );
    expect(assertHarnessTmpRoot(`${root}/`)).toBe(root);
  });

  it.each([
    ["/", "/"],
    ["the temp base", integrationTmpBase()],
    ["the home directory", homedir()],
    [
      "the bare prefix",
      path.join(integrationTmpBase(), HARNESS_TMP_ROOT_PREFIX),
    ],
    [
      "another temp directory",
      path.join(integrationTmpBase(), "something-else"),
    ],
    [
      "a nested path",
      path.join(
        integrationTmpBase(),
        `${HARNESS_TMP_ROOT_PREFIX}abc`,
        "daemon-data",
      ),
    ],
    [
      "a path that climbs out",
      path.join(
        integrationTmpBase(),
        `${HARNESS_TMP_ROOT_PREFIX}abc`,
        "..",
        "..",
      ),
    ],
    [
      "the home directory's lookalike",
      path.join(homedir(), `${HARNESS_TMP_ROOT_PREFIX}abc`),
    ],
  ])("refuses %s before looking for processes", async (_label, root) => {
    await expect(
      killProcessesHoldingFilesUnder(root, { exclude: [] }),
    ).rejects.toThrow("not a harness temp root");
  });
});
