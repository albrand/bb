import { describe, expect, it } from "vitest";

import {
  buildCodexInteractiveResponse,
  buildCodexUserInputResponse,
  codexUserInputQuestionIds,
  decodeCodexInteractiveRequest,
  extractCodexMacOsPermissionRequest,
} from "./interactive-requests.js";
import { ProviderRequestDecodeError } from "@get-bb/plugin-sdk/provider-bridge";

describe("decodeCodexInteractiveRequest", () => {
  it("maps command approval requests into pending interaction payloads", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 8,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [
            {
              type: "unknown",
              command: "git push",
            },
          ],
          additionalPermissions: {
            network: { enabled: true },
            fileSystem: null,
            macos: null,
          },
          availableDecisions: ["accept", "acceptForSession", "decline"],
        },
      }),
    ).toEqual({
      requestId: 8,
      method: "item/commandExecution/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-1",
      payload: {
        kind: "approval",
        subject: {
          kind: "command",
          itemId: "item-1",
          command: "git push",
          cwd: "/tmp/project",
          actions: [
            {
              type: "unknown",
              command: "git push",
            },
          ],
          sessionGrant: {
            network: { enabled: true },
            fileSystem: null,
          },
        },
        reason: "Needs approval",
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
    });
  });

  it("omits command session approval without session grants", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 80,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          availableDecisions: ["accept", "acceptForSession", "decline"],
        },
      }),
    ).toEqual({
      requestId: 80,
      method: "item/commandExecution/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-1",
      payload: {
        kind: "approval",
        subject: {
          kind: "command",
          itemId: "item-1",
          command: "git push",
          cwd: "/tmp/project",
          actions: [],
          sessionGrant: null,
        },
        reason: "Needs approval",
        availableDecisions: ["allow_once", "deny"],
      },
    });
  });

  it("rejects empty command approval decisions as invalid params", () => {
    expect(() =>
      decodeCodexInteractiveRequest({
        id: 8,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          availableDecisions: [],
        },
      }),
    ).toThrowError(ProviderRequestDecodeError);
  });

  it("maps cancel-only command approval decisions to deny", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 8,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          availableDecisions: ["cancel"],
        },
      }),
    ).toMatchObject({
      payload: {
        availableDecisions: ["deny"],
      },
    });
  });

  it("keeps a command approval that asks for macOS permissions and surfaces the profile beside it", () => {
    const request = {
      id: 8,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "item-1",
        reason: "Needs approval",
        command: "osascript -e 'tell app \"Finder\" to activate'",
        cwd: "/tmp/project",
        commandActions: [],
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: null,
          macos: {
            preferences: "read_only",
            automations: {
              bundle_ids: ["com.apple.finder"],
            },
            launchServices: true,
            accessibility: true,
            calendar: false,
            reminders: false,
            contacts: "none",
          },
        },
        availableDecisions: ["accept", "acceptForSession", "decline"],
      },
    };

    const decoded = decodeCodexInteractiveRequest(request);
    expect(decoded?.payload).toMatchObject({
      kind: "approval",
      subject: {
        kind: "command",
        itemId: "item-1",
        sessionGrant: { network: { enabled: true }, fileSystem: null },
      },
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    });

    expect(extractCodexMacOsPermissionRequest(request)).toEqual({
      providerThreadId: "t1",
      turnId: "turn-1",
      item: {
        approvalItemId: "item-1",
        reason: "Needs approval",
        permissions: {
          preferences: "read_only",
          automations: { kind: "bundle_ids", bundleIds: ["com.apple.finder"] },
          launchServices: true,
          accessibility: true,
          calendar: false,
          reminders: false,
          contacts: "none",
        },
      },
    });
  });

  it("extracts no macOS profile from approvals that carry none", () => {
    expect(
      extractCodexMacOsPermissionRequest({
        id: 81,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: null,
          command: "open -a Finder",
          cwd: "/tmp/project",
          commandActions: [],
          additionalPermissions: { network: null, fileSystem: null },
          availableDecisions: ["accept", "decline"],
        },
      }),
    ).toBeNull();
    expect(
      extractCodexMacOsPermissionRequest({
        id: 82,
        method: "item/permissions/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: null,
          permissions: { network: { enabled: true }, fileSystem: null },
        },
      }),
    ).toBeNull();
  });

  it("ignores unsupported policy-amendment decisions when simple decisions remain", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 9,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-2",
          itemId: "item-2",
          reason: "Needs approval",
          command: "git push",
          cwd: "/tmp/project",
          commandActions: [],
          additionalPermissions: null,
          availableDecisions: [
            {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: ["allow", "git", "push"],
              },
            },
            {
              applyNetworkPolicyAmendment: {
                network_policy_amendment: {
                  host: "api.openai.com",
                  action: "allow",
                },
              },
            },
            "decline",
          ],
        },
      }),
    ).toMatchObject({
      payload: {
        kind: "approval",
        subject: {
          kind: "command",
          command: "git push",
        },
        availableDecisions: ["deny"],
      },
    });
  });

  it("rejects policy-amendment-only command approval decisions", () => {
    expect(() =>
      decodeCodexInteractiveRequest({
        id: 90,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-network-amendment",
          itemId: "item-network-amendment",
          reason: "Needs network policy approval",
          command: "curl https://api.openai.com",
          cwd: "/tmp/project",
          commandActions: [],
          additionalPermissions: null,
          availableDecisions: [
            {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: ["allow", "git", "push"],
              },
            },
            {
              applyNetworkPolicyAmendment: {
                network_policy_amendment: {
                  host: "api.openai.com",
                  action: "allow",
                },
              },
            },
          ],
        },
      }),
    ).toThrowError(ProviderRequestDecodeError);
  });

  it("preserves deny when policy amendments are paired with cancel", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 91,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-network-amendment-deny",
          itemId: "item-network-amendment-deny",
          reason: "Needs network policy approval",
          command: "curl https://api.openai.com",
          cwd: "/tmp/project",
          commandActions: [],
          additionalPermissions: null,
          availableDecisions: [
            {
              applyNetworkPolicyAmendment: {
                network_policy_amendment: {
                  host: "api.openai.com",
                  action: "allow",
                },
              },
            },
            "cancel",
          ],
        },
      }),
    ).toMatchObject({
      payload: {
        availableDecisions: ["deny"],
      },
    });
  });

  it("maps file-change approvals into pending interactions", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 10,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-file-change",
          itemId: "item-file-change",
          reason: "Review generated file changes",
          grantRoot: "/tmp/project",
        },
      }),
    ).toEqual({
      requestId: 10,
      method: "item/fileChange/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-file-change",
      payload: {
        kind: "approval",
        subject: {
          kind: "file_change",
          itemId: "item-file-change",
          writeScope: "/tmp/project",
          sessionGrant: {
            network: null,
            fileSystem: {
              read: [],
              write: ["/tmp/project"],
            },
          },
        },
        reason: "Review generated file changes",
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
    });
  });

  it("omits file-change session approval without grant root", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 11,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-file-change",
          itemId: "item-file-change",
          reason: "Review generated file changes",
          grantRoot: null,
        },
      }),
    ).toEqual({
      requestId: 11,
      method: "item/fileChange/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-file-change",
      payload: {
        kind: "approval",
        subject: {
          kind: "file_change",
          itemId: "item-file-change",
          writeScope: null,
          sessionGrant: null,
        },
        reason: "Review generated file changes",
        availableDecisions: ["allow_once", "deny"],
      },
    });
  });

  it("maps permission approvals into pending interactions", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 11,
        method: "item/permissions/requestApproval",
        params: {
          threadId: "t1",
          turnId: "turn-permissions",
          itemId: "item-permissions",
          reason: "Need network access",
          permissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/tmp/project/README.md"],
              write: [],
            },
          },
        },
      }),
    ).toEqual({
      requestId: 11,
      method: "item/permissions/requestApproval",
      providerThreadId: "t1",
      turnId: "turn-permissions",
      payload: {
        kind: "approval",
        subject: {
          kind: "permission_grant",
          itemId: "item-permissions",
          toolName: null,
          permissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/tmp/project/README.md"],
              write: [],
            },
          },
        },
        reason: "Need network access",
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
    });
  });

  it("maps blocking Codex user input into a durable user-question interaction", () => {
    expect(
      decodeCodexInteractiveRequest({
        id: 12,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "t1",
          turnId: "turn-user-input",
          itemId: "item-user-input",
          questions: [
            {
              id: "deployment",
              header: "Deployment",
              question:
                "Which deployment path should we use? Include the context before deciding.",
              isOther: true,
              isSecret: false,
              options: [
                {
                  label: "Staging",
                  description: "Validate before production.",
                },
                {
                  label: "Production",
                  description: "Run the approved release.",
                },
              ],
            },
          ],
          isBlocking: true,
          autoResolutionMs: null,
        },
      }),
    ).toEqual({
      requestId: 12,
      method: "item/tool/requestUserInput",
      providerThreadId: "t1",
      turnId: "turn-user-input",
      payload: {
        kind: "user_question",
        questions: [
          {
            id: "deployment",
            prompt:
              "Which deployment path should we use? Include the context before deciding.",
            shortLabel: "Deployment",
            multiSelect: false,
            options: [
              {
                value: "deployment:option-1",
                label: "Staging",
                description: "Validate before production.",
              },
              {
                value: "deployment:option-2",
                label: "Production",
                description: "Run the approved release.",
              },
            ],
            allowFreeText: true,
          },
        ],
      },
    });
  });

  it("rejects secret Codex user input instead of rendering it in the BB form", () => {
    expect(() =>
      decodeCodexInteractiveRequest({
        id: 13,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "t1",
          turnId: "turn-secret-input",
          itemId: "item-secret-input",
          questions: [
            {
              id: "token",
              header: "Token",
              question: "Enter the token",
              isOther: true,
              isSecret: true,
              options: null,
            },
          ],
          isBlocking: true,
          autoResolutionMs: 300_000,
        },
      }),
    ).toThrowError(ProviderRequestDecodeError);
  });
});

