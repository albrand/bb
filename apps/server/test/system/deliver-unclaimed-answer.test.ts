import { describe, expect, it } from "vitest";
import { planUnclaimedAnswerDelivery } from "../../src/services/interactions/deliver-unclaimed-answer.js";

const interaction = {
  threadId: "thr_late",
  payload: {
    kind: "plugin",
    title: "1 question",
    data: {
      questions: [
        {
          id: "q0",
          prompt: "Which layout?",
          options: [{ value: "q0o0", label: "Inner area" }],
        },
      ],
    },
  },
} as never;

describe("planUnclaimedAnswerDelivery", () => {
  it("targets the thread that asked, with the answer in the text", () => {
    const delivery = planUnclaimedAnswerDelivery({
      interaction,
      value: { answers: { q0: ["q0o0"] } },
    });
    expect(delivery?.threadId).toBe("thr_late");
    expect(delivery?.text).toContain("Which layout? — Inner area");
    expect(delivery?.text).toContain("Continue from these.");
  });

  it("plans nothing when the user answered nothing", () => {
    expect(
      planUnclaimedAnswerDelivery({ interaction, value: { answers: {} } }),
    ).toBeNull();
  });
});
