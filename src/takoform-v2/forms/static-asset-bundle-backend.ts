import type { Sql } from "../../ports.ts";
import { TakoformV2Error, type V2Form } from "../types.ts";
import { createSqlArtifactCustody, type SqlArtifactCustody } from "./artifact-custody.ts";
import type { V2ArtifactSource } from "./artifact-source.ts";
import {
  parseStaticAssetBundleManifest,
  parseStaticAssetBundleSpec,
  STATIC_ASSET_BUNDLE_FORM_URL,
  STATIC_ASSET_BUNDLE_LIMITS,
  type StaticAssetBundleManifest,
  StaticAssetBundleValidationError,
  validateStaticAssetBundlePayload,
  validateStaticAssetBundleUpdate,
} from "./static-asset-bundle.ts";

export const STATIC_ASSET_BUNDLE_BACKEND_ID = "selfhost-v2-static-asset-bundle-sql-v1";

export type StaticAssetBundleCustody = SqlArtifactCustody<StaticAssetBundleManifest>;

export function createStaticAssetBundleCustody(options: {
  readonly sql: Sql;
  readonly source: V2ArtifactSource;
}): StaticAssetBundleCustody {
  return createSqlArtifactCustody({
    sql: options.sql,
    source: options.source,
    layout: "artifact-0072",
    formUrl: STATIC_ASSET_BUNDLE_FORM_URL,
    limits: STATIC_ASSET_BUNDLE_LIMITS,
    parseSpec: parseStaticAssetBundleSpec,
    parseManifest: parseStaticAssetBundleManifest,
    validatePayload: validateStaticAssetBundlePayload,
    invalidArtifact: () => new StaticAssetBundleValidationError("invalid_artifact"),
    invalidManifest: () => new StaticAssetBundleValidationError("invalid_manifest"),
    failureNoun: "Static asset bundle",
  });
}

/** Create the public Form and its reusable verified-byte custody adapter. */
export function createStaticAssetBundleHost(options: {
  readonly sql: Sql;
  readonly source: V2ArtifactSource;
  /** Stable opaque identity of this durable local SQL target, never a path or secret. */
  readonly targetKey: string;
}): { readonly custody: StaticAssetBundleCustody; readonly form: V2Form } {
  if (!options.targetKey) throw new TypeError("targetKey is required");
  const custody = createStaticAssetBundleCustody(options);
  return {
    custody,
    form: createStaticAssetBundleFormWithCustody(options.targetKey, custody),
  };
}

/** Verified immutable bytes only; this backend does not serve or interpret assets. */
export function createStaticAssetBundleForm(options: {
  sql: Sql;
  source: V2ArtifactSource;
  /** Stable opaque identity of this durable local SQL target, never a path or secret. */
  targetKey: string;
}): V2Form {
  if (!options.targetKey) throw new TypeError("targetKey is required");
  return createStaticAssetBundleFormWithCustody(
    options.targetKey,
    createStaticAssetBundleCustody(options),
  );
}

function createStaticAssetBundleFormWithCustody(
  targetKey: string,
  custody: StaticAssetBundleCustody,
): V2Form {
  return {
    validateCreate(spec) {
      try {
        parseStaticAssetBundleSpec(spec);
      } catch (error) {
        if (error instanceof StaticAssetBundleValidationError)
          throw new TakoformV2Error(error.code, 422);
        throw error;
      }
    },
    validateUpdate(previousSpec, spec) {
      try {
        validateStaticAssetBundleUpdate(previousSpec, spec);
      } catch (error) {
        if (error instanceof StaticAssetBundleValidationError)
          throw new TakoformV2Error(error.code, 422);
        throw error;
      }
    },
    rejectDeleteWhileReferenced: true,
    backend: {
      id: STATIC_ASSET_BUNDLE_BACKEND_ID,
      targetKey,
      execute: custody.execute,
      reconcile: custody.execute,
    },
  };
}
