import {
  type PendingInteractionUserAnswer,
  type UserQuestionPendingInteractionPayload,
  userQuestionPendingInteractionPayloadSchema,
} from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  MCP_ELICITATION_MAX_ATTEMPTS,
  type McpElicitationRequest,
  runMcpElicitation,
} from "./mcp-elicitation.js";

type Answers = Record<string, PendingInteractionUserAnswer>;

function scriptedAsk(replies: Array<Answers | Error | unknown>) {
  const payloads: UserQuestionPendingInteractionPayload[] = [];
  const ask = async (
    payload: UserQuestionPendingInteractionPayload,
  ): Promise<unknown> => {
    payloads.push(userQuestionPendingInteractionPayloadSchema.parse(payload));
    const reply = replies[payloads.length - 1];
    if (reply instanceof Error) {
      throw reply;
    }
    if (reply !== null && typeof reply === "object" && !("kind" in reply)) {
      return { kind: "user_answer", answers: reply };
    }
    return reply;
  };
  return { ask, payloads };
}

function form(
  properties: Record<string, unknown>,
  required: string[] = Object.keys(properties),
): McpElicitationRequest {
  return {
    serverName: "tickets",
    message: "Fill in the ticket.",
    mode: "form",
    requestedSchema: { type: "object", properties, required },
  };
}

const COLOR = form({
  color: { type: "string", title: "Color", enum: ["red", "green", "blue"] },
});

const SHIPPING = form({
  name: { type: "string", title: "Recipient", minLength: 2 },
  quantity: { type: "integer", title: "Quantity", minimum: 1, maximum: 10 },
  gift: { type: "boolean", title: "Gift wrap" },
  speed: {
    type: "string",
    title: "Speed",
    oneOf: [
      { const: "std", title: "Standard" },
      { const: "exp", title: "Express" },
    ],
  },
});

const SHIPPING_ANSWERS: Answers = {
  "field-1": { selected: [], freeText: "Ada" },
  "field-2": { selected: [], freeText: "2" },
  "field-3": { selected: ["field-3:option-1"] },
  "field-4": { selected: ["field-4:option-2"] },
};

