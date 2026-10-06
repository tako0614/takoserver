import type { Sql } from "../../ports.ts";
import { TakoformV2Error, type V2Form } from "../types.ts";
import { createSqlArtifactCustody } from "./artifact-custody.ts";
import type { V2ArtifactSource } from "./artifact-source.ts";
import {
  parseWorkerBundleManifest,
  parseWorkerBundleSpec,
  validateWorkerBundlePayload,
  validateWorkerBundleUpdate,
  WORKER_BUNDLE_FORM_URL,
  WORKER_BUNDLE_LIMITS,
  WorkerBundleValidationError,
} from "./worker-bundle.ts";

export const WORKER_BUNDLE_BACKEND_ID = "selfhost-v2-worker-bundle-sql-v1";

/** Verified immutable bytes only; this backend never evaluates Worker code. */
export function createWorkerBundleForm(options: {
  sql: Sql;
  source: V2ArtifactSource;
  /** Stable opaque identity of this durable local SQL target, never a path or secret. */
  targetKey: string;
}): V2Form {
  if (!options.targetKey) throw new TypeError("targetKey is required");
  const apply = createSqlArtifactCustody({
    sql: options.sql,
    source: options.source,
    layout: "artifact-0072",
    formUrl: WORKER_BUNDLE_FORM_URL,
    limits: WORKER_BUNDLE_LIMITS,
    parseSpec: parseWorkerBundleSpec,
    parseManifest: parseWorkerBundleManifest,
    validatePayload: validateWorkerBundlePayload,
    invalidArtifact: () => new WorkerBundleValidationError("invalid_artifact"),
    invalidManifest: () => new WorkerBundleValidationError("invalid_manifest"),
    failureNoun: "Bundle",
  });
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
      targetKey: options.targetKey,
      execute: apply,
      reconcile: apply,
    },
  };
}
