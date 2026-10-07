import type { TakoformInterfaceRef } from "./interface-ref.ts";

/** Host-neutral input and result contract for semantic Worker module inspection. */
export const WORKER_MODULE_HANDLER_NAMES = ["fetch", "scheduled", "queue"] as const;

export type WorkerModuleHandlerName = (typeof WORKER_MODULE_HANDLER_NAMES)[number];

export const WORKER_MODULE_IMPORTABLE_MEDIA_TYPES = [
  "application/javascript+module",
  "text/plain",
  "application/octet-stream",
  "application/wasm",
] as const;

export const WORKER_MODULE_AUXILIARY_MEDIA_TYPES = ["application/source-map+json"] as const;

export type WorkerModuleImportableMediaType = (typeof WORKER_MODULE_IMPORTABLE_MEDIA_TYPES)[number];
export type WorkerModuleAuxiliaryMediaType = (typeof WORKER_MODULE_AUXILIARY_MEDIA_TYPES)[number];
export type WorkerModuleMediaType =
  | WorkerModuleImportableMediaType
  | WorkerModuleAuxiliaryMediaType;

export interface WorkerModuleInspectionModule {
  readonly name: string;
  readonly digest: `sha256:${string}`;
  /** Untrusted materialized metadata; the inspector admits the closed media set. */
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface WorkerModuleInspectionInput {
  readonly mainModule: string;
  /** Importable modules and carried auxiliary source maps in one exact snapshot. */
  readonly modules: readonly WorkerModuleInspectionModule[];
  readonly declaredHandlers: readonly WorkerModuleHandlerName[];
}

/** Exact forward Actor class contract evaluated only by the disposable Workerd inspector. */
export interface WorkerActorClassInspectionInput {
  readonly mainModule: string;
  readonly modules: readonly WorkerModuleInspectionModule[];
  readonly className: string;
  readonly runtimeClassRef: TakoformInterfaceRef;
}

/** Canonical Worker Version module graph used to fence active Workerd bytes. */
export interface WorkerActorClassExpectedGraph {
  readonly mainModule: string;
  readonly modules: readonly WorkerModuleInspectionModule[];
}

export type WorkerActorClassInspectionResult =
  | { readonly outcome: "valid" }
  | { readonly outcome: "invalid"; readonly error: "actor_class_invalid" }
  | { readonly outcome: "unavailable"; readonly retryable: true };

/** Exact DurableWorkflow/0.3.0 class candidate evaluated in a disposable workerd. */
export interface WorkerWorkflowClassInspectionInput {
  readonly mainModule: string;
  readonly modules: readonly WorkerModuleInspectionModule[];
  readonly className: string;
}

export type WorkerWorkflowClassInspectionResult =
  | { readonly outcome: "valid" }
  | { readonly outcome: "invalid"; readonly error: "workflow_class_invalid" }
  | { readonly outcome: "unavailable"; readonly retryable: true };

export type WorkerModuleLoadError =
  | "module_not_found"
  | "unsupported_media_type"
  | "module_syntax_error"
  | "handler_not_exported";

/** Host-internal evaluation refusals are deliberately not public ABI errors. */
export type WorkerModuleInspectionError =
  | WorkerModuleLoadError
  | "module_evaluation_failed"
  | "module_evaluation_limit_exceeded";

export type WorkerModuleInspectionResult =
  | {
      readonly outcome: "valid";
      readonly exportedHandlers: readonly WorkerModuleHandlerName[];
    }
  | {
      readonly outcome: "invalid";
      readonly error: WorkerModuleInspectionError;
    }
  | {
      readonly outcome: "unavailable";
      readonly retryable: true;
    };

export interface WorkerModuleSemanticInspector {
  inspect(input: WorkerModuleInspectionInput): Promise<WorkerModuleInspectionResult>;
  inspectActorClass(
    input: WorkerActorClassInspectionInput,
  ): Promise<WorkerActorClassInspectionResult>;
  inspectWorkflowClass(
    input: WorkerWorkflowClassInspectionInput,
  ): Promise<WorkerWorkflowClassInspectionResult>;
}