describe("runMcpElicitation", () => {
  it("shows a single choice as a question card and returns the chosen enum value", async () => {
    const { ask, payloads } = scriptedAsk([
      { "field-1": { selected: ["field-1:option-3"] } },
    ]);

    const result = await runMcpElicitation({ request: COLOR, ask });

    expect(result).toEqual({ action: "accept", content: { color: "blue" } });
    expect(payloads).toEqual([
      {
        kind: "user_question",
        questions: [
          {
            id: "field-1",
            prompt: "The tickets MCP server asks: Fill in the ticket. Color",
            shortLabel: "Color",
            multiSelect: false,
            options: [
              { value: "field-1:option-1", label: "red" },
              { value: "field-1:option-2", label: "green" },
              { value: "field-1:option-3", label: "blue" },
            ],
            allowFreeText: false,
          },
        ],
      },
    ]);
  });

  it("returns typed text, integer, boolean, and titled-choice values", async () => {
    const { ask, payloads } = scriptedAsk([SHIPPING_ANSWERS]);

    const result = await runMcpElicitation({ request: SHIPPING, ask });

    expect(result).toEqual({
      action: "accept",
      content: { name: "Ada", quantity: 2, gift: true, speed: "exp" },
    });
    const questions = payloads[0]!.questions;
    expect(questions.map((question) => question.allowFreeText)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(questions[1]!.prompt).toBe("Quantity (a whole number from 1 to 10)");
    expect(questions[2]!.options).toEqual([
      { value: "field-3:option-1", label: "Yes" },
      { value: "field-3:option-2", label: "No" },
    ]);
    expect(questions[3]!.options?.map((option) => option.label)).toEqual([
      "Standard",
      "Express",
    ]);
  });

  it.each([
    ["a comma decimal", "1,5"],
    ["hexadecimal", "0x5"],
    ["infinity", "Infinity"],
    ["an overflowing exponent", "1e400"],
    ["a fraction for an integer", "2.5"],
    ["a value above the maximum", "11"],
    ["a value below the minimum", "0"],
    ["trailing words", "2 boxes"],
  ])("asks again when the number is %s", async (_label, entry) => {
    const { ask, payloads } = scriptedAsk([
      { ...SHIPPING_ANSWERS, "field-2": { selected: [], freeText: entry } },
      SHIPPING_ANSWERS,
    ]);

    const result = await runMcpElicitation({ request: SHIPPING, ask });

    expect(result).toEqual({
      action: "accept",
      content: { name: "Ada", quantity: 2, gift: true, speed: "exp" },
    });
    expect(payloads).toHaveLength(2);
    expect(payloads[1]!.questions[1]!.prompt).toBe(
      "Quantity (a whole number from 1 to 10) Quantity must be a whole number from 1 to 10.",
    );
    expect(payloads[1]!.questions[0]!.prompt).toBe(
      payloads[0]!.questions[0]!.prompt,
    );
  });

  it("accepts decimals and exponents for a number field", async () => {
    const request = form({ ratio: { type: "number", title: "Ratio" } });
    for (const [entry, value] of [
      ["0.5", 0.5],
      ["-3", -3],
      ["1e3", 1000],
      [".25", 0.25],
    ] as const) {
      const { ask } = scriptedAsk([
        { "field-1": { selected: [], freeText: entry } },
      ]);
      expect(await runMcpElicitation({ request, ask })).toEqual({
        action: "accept",
        content: { ratio: value },
      });
    }
  });

  it("cancels after the answers stay invalid for every attempt", async () => {
    const invalid = {
      ...SHIPPING_ANSWERS,
      "field-1": { selected: [], freeText: "A" },
    };
    const { ask, payloads } = scriptedAsk([invalid, invalid, invalid, invalid]);

    const result = await runMcpElicitation({ request: SHIPPING, ask });

    expect(result.action).toBe("cancel");
    expect(payloads).toHaveLength(MCP_ELICITATION_MAX_ATTEMPTS);
    expect(payloads[2]!.questions[0]!.prompt).toContain(
      "Recipient needs at least 2 characters.",
    );
  });

  it("keeps __proto__ and constructor field names as plain content keys", async () => {
    const request: McpElicitationRequest = {
      serverName: "tickets",
      message: "Fill in the ticket.",
      requestedSchema: JSON.parse(
        '{"type":"object","properties":{"__proto__":{"type":"string","title":"Proto"},"constructor":{"type":"boolean","title":"Ctor"}},"required":["__proto__","constructor"]}',
      ),
    };
    const { ask, payloads } = scriptedAsk([
      {
        "field-1": { selected: [], freeText: "polluted?" },
        "field-2": { selected: ["field-2:option-2"] },
      },
    ]);

    const result = await runMcpElicitation({ request, ask });

    expect(
      payloads[0]!.questions.map((question) => question.shortLabel),
    ).toEqual(["Proto", "Ctor"]);
    if (result.action !== "accept") {
      throw new Error(`expected accept, got ${result.action}`);
    }
    expect(Object.getPrototypeOf(result.content)).toBe(Object.prototype);
    expect(Object.keys(result.content)).toEqual(["__proto__", "constructor"]);
    expect(JSON.parse(JSON.stringify(result.content))).toEqual(
      JSON.parse('{"__proto__":"polluted?","constructor":false}'),
    );
    expect(({} as Record<string, unknown>)["polluted?"]).toBeUndefined();
  });

  it("offers Skip for an optional field and leaves a skipped field out", async () => {
    const request = form(
      {
        title: { type: "string", title: "Title" },
        urgent: { type: "boolean", title: "Urgent" },
        notes: { type: "string", title: "Notes" },
      },
      ["title"],
    );
    const { ask, payloads } = scriptedAsk([
      {
        "field-1": { selected: [], freeText: "Printer jam" },
        "field-2": { selected: ["field-2:skip"] },
        "field-3": { selected: [], freeText: "Floor 3" },
      },
    ]);

    const result = await runMcpElicitation({ request, ask });

    expect(result).toEqual({
      action: "accept",
      content: { title: "Printer jam", notes: "Floor 3" },
    });
    const [title, urgent, notes] = payloads[0]!.questions;
    expect(title!.options).toBeUndefined();
    expect(urgent!.options?.map((option) => option.label)).toEqual([
      "Yes",
      "No",
      "Skip",
    ]);
    expect(notes!.options).toEqual([{ value: "field-3:skip", label: "Skip" }]);
    expect(notes!.allowFreeText).toBe(true);
  });

  it("asks again when Skip is combined with an answer", async () => {
    const request = form(
      {
        tags: {
          type: "array",
          title: "Tags",
          items: { type: "string", enum: ["a", "b"] },
        },
      },
      [],
    );
    const { ask, payloads } = scriptedAsk([
      { "field-1": { selected: ["field-1:option-1", "field-1:skip"] } },
      { "field-1": { selected: ["field-1:skip"] } },
    ]);

    expect(await runMcpElicitation({ request, ask })).toEqual({
      action: "accept",
      content: {},
    });
    expect(payloads[1]!.questions[0]!.prompt).toContain(
      "Choose Skip on its own for Tags.",
    );
  });

  it("has no Skip when an optional choice already has four options", async () => {
    const request = form(
      { size: { type: "string", enum: ["xs", "s", "m", "l"] } },
      [],
    );
    const { ask, payloads } = scriptedAsk([
      { "field-1": { selected: ["field-1:skip"] } },
      { "field-1": { selected: ["field-1:option-4"] } },
    ]);

    expect(await runMcpElicitation({ request, ask })).toEqual({
      action: "accept",
      content: { size: "l" },
    });
    expect(payloads[0]!.questions[0]!.options).toHaveLength(4);
    expect(payloads[0]!.questions[0]!.shortLabel).toBe("size");
  });

  it("returns multi-select values in option order limits and checks item counts", async () => {
    const request = form({
      days: {
        type: "array",
        title: "Days",
        minItems: 2,
        items: {
          anyOf: [
            { const: "mon", title: "Monday" },
            { const: "tue", title: "Tuesday" },
            { const: "wed", title: "Wednesday" },
          ],
        },
      },
    });
    const { ask, payloads } = scriptedAsk([
      { "field-1": { selected: ["field-1:option-2"] } },
      { "field-1": { selected: ["field-1:option-3", "field-1:option-1"] } },
    ]);

    expect(await runMcpElicitation({ request, ask })).toEqual({
      action: "accept",
      content: { days: ["wed", "mon"] },
    });
    expect(payloads[0]!.questions[0]!.multiSelect).toBe(true);
    expect(payloads[1]!.questions[0]!.prompt).toContain(
      "Choose at least 2 for Days.",
    );
  });

  it("uses legacy enumNames as labels", async () => {
    const request = form({
      plan: { type: "string", enum: ["p1", "p2"], enumNames: ["Basic", "Pro"] },
    });
    const { ask, payloads } = scriptedAsk([
      { "field-1": { selected: ["field-1:option-2"] } },
    ]);

    expect(await runMcpElicitation({ request, ask })).toEqual({
      action: "accept",
      content: { plan: "p2" },
    });
    expect(
      payloads[0]!.questions[0]!.options?.map((option) => option.label),
    ).toEqual(["Basic", "Pro"]);
  });

  it.each([
    ["email", "not-an-email", "someone@example.com"],
    ["uri", "example dot com", "https://example.com/a"],
    ["date", "2026-02-30", "2026-02-28"],
    ["date-time", "2026-09-30 10:00", "2026-09-30T10:00:00Z"],
  ])("checks the %s format", async (format, invalid, valid) => {
    const request = form({ value: { type: "string", format } });
    const { ask, payloads } = scriptedAsk([
      { "field-1": { selected: [], freeText: invalid } },
      { "field-1": { selected: [], freeText: valid } },
    ]);

    expect(await runMcpElicitation({ request, ask })).toEqual({
      action: "accept",
      content: { value: valid },
    });
    expect(payloads).toHaveLength(2);
  });

  it("enforces maxLength in characters, not UTF-16 units", async () => {
    const request = form({ code: { type: "string", maxLength: 2 } });
    const { ask, payloads } = scriptedAsk([
      { "field-1": { selected: [], freeText: "😀😀😀" } },
      { "field-1": { selected: [], freeText: "😀😀" } },
    ]);

    expect(await runMcpElicitation({ request, ask })).toEqual({
      action: "accept",
      content: { code: "😀😀" },
    });
    expect(payloads).toHaveLength(2);
  });

  it("asks to continue or decline when the form has no fields", async () => {
    const request = form({});
    const accepted = scriptedAsk([
      { confirm: { selected: ["confirm:accept"] } },
    ]);
    const declined = scriptedAsk([
      { confirm: { selected: ["confirm:decline"] } },
    ]);

    expect(await runMcpElicitation({ request, ask: accepted.ask })).toEqual({
      action: "accept",
      content: {},
    });
    expect(accepted.payloads[0]!.questions[0]!.options).toEqual([
      { value: "confirm:accept", label: "Continue" },
      { value: "confirm:decline", label: "Decline" },
    ]);
    expect(
      (await runMcpElicitation({ request, ask: declined.ask })).action,
    ).toBe("decline");
  });

  it.each<[string, McpElicitationRequest]>([
    ["a URL elicitation", { ...COLOR, mode: "url" }],
    ["an openai/form elicitation", { ...COLOR, mode: "openai/form" }],
    [
      "more than four fields",
      form({
        a: { type: "boolean" },
        b: { type: "boolean" },
        c: { type: "boolean" },
        d: { type: "boolean" },
        e: { type: "boolean" },
      }),
    ],
    [
      "more than four choices",
      form({ x: { type: "string", enum: ["1", "2", "3", "4", "5"] } }),
    ],
    ["a nested object", form({ x: { type: "object", properties: {} } })],
    [
      "a required field that is not defined",
      form({ x: { type: "boolean" } }, ["y"]),
    ],
    ["a non-string enum", form({ x: { type: "string", enum: [1, 2] } })],
    ["an unsupported format", form({ x: { type: "string", format: "ipv4" } })],
    ["duplicate choices", form({ x: { type: "string", enum: ["a", "a"] } })],
    ["a missing schema", { serverName: "tickets", message: "Hi" }],
    ["a blank message", { ...COLOR, message: "  " }],
  ])("declines %s without asking", async (_label, request) => {
    const { ask, payloads } = scriptedAsk([]);

    const result = await runMcpElicitation({ request, ask });

    expect(result.action).toBe("decline");
    expect(payloads).toHaveLength(0);
  });

  it("cancels when the question is cancelled, answered with the wrong shape, or already aborted", async () => {
    const rejected = scriptedAsk([new Error("thread stopped")]);
    expect(
      await runMcpElicitation({ request: COLOR, ask: rejected.ask }),
    ).toEqual({ action: "cancel", reason: "thread stopped" });

    const wrongShape = scriptedAsk([{ kind: "approval", decision: "allow" }]);
    expect(
      (await runMcpElicitation({ request: COLOR, ask: wrongShape.ask })).action,
    ).toBe("cancel");

    const controller = new AbortController();
    controller.abort();
    const aborted = scriptedAsk([]);
    expect(
      (
        await runMcpElicitation({
          request: COLOR,
          ask: aborted.ask,
          signal: controller.signal,
        })
      ).action,
    ).toBe("cancel");
    expect(aborted.payloads).toHaveLength(0);
  });
});
