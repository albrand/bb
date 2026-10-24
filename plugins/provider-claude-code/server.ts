import { registerUsageSource } from "./src/usage-source.js";
import { registerClaudeAiService } from "./src/ai-service.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { CLAUDE_NATIVE_ROOTS_DECLARATION } from "./src/native-roots.js";
import {
  CLAUDE_CODE_ACTIVE_CATALOG_DATA,
  CLAUDE_XHIGH_CAPABLE_REASONING_EFFORT_DATA,
  DEFAULT_CLAUDE_CODE_MODEL,
} from "./src/model-catalog-data.js";

export default function plugin(bb: BbPluginApi) {
  registerUsageSource(bb);
  registerClaudeAiService(bb);
  bb.settings.define({
    memoryEnabled: {
      type: "boolean",
      label: "Claude Code memory",
      description:
        "Allow Claude Code to read and write its native auto-memory for bb threads.",
      default: true,
    },
    subagentsDisabled: {
      type: "boolean",
      label: "Disable provider subagents",
      description:
        "Hide Claude Code's native Task tool so agents use bb for delegation.",
      default: false,
    },
    workflowsDisabled: {
      type: "boolean",
      label: "Disable Workflow tool",
      description: "Hide Claude Code's native Workflow tool for bb threads.",
      default: false,
    },
    disable1MContext: {
      type: "boolean",
      label: "Disable 1M context",
      description:
        "Disable the 1M-token context window for Claude Code threads. Applies on the next turn.",
      default: false,
    },
    chromeEnabled: {
      type: "boolean",
      label: "Claude in Chrome",
      description:
        "Start Claude Code with the Claude in Chrome browser tools. Needs the Chrome extension and a claude.ai login on the host.",
      default: false,
    },
    artifactsEnabled: {
      type: "boolean",
      label: "Claude Artifacts",
      description:
        "Give Claude Code its Artifact tools to read, publish, and edit claude.ai artifacts. Claude may publish private pages to claude.ai without asking. Needs a claude.ai login on the host. Applies on the next turn.",
      default: false,
    },
    sandboxEnabled: {
      type: "boolean",
      label: "Claude Code sandbox",
      description:
        "Run Bash commands in Claude Code's sandbox in Accept Edits and Approve for me modes. Turn off to use Claude Code's own command approvals and sandbox settings instead.",
      default: true,
    },
  });

  bb.providers.register({
    id: "claude-code",
    displayName: "Claude Code",
    icon: "./icons/claude-code.svg",
    strings: {
      signInHint: "Run `claude` on the machine to sign in.",
      expiredHint: "Your Claude session expired. Run `claude`, then reload.",
      installUrl: "https://claude.com/claude-code",
      brandPrefix: "Claude ",
      planModeCopy:
        "Claude Code will plan without normal full-access execution.",
      iconTint: { light: "#D97757", dark: "#D97757" },
    },
    ...CLAUDE_NATIVE_ROOTS_DECLARATION,
    experimental_nativeTerminal: {
      executable: "claude",
      launchArgs: ["--dangerously-skip-permissions"],
      modelArgs: ["--model", "{model}"],
      mcp: [
        "--mcp-config",
        '{"mcpServers":{"bb-bridge":{"command":{commandJson},"args":{argsJson}}}}',
      ],
      imageArgs: [],
      pastePlaceholders: ["[Pasted text #", "[Image #"],
      sessionRoot: { env: "CLAUDE_CONFIG_DIR", home: ".claude" },
      session: {
        kind: "assigned",
        startArgs: ["--session-id", "{sessionId}"],
        resumeArgs: ["--resume", "{sessionId}"],
        transcript: "projects/*/{sessionId}.jsonl",
      },
      activity: {
        hooks: {
          args: ["--settings", "{settings}"],
          working: ["UserPromptSubmit", "PreToolUse"],
          idle: [],
          pending: ["Stop"],
          promptField: "prompt",
          sessionIdField: "session_id",
          permission: {
            open: ["PermissionRequest"],
            close: ["PostToolUse", "PostToolUseFailure", "PermissionDenied"],
            idField: "tool_name",
            label: "Claude Code needs permission to use",
            skip: ["AskUserQuestion", "ExitPlanMode"],
          },
          turnId: "prompt_id",
        },
        transcript: {
          identity: {
            recordId: "uuid",
            parentId: "parentUuid",
            turnId: "promptId",
            timestamp: "timestamp",
          },
          questions: {
            open: [
              {
                match: {
                  equals: {
                    type: "assistant",
                    "message.content.0.type": "tool_use",
                    "message.content.0.name": "AskUserQuestion",
                  },
                },
                id: "message.content.0.id",
                prompt: "message.content.0.input.questions.0.question",
                label: "Claude Code is asking a question",
              },
              {
                match: {
                  equals: {
                    type: "assistant",
                    "message.content.0.type": "tool_use",
                    "message.content.0.name": "ExitPlanMode",
                  },
                },
                id: "message.content.0.id",
                label: "Claude Code is waiting for you to approve its plan",
              },
            ],
            close: [
              {
                match: {
                  equals: {
                    type: "user",
                    "message.content.0.type": "tool_result",
                  },
                },
                id: "message.content.0.tool_use_id",
              },
            ],
          },
          working: [
            { equals: { type: "assistant", isSidechain: false } },
            { equals: { type: "user", "origin.kind": "human" } },
            {
              equals: { type: "user", isMeta: true },
              startsWith: { "message.content": "Stop hook feedback:\n" },
            },
          ],
          idle: [
            {
              equals: {
                type: "system",
                subtype: "stop_hook_summary",
                hasOutput: false,
                isSidechain: false,
              },
            },
            {
              equals: {
                type: "system",
                subtype: "stop_hook_summary",
                preventedContinuation: true,
                isSidechain: false,
              },
            },
            {
              equals: {
                type: "system",
                subtype: "turn_duration",
                isSidechain: false,
              },
            },
            {
              equals: { type: "user" },
              startsWith: {
                "message.content.0.text": "[Request interrupted by user",
              },
            },
          ],
          prompt: [],
        },
      },
    },
    maintenance: { health: true, usage: true, installation: true },
    capabilities: {
      supportsServiceTier: true,
      supportsNativeUserQuestion: true,
      reportsTokenUsage: true,
      fork: "checkpoint",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: ["low", "medium", "high", "xhigh", "ultracode", "max"],
    },
    reasoningLevels: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      {
        id: "ultracode",
        label: "Ultracode",
        description: "Extra-high effort plus standing workflow orchestration.",
      },
      { id: "max", label: "Max" },
    ],
    serviceTiers: [
      { id: "default", label: "Default" },
      {
        id: "fast",
        label: "Fast",
        description:
          "Faster responses on supported Opus models at a higher cost per token.",
      },
    ],
    composerActions: ["plan"],
    completedTurnDisplay: "flat",
    env: {
      passthrough: ["BB_CLAUDE_CODE_EXECUTABLE", "CLAUDE_CODE_OAUTH_TOKEN"],
    },
    models: {
      scope: "host",
      childThreadModel: "claude-sonnet-5-5",
      fallback: CLAUDE_CODE_ACTIVE_CATALOG_DATA.map((entry) => ({
        id: entry.model,
        displayName: entry.displayName,
        description: entry.description,
        supportedReasoningEfforts: CLAUDE_XHIGH_CAPABLE_REASONING_EFFORT_DATA,
        defaultReasoningEffort: entry.defaultReasoningEffort,
        isDefault: entry.model === DEFAULT_CLAUDE_CODE_MODEL,
      })),
    },
    deriveProviderOptions(context) {
      return {
        memoryEnabled: context.settings.memoryEnabled !== false,
        providerSubagentsEnabled: context.settings.subagentsDisabled !== true,
        workflowsEnabled: context.settings.workflowsDisabled !== true,
        chromeEnabled: context.settings.chromeEnabled === true,
        disable1MContext: context.settings.disable1MContext === true,
        artifactsEnabled: context.settings.artifactsEnabled === true,
        sandboxEnabled: context.settings.sandboxEnabled !== false,
        ...(context.promptMode === "plan"
          ? { claudeCodePermissionMode: "plan" }
          : {}),
      };
    },
  });
}
