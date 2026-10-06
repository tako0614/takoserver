import type { Sql } from "../../ports.ts";
import { TakoformV2Error, type V2Form } from "../types.ts";
import { createSqlArtifactCustody, type SqlArtifactCustody } from "./artifact-custody.ts";
import type { V2ArtifactSource } from "./artifact-source.ts";
import {
  parseWorkerBundleManifest,
  parseWorkerBundleSpec,
  projectWorkerBundleVerified,
  validateWorkerBundlePayload,
  validateWorkerBundleUpdate,
  WORKER_BUNDLE_FORM_URL,
  WORKER_BUNDLE_LIMITS,
  type WorkerBundleManifest,
  WorkerBundleValidationError,
} from "./worker-bundle.ts";

export const WORKER_BUNDLE_BACKEND_ID = "selfhost-v2-worker-bundle-sql-v1";

export type WorkerBundleCustody = SqlArtifactCustody<WorkerBundleManifest>;

export function createWorkerBundleCustody(options: {
  readonly sql: Sql;
  readonly source: V2ArtifactSource;
}): WorkerBundleCustody {
  return createSqlArtifactCustody({
    sql: options.sql,
    source: options.source,
    layout: "artifact-0072",
    formUrl: WORKER_BUNDLE_FORM_URL,
    limits: WORKER_BUNDLE_LIMITS,
    parseSpec: parseWorkerBundleSpec,
    parseManifest: parseWorkerBundleManifest,
    validatePayload: validateWorkerBundlePayload,
    projectVerified: projectWorkerBundleVerified,
    invalidArtifact: () => new WorkerBundleValidationError("invalid_artifact"),
    invalidManifest: () => new WorkerBundleValidationError("invalid_manifest"),
    failureNoun: "Bundle",
  });
}

export function createWorkerBundleHost(options: {
  readonly sql: Sql;
  readonly source: V2ArtifactSource;
  /** Stable opaque identity of this durable local SQL target, never a path or secret. */
  readonly targetKey: string;
}): { readonly custody: WorkerBundleCustody; readonly form: V2Form } {
  if (!options.targetKey) throw new TypeError("targetKey is required");
  const custody = createWorkerBundleCustody(options);
  return {
    custody,
    form: createWorkerBundleFormWithCustody(options.targetKey, custody),
  };
}

/** Verified immutable bytes only; this backend never evaluates Worker code. */
export function createWorkerBundleForm(options: {
  sql: Sql;
  source: V2ArtifactSource;
  /** Stable opaque identity of this durable local SQL target, never a path or secret. */
  targetKey: string;
}): V2Form {
  if (!options.targetKey) throw new TypeError("targetKey is required");
  return createWorkerBundleFormWithCustody(options.targetKey, createWorkerBundleCustody(options));
}

function createWorkerBundleFormWithCustody(
  targetKey: string,
  custody: WorkerBundleCustody,
): V2Form {
  return {
    validateCreate(spec) {
      try {
        parseWorkerBundleSpec(spec);
      } catch (error) {
        if (error instanceof WorkerBundleValidationError)
          throw new TakoformV2Error(error.code, 422);
        throw error;
      }
    },
    validateUpdate(previousSpec, spec) {
      try {
        validateWorkerBundleUpdate(previousSpec, spec);
      } catch (error) {
        if (error instanceof WorkerBundleValidationError)
          throw new TakoformV2Error(error.code, 422);
        throw error;
      }
    },
    rejectDeleteWhileReferenced: true,
    backend: {
      id: WORKER_BUNDLE_BACKEND_ID,
      targetKey,
      execute: custody.execute,
      reconcile: custody.execute,
    },
  };
}
