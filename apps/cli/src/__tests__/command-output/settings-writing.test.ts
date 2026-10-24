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

  it("sends a remove to the server and reports its refusal when a term is missing", async () => {
    const post = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: "invalid_request",
            message: "Not in the vocabulary: Hermes. Nothing was changed.",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    );
    stubServerApi({ "v1.writing-assistance.vocabulary.$post": post });

    await expect(
      runCommand(
        [
          "settings",
          "writing",
          "vocabulary",
          "remove",
          "refreshToken",
          "Hermes",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(post).toHaveBeenCalledWith({
      json: { add: [], remove: ["refreshToken", "Hermes"], ifMissing: "fail" },
    });
    expect(console.error).toHaveBeenCalledWith(
      "Error: HTTP 409: Not in the vocabulary: Hermes. Nothing was changed.",
    );
  });

  it("removes a padded term through one server edit and prints the settings as JSON", async () => {
    const post = vi.fn(async () => writingView(["bb"]));
    stubServerApi({ "v1.writing-assistance.vocabulary.$post": post });

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
    expect(post).toHaveBeenCalledWith({
      json: { add: [], remove: ["refreshToken"], ifMissing: "fail" },
    });
    expect(
      JSON.parse(collectLogPayloads(vi.mocked(console.log))[0] ?? "null"),
    ).toMatchObject({ settings: { vocabulary: ["bb"] } });
  });

  it("adds terms through one server edit without reading the list first", async () => {
    const get = vi.fn(async () => writingView(["bb"]));
    const post = vi.fn(async () => writingView(["bb", "Hermes"]));
    stubServerApi({
      "v1.writing-assistance.$get": get,
      "v1.writing-assistance.vocabulary.$post": post,
    });

    await runCommand(
      ["settings", "writing", "vocabulary", "add", " Hermes ", "bb", " "],
      register,
    );
    expect(get).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith({
      json: { add: ["Hermes", "bb"], remove: [], ifMissing: "fail" },
    });
  });
});