describe("buildCodexInteractiveResponse", () => {
  it("maps bb command approvals back to Codex responses", () => {
    expect(
      buildCodexInteractiveResponse({
        payload: {
          kind: "approval",
          subject: {
            kind: "command",
            itemId: "item-1",
            command: "git push",
            cwd: "/tmp/project",
            actions: [],
            sessionGrant: null,
          },
          reason: null,
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: null,
        },
      }),
    ).toEqual({
      decision: "acceptForSession",
    });
  });

  it("maps command denial back to Codex responses", () => {
    expect(
      buildCodexInteractiveResponse({
        payload: {
          kind: "approval",
          subject: {
            kind: "command",
            itemId: "item-3",
            command: "git push",
            cwd: "/tmp/project",
            actions: [],
            sessionGrant: null,
          },
          reason: null,
          availableDecisions: ["allow_once", "deny"],
        },
        resolution: {
          decision: "deny",
        },
      }),
    ).toEqual({
      decision: "decline",
    });
  });

  it("maps file-change approvals back to Codex responses", () => {
    expect(
      buildCodexInteractiveResponse({
        payload: {
          kind: "approval",
          subject: {
            kind: "file_change",
            itemId: "item-file-change",
            writeScope: null,
            sessionGrant: null,
          },
          reason: "Review generated file changes",
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: null,
        },
      }),
    ).toEqual({
      decision: "acceptForSession",
    });
  });

  it("maps permission grants back to Codex responses", () => {
    expect(
      buildCodexInteractiveResponse({
        payload: {
          kind: "approval",
          subject: {
            kind: "permission_grant",
            itemId: "item-permissions",
            toolName: null,
            permissions: {
              network: { enabled: true },
              fileSystem: {
                read: ["/tmp/project/README.md"],
                write: [],
              },
            },
          },
          reason: "Need network access",
          availableDecisions: ["allow_once", "allow_for_session", "deny"],
        },
        resolution: {
          decision: "allow_for_session",
          grantedPermissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/tmp/project/README.md"],
              write: [],
            },
          },
        },
      }),
    ).toEqual({
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: ["/tmp/project/README.md"],
          write: null,
        },
      },
      scope: "session",
    });
  });

  it("maps a user-question answer back to Codex option labels and free text", () => {
    expect(
      buildCodexInteractiveResponse({
        payload: {
          kind: "user_question",
          questions: [
            {
              id: "deployment",
              prompt: "Which deployment path should we use?",
              shortLabel: "Deployment",
              multiSelect: true,
              options: [
                {
                  value: "deployment:option-1",
                  label: "Staging",
                  description: "Validate before production.",
                },
                {
                  value: "deployment:option-2",
                  label: "Production",
                  description: "Run the approved release.",
                },
              ],
              allowFreeText: true,
            },
          ],
        },
        resolution: {
          kind: "user_answer",
          answers: {
            deployment: {
              selected: ["deployment:option-2"],
              freeText: "Use the audited release window.",
            },
          },
        },
      }),
    ).toEqual({
      answers: {
        deployment: {
          answers: ["Production", "Use the audited release window."],
        },
      },
    });
  });
});

