import type { Environment, Host, Project } from "@bb/domain";
import type { ThreadResponse } from "@bb/server-contract";
import type {
  JsonValue,
  PluginEnvironmentProviderRequirements,
  PluginEnvironmentValidateDecision,
  StandardSchemaV1,
  StandardSchemaV1InferOutput,
} from "@get-bb/plugin-sdk";

export type PluginEnvironmentProviderInputsSchema =
  | StandardSchemaV1
  | undefined;
type Fact<R, K extends PropertyKey, T> =
  R extends Record<K, true> ? T : T | null;
type Checkout<R> = R extends { projectCheckout: true } | { gitCheckout: true }
  ? { path: string; experimental_ownsPath: boolean }
  : { path: string; experimental_ownsPath: boolean } | null;
type InputsValue<S> = S extends StandardSchemaV1
  ? StandardSchemaV1InferOutput<S>
  : null;

/** Attempt-scoped updates; core persists each update before this call returns. */
export interface PluginEnvironmentProviderProgress {
  step(text: string): void;
  log(text: string): void;
}

export interface PluginEnvironmentProviderValidateContext<
  R extends PluginEnvironmentProviderRequirements =
    PluginEnvironmentProviderRequirements,
  S extends PluginEnvironmentProviderInputsSchema =
    PluginEnvironmentProviderInputsSchema,
> {
  project: Project;
  host: Host;
  projectCheckout: Checkout<R>;
  gitRemote: Fact<R, "gitRemote", string>;
  inputs: InputsValue<S>;
}

export interface PluginEnvironmentProviderAvailabilityContext {
  project: Project;
  host: Host;
  projectCheckout: { path: string } | null;
  gitRemote: string | null;
}

export type PluginEnvironmentProviderAvailability =
  | { status: "available" }
  | { status: "setup-required"; message: string }
  | { status: "unavailable"; message: string };

export interface PluginEnvironmentProviderCreateContext<
  R extends PluginEnvironmentProviderRequirements =
    PluginEnvironmentProviderRequirements,
  S extends PluginEnvironmentProviderInputsSchema =
    PluginEnvironmentProviderInputsSchema,
> extends PluginEnvironmentProviderValidateContext<R, S> {
  thread: ThreadResponse;
  suggestedBranchName: string;
  attempt: number;
  pathKey: string;
  experimental_claimPath(path: string): Promise<boolean>;
  report: PluginEnvironmentProviderProgress;
  signal: AbortSignal;
}

/** Rebuilds a thread's destroyed environment; `inputs` are the ones it was created with. */
export interface PluginEnvironmentProviderRestoreContext<
  R extends PluginEnvironmentProviderRequirements =
    PluginEnvironmentProviderRequirements,
  S extends PluginEnvironmentProviderInputsSchema =
    PluginEnvironmentProviderInputsSchema,
> extends PluginEnvironmentProviderValidateContext<R, S> {
  thread: ThreadResponse;
  attempt: number;
  pathKey: string;
  experimental_claimPath(path: string): Promise<boolean>;
  /** Resource is private to this provider; null after completed removal. */
  previous: { environment: Environment; resource: JsonValue | null };
  report: PluginEnvironmentProviderProgress;
  signal: AbortSignal;
}

export type PluginEnvironmentProviderCreateResult =
  | {
      status: "created";
      path: string;
      ownsPath: boolean;
      /** Ref the workspace's changes are compared against. Null clears the value recorded on a reused environment; omit to keep it. */
      mergeBaseBranch?: string | null;
      resource?: JsonValue;
    }
  | {
      status: "failed";
      message: string;
      /** Experimental: what the failed attempt left behind. `{ path }` means it kept that path on purpose; `null` means it kept nothing. Leaving the field out means the provider does not know, and core treats the attempt as unresolved. Core records a retention so the machine cannot be destroyed and the path cannot be removed or moved through core until the retention is closed: see docs/api_to_audit.md. */
      experimental_retained?: { path: string } | null;
    };

export interface PluginEnvironmentProviderRetentionProofContext {
  hostId: string;
  /** The path the attempt kept, or null when the provider never reported one: then `pathKey` and `branchName` identify the attempt. */
  path: string | null;
  pathKey: string | null;
  branchName: string | null;
  sourcePath: string | null;
  threadId: string | null;
  signal: AbortSignal;
}

