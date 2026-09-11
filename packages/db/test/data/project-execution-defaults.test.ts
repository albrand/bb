import { describe, expect, it } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import { deleteProject, createProject } from "../../src/data/projects.js";
import {
  getProjectExecutionDefaults,
  upsertProjectExecutionDefaults,
} from "../../src/data/project-execution-defaults.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "defaults-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "defaults-project",
    source: {
      type: "local_path",
      hostId: host.id,
      path: "/tmp/defaults-project",
    },
  });
  return { db, project };
}

describe("project-execution-defaults", () => {
  it("returns null when a project has no stored defaults for a provider", () => {
    const { db, project } = setup();

    expect(
      getProjectExecutionDefaults(db, {
        projectId: project.id,
      }),
    ).toBeNull();
  });

  it("upserts provider-scoped execution defaults", () => {
    const { db, project } = setup();

    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });

    expect(
      getProjectExecutionDefaults(db, {
        projectId: project.id,
      }),
    ).toEqual({
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });
  });

  it("replaces the previous defaults for the same project and provider", () => {
    const { db, project } = setup();

    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });
    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "codex",
      model: "gpt-5-mini",
      reasoningLevel: "high",
      permissionMode: "accept-edits",
      serviceTier: "fast",
    });

    expect(
      getProjectExecutionDefaults(db, {
        projectId: project.id,
      }),
    ).toEqual({
      providerId: "codex",
      model: "gpt-5-mini",
      reasoningLevel: "high",
      permissionMode: "accept-edits",
      serviceTier: "fast",
    });
  });

  it("replaces the remembered provider choice for the project", () => {
    const { db, project } = setup();

    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });
    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "claude-code",
      model: "claude-opus-4-1",
      reasoningLevel: "high",
      permissionMode: "auto",
      serviceTier: "fast",
    });

    expect(
      getProjectExecutionDefaults(db, {
        projectId: project.id,
      }),
    ).toMatchObject({
      providerId: "claude-code",
      model: "claude-opus-4-1",
    });
  });

  it("keeps each provider's defaults when another provider is used", () => {
    const { db, project } = setup();

    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
      updatedAt: 1,
    });
    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "claude-code",
      model: "claude-opus-4-1",
      reasoningLevel: "medium",
      permissionMode: "auto",
      serviceTier: "fast",
      updatedAt: 2,
    });

    // Using claude-code must not erase what the project remembers for codex.
    expect(
      getProjectExecutionDefaults(db, {
        projectId: project.id,
        providerId: "codex",
      }),
    ).toMatchObject({ providerId: "codex", model: "gpt-5", reasoningLevel: "high" });
    // Unscoped reads still preselect the most recently used provider.
    expect(
      getProjectExecutionDefaults(db, { projectId: project.id }),
    ).toMatchObject({ providerId: "claude-code" });
  });

  it("returns null for a provider the project has never used", () => {
    const { db, project } = setup();

    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
    });

    expect(
      getProjectExecutionDefaults(db, {
        projectId: project.id,
        providerId: "claude-code",
      }),
    ).toBeNull();
  });

  it("drops the per-provider rows with the project", () => {
    const { db, project } = setup();

    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "full",
      serviceTier: "default",
    });
    expect(deleteProject(db, noopNotifier, project.id)).toBe(true);

    expect(
      db.$client
        .prepare<[string], { n: number }>(
          "SELECT count(*) AS n FROM fork_project_provider_execution_defaults WHERE project_id = ?",
        )
        .get(project.id)?.n,
    ).toBe(0);
  });

  it("deletes defaults when the project is deleted", () => {
    const { db, project } = setup();

    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });

    expect(deleteProject(db, noopNotifier, project.id)).toBe(true);
    expect(
      getProjectExecutionDefaults(db, {
        projectId: project.id,
      }),
    ).toBeNull();
  });
});
