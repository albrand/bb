import { describe, expect, it, vi } from "vitest";
import type { WritingAssistanceView } from "@bb/domain";
import {
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerSettingsCommands } from "../../commands/settings.js";

function writingView(vocabulary: string[]): WritingAssistanceView {
  return {
    settings: {
      mode: "prompt",
      typingCorrection: "automatic",
      dictationFormatting: true,
      vocabulary,
      dailyCorrectionLimit: 300,
      dailyDictationMinutes: 60,
    },
    usage: {
      day: "2026-10-16",
      corrections: 0,
      formattings: 0,
      dictationSegments: 0,
      audioSeconds: 0,
      inputChars: 0,
      outputChars: 0,
      estimatedCostMicros: 0,
    },
    correctionAvailable: true,
  };
}

describe("bb settings writing vocabulary", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerSettingsCommands(program, () => "http://server");

  it("fails without writing when a term to remove is not in the vocabulary", async () => {
    const put = vi.fn(async () => writingView(["bb"]));
    stubServerApi({
      "v1.writing-assistance.$get": vi.fn(async () =>
        writingView(["bb", "refreshToken"]),
      ),
      "v1.writing-assistance.settings.$put": put,
    });

    await expect(
      runCommand(
        [
          "settings",
          "writing",
          "vocabulary",
          "remove",
          "refreshToken",
          "Hermes",
          "--json",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(
      collectLogPayloads(vi.mocked(console.log)).map((line) =>
        JSON.parse(line),
      ),
    ).toEqual([
      {
        ok: false,
        error: {
          code: "error",
          message: "Not in the vocabulary: Hermes. Nothing was removed.",
        },
      },
    ]);
    expect(put).not.toHaveBeenCalled();
  });

  it("removes a padded term and prints the updated settings as JSON", async () => {
    const put = vi.fn(async () => writingView(["bb"]));
    stubServerApi({
      "v1.writing-assistance.$get": vi.fn(async () =>
        writingView(["bb", "refreshToken"]),
      ),
      "v1.writing-assistance.settings.$put": put,
    });

    await runCommand(
      [
        "settings",
        "writing",
        "vocabulary",
        "remove",
        " refreshToken ",
        "--json",
      ],
      register,
    );
    expect(put).toHaveBeenCalledWith({ json: { vocabulary: ["bb"] } });
    expect(
      JSON.parse(collectLogPayloads(vi.mocked(console.log))[0] ?? "null"),
    ).toMatchObject({ settings: { vocabulary: ["bb"] } });
  });
});
