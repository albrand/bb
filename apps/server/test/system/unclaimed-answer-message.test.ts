import { describe, expect, it } from "vitest";
import { buildUnclaimedAnswerMessage } from "../../src/services/interactions/unclaimed-answer-message.js";

const payload = {
  kind: "plugin",
  title: "3 questions",
  data: {
    questions: [
      {
        id: "q0",
        prompt: "How should tabular screens use the viewport?",
        options: [
          { value: "q0o0", label: "1/A inner area" },
          { value: "q0o1", label: "1/B full page" },
        ],
      },
      {
        id: "q1",
        prompt: "How many sessions?",
        options: [{ value: "q1o0", label: "3/A twelve" }],
      },
    ],
  },
};

describe("buildUnclaimedAnswerMessage", () => {
  it("names each question and the option label the user picked", () => {
    const message = buildUnclaimedAnswerMessage(payload, {
      answers: { q0: ["q0o0"], q1: ["q1o0"] },
    });
    expect(message).toContain("had already timed out");
    expect(message).toContain("How should tabular screens use the viewport? — 1/A inner area");
    expect(message).toContain("How many sessions? — 3/A twelve");
  });

  it("keeps an unknown option value rather than dropping the answer", () => {
    const message = buildUnclaimedAnswerMessage(payload, {
      answers: { q0: ["typed something else"] },
    });
    expect(message).toContain("typed something else");
  });

  it("returns null when nothing was actually answered", () => {
    expect(buildUnclaimedAnswerMessage(payload, { answers: {} })).toBeNull();
    expect(buildUnclaimedAnswerMessage(payload, {})).toBeNull();
    expect(buildUnclaimedAnswerMessage({}, { answers: { q0: ["x"] } })).toBeNull();
  });
});