export type PluginEnvironmentProviderRetentionProof =
  | { absent: true; proof: string }
  | { absent: false; reason: string };

export interface PluginEnvironmentProviderRemoveContext {
  environment: Environment | null;
  hostId: string | null;
  path: string | null;
  pathKey: string;
  resource: JsonValue | null;
  attempt: number;
  report: PluginEnvironmentProviderProgress;
  signal: AbortSignal;
}

export type PluginEnvironmentProviderRemoveResult =
  | { status: "removed" }
  /** Experimental: nothing changed and the resource was kept on purpose. Core restores the environment's earlier state and retries after a backoff: see docs/api_to_audit.md. */
  | { status: "retained"; message: string }
  | { status: "failed"; message: string };

export type PluginEnvironmentProviderPreflightRemoveResult =
  | { status: "removable" }
  | { status: "retained"; message: string };

/** Core normalizes omitted policy members once at registration. */
export interface PluginEnvironmentProviderPolicy {
  /** Default five minutes; null keeps the environment indefinitely. */
  retireGraceMs: number | null;
  /** Default per-thread; replacement environments use a fresh key to avoid dead paths. */
  pathKeys: "per-thread" | "per-attempt";
}

/** Resource operations only. Core owns durable launches, retries and retirement. */
export interface PluginEnvironmentProviderDefinition<
  R extends PluginEnvironmentProviderRequirements =
    PluginEnvironmentProviderRequirements,
  S extends PluginEnvironmentProviderInputsSchema =
    PluginEnvironmentProviderInputsSchema,
> {
  id: string;
  displayName: string;
  /** Short explanation shown in environment choices. */
  description: string;
  /** Host glyph, plugin-relative icon path, or this plugin’s declared namespaced icon. */
  icon: string;
  requires?: R;
  inputs?: S;
  policy?: Partial<PluginEnvironmentProviderPolicy>;
  /** Experimental per-machine availability, probed in the background for pickers and again at thread creation: see docs/api_to_audit.md. */
  availability?(
    context: PluginEnvironmentProviderAvailabilityContext,
  ):
    | PluginEnvironmentProviderAvailability
    | Promise<PluginEnvironmentProviderAvailability>;
  validate?(
    context: PluginEnvironmentProviderValidateContext<R, S>,
  ):
    | PluginEnvironmentValidateDecision
    | Promise<PluginEnvironmentValidateDecision>;
  /** Pure path selection from parsed inputs. Core reuses a recorded environment on the selected host before calling create; null requests normal creation. */
  experimental_existingPath?(inputs: InputsValue<S>): string | null;
  create(
    context: PluginEnvironmentProviderCreateContext<R, S>,
  ): Promise<PluginEnvironmentProviderCreateResult>;
  /** Experimental: rebuild a destroyed environment when its thread asks for it back. Without it, core never rebuilds this provider's destroyed environments: see docs/api_to_audit.md. */
  restore?(
    context: PluginEnvironmentProviderRestoreContext<R, S>,
  ): Promise<PluginEnvironmentProviderCreateResult>;
  /** Experimental: inspect without mutating before core runs the teardown hook. A retained answer skips the hook and the removal: see docs/api_to_audit.md. */
  experimental_preflightRemove?(
    context: PluginEnvironmentProviderRemoveContext,
  ):
    | PluginEnvironmentProviderPreflightRemoveResult
    | Promise<PluginEnvironmentProviderPreflightRemoveResult>;
  /** Experimental: prove, without mutating, that what an attempt kept is gone from the machine: not on disk (at the path, or at the place the provider would have put it for `pathKey`), not registered as a workspace of its repository, and not held by a branch of the thread. Core closes the retention only on `absent: true`, never on an error or a timeout, and records the proof: see docs/api_to_audit.md. */
  experimental_proveRetentionAbsent?(
    context: PluginEnvironmentProviderRetentionProofContext,
  ):
    | PluginEnvironmentProviderRetentionProof
    | Promise<PluginEnvironmentProviderRetentionProof>;
  remove(
    context: PluginEnvironmentProviderRemoveContext,
  ): Promise<PluginEnvironmentProviderRemoveResult>;
}