function userInputRequest(questions: unknown[]) {
  return {
    id: 21,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "t1",
      turnId: "turn-1",
      itemId: "call-1",
      questions,
      isBlocking: true,
      autoResolutionMs: null,
    },
  };
}

const COLOR_QUESTION = {
  id: "color",
  header: "Color",
  question: "Which color should the button use?",
  isOther: true,
  isSecret: false,
  options: [
    { label: "Blue (Recommended)", description: "Matches the brand." },
    { label: "Green", description: "" },
  ],
};

describe("Codex requestUserInput", () => {
  it("shows the questions as a bb question card", () => {
    expect(
      decodeCodexInteractiveRequest(
        userInputRequest([
          COLOR_QUESTION,
          {
            id: "name",
            header: "",
            question: "What should the component be called?",
            isOther: false,
            isSecret: false,
            options: null,
          },
        ]),
      ),
    ).toEqual({
      requestId: 21,
      method: "item/tool/requestUserInput",
      providerThreadId: "t1",
      turnId: "turn-1",
      payload: {
        kind: "user_question",
        questions: [
          {
            id: "question-1",
            prompt: "Which color should the button use?",
            shortLabel: "Color",
            multiSelect: false,
            options: [
              {
                value: "question-1:option-1",
                label: "Blue (Recommended)",
                description: "Matches the brand.",
              },
              { value: "question-1:option-2", label: "Green" },
            ],
            allowFreeText: true,
          },
          {
            id: "question-2",
            prompt: "What should the component be called?",
            multiSelect: false,
            allowFreeText: true,
          },
        ],
      },
    });
  });

  it("declines a question that asks for a secret", () => {
    expect(() =>
      decodeCodexInteractiveRequest(
        userInputRequest([{ ...COLOR_QUESTION, isSecret: true }]),
      ),
    ).toThrow(/does not collect secret answers/);
  });

  it.each([
    ["no questions", []],
    [
      "five questions",
      ["a", "b", "c", "d", "e"].map((id) => ({ ...COLOR_QUESTION, id })),
    ],
    ["duplicate ids", [COLOR_QUESTION, COLOR_QUESTION]],
    ["a blank question", [{ ...COLOR_QUESTION, header: "", question: " " }]],
    [
      "five options",
      [
        {
          ...COLOR_QUESTION,
          options: ["a", "b", "c", "d", "e"].map((label) => ({
            label,
            description: "",
          })),
        },
      ],
    ],
    [
      "a blank option label",
      [{ ...COLOR_QUESTION, options: [{ label: "", description: "" }] }],
    ],
  ])("declines a request with %s", (_name, questions) => {
    expect(() =>
      decodeCodexInteractiveRequest(userInputRequest(questions)),
    ).toThrow(ProviderRequestDecodeError);
  });

  it("returns the chosen labels and typed text as Codex answers", () => {
    const payload = decodeCodexInteractiveRequest(
      userInputRequest([COLOR_QUESTION]),
    )?.payload;
    if (payload?.kind !== "user_question") {
      throw new Error("expected a user question");
    }

    expect(
      buildCodexUserInputResponse({
        outcome: {
          payload,
          resolution: {
            kind: "user_answer",
            answers: {
              "question-1": {
                selected: ["question-1:option-2"],
                freeText: "teal",
              },
            },
          },
        },
        codexQuestionIds: ["color"],
      }),
    ).toEqual({ answers: { color: { answers: ["Green", "teal"] } } });
  });

  it("returns a decline message when the user dismisses the question card", () => {
    const payload = decodeCodexInteractiveRequest(
      userInputRequest([COLOR_QUESTION]),
    )?.payload;
    if (payload?.kind !== "user_question") {
      throw new Error("expected a user question");
    }

    expect(
      buildCodexUserInputResponse({
        outcome: {
          payload,
          resolution: { kind: "user_answer", answers: {} },
        },
        codexQuestionIds: ["color"],
      }),
    ).toEqual({
      answers: {
        color: { answers: ["The user declined to answer this question."] },
      },
    });
  });

  it("answers Codex under its own question ids, including __proto__", () => {
    const params = userInputRequest([
      { ...COLOR_QUESTION, id: "__proto__" },
      { ...COLOR_QUESTION, id: "constructor" },
    ]);
    const payload = decodeCodexInteractiveRequest(params)?.payload;
    if (payload?.kind !== "user_question") {
      throw new Error("expected a user question");
    }

    expect(payload.questions.map((entry) => entry.id)).toEqual([
      "question-1",
      "question-2",
    ]);
    expect(
      JSON.stringify(
        buildCodexUserInputResponse({
          outcome: {
            payload,
            resolution: {
              kind: "user_answer",
              answers: {
                "question-1": { selected: ["question-1:option-1"] },
                "question-2": { selected: ["question-2:option-2"] },
              },
            },
          },
          codexQuestionIds: codexUserInputQuestionIds(params.params),
        }),
      ),
    ).toBe(
      '{"answers":{"__proto__":{"answers":["Blue (Recommended)"]},"constructor":{"answers":["Green"]}}}',
    );
  });

  it("refuses to answer when the Codex request has a different number of questions", () => {
    const payload = decodeCodexInteractiveRequest(
      userInputRequest([COLOR_QUESTION]),
    )?.payload;
    if (payload?.kind !== "user_question") {
      throw new Error("expected a user question");
    }

    expect(() =>
      buildCodexUserInputResponse({
        outcome: {
          payload,
          resolution: { kind: "user_answer", answers: {} },
        },
        codexQuestionIds: ["color", "size"],
      }),
    ).toThrow(/do not match/);
  });

  it("refuses an answer that names an option the card never offered", () => {
    const payload = decodeCodexInteractiveRequest(
      userInputRequest([COLOR_QUESTION]),
    )?.payload;
    if (payload?.kind !== "user_question") {
      throw new Error("expected a user question");
    }

    expect(() =>
      buildCodexUserInputResponse({
        outcome: {
          payload,
          resolution: {
            kind: "user_answer",
            answers: { "question-1": { selected: ["question-1:option-9"] } },
          },
        },
        codexQuestionIds: ["color"],
      }),
    ).toThrow(/unknown option/);
  });
});
