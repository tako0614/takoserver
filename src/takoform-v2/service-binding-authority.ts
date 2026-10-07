import { bytesDigest, canonicalJson } from "../json.ts";
import type { Sql } from "../ports.ts";
import { referencesForWorkerVersion } from "./forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
  parseWorkerVersionSpec,
  WORKER_VERSION_FORM_URL,
} from "./forms/worker-specs.ts";
import { isReadyWorkerVersionObservation } from "./forms/worker-version-observed.ts";

/** Core-only proof input; physical incarnation/current serving context is owner-owned. */
export interface V2ServiceBindingClaim {
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workerUid: string;
  readonly workerVersionUid: string;
  readonly workerVersionOperationId: string;
  readonly nativeVersionId: string;
  readonly incarnationId: string;
  readonly servingSourceOperationId: string;
  readonly bindings: readonly { readonly name: string; readonly resourceUid: string }[];
}

/** Logical Worker identity only. Its current Deployment is selected by the runtime per call. */
export interface V2ServiceBindingResolution {
  readonly identity: {
    readonly targetKey: string;
    readonly principal: string;
    readonly space: string;
    readonly resourceUid: string;
  };
  readonly vector: string;
  readonly stillCurrent: () => Promise<boolean>;
}

interface CapturedBinding {
  readonly identity: V2ServiceBindingResolution["identity"];
  readonly vector: string;
}

interface Row extends Record<string, unknown> {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyClaim(value: V2ServiceBindingClaim): V2ServiceBindingClaim | null {
  if (
    !isRecord(value) ||
    typeof value.principal !== "string" ||
    value.principal.length === 0 ||
    typeof value.space !== "string" ||
    value.space.length === 0 ||
    typeof value.targetKey !== "string" ||
    value.targetKey.length === 0 ||
    typeof value.workerUid !== "string" ||
    value.workerUid.length === 0 ||
    typeof value.workerVersionUid !== "string" ||
    value.workerVersionUid.length === 0 ||
    typeof value.workerVersionOperationId !== "string" ||
    value.workerVersionOperationId.length === 0 ||
    typeof value.nativeVersionId !== "string" ||
    typeof value.incarnationId !== "string" ||
    value.incarnationId.length === 0 ||
    typeof value.servingSourceOperationId !== "string" ||
    value.servingSourceOperationId.length === 0 ||
    !Array.isArray(value.bindings) ||
    value.bindings.length === 0 ||
    value.bindings.length > 64
  ) {
    return null;
  }
  const bindings: { name: string; resourceUid: string }[] = [];
  const names = new Set<string>();
  for (const item of value.bindings) {
    if (
      !isRecord(item) ||
      typeof item.name !== "string" ||
      item.name.length === 0 ||
      typeof item.resourceUid !== "string" ||
      item.resourceUid.length === 0 ||
      names.has(item.name)
    ) {
      return null;
    }
    names.add(item.name);
    bindings.push({ name: item.name, resourceUid: item.resourceUid });
  }
  return {
    principal: value.principal,
    space: value.space,
    targetKey: value.targetKey,
    workerUid: value.workerUid,
    workerVersionUid: value.workerVersionUid,
    workerVersionOperationId: value.workerVersionOperationId,
    nativeVersionId: value.nativeVersionId,
    incarnationId: value.incarnationId,
    servingSourceOperationId: value.servingSourceOperationId,
    bindings,
  };
}

function exactReferences(
  actual: readonly Row[],
  expected: ReturnType<typeof referencesForWorkerVersion>,
): boolean {
  if (actual.length !== expected.length) return false;
  return expected.every((requirement, index) => {
    const row = actual[index];
    return (
      row?.target_uid === requirement.resourceUid &&
      row.form_url === requirement.formUrl &&
      row.readiness === requirement.readiness &&
      row.target_spec_path ===
        (requirement.targetSpecMatch ? `$.${requirement.targetSpecMatch.path.join(".")}` : null) &&
      row.target_spec_equals === (requirement.targetSpecMatch?.equals ?? null)
    );
  });
}

/**
 * Resolves the immutable, accepted caller Version reference to one logical
 * ModuleWorker. It does not choose or cache that Worker's active Deployment.
 */
export function createV2ServiceBindingAuthority(options: {
  readonly sql: Sql;
  readonly targetKey: string;
}) {
  if (!options?.sql || typeof options.targetKey !== "string" || options.targetKey.length === 0) {
    throw new TypeError("Worker service binding authority is required");
  }

  const { sql, targetKey } = options;

  async function capture(
    claim: V2ServiceBindingClaim,
    bindingName: string,
  ): Promise<CapturedBinding | null> {
    if (claim.targetKey !== targetKey) return null;
    const selected = claim.bindings.find((binding) => binding.name === bindingName);
    if (!selected) return null;

    const sourceRows = await sql.query(
      `SELECT op.id, op.resource_uid, op.principal, op.generation AS source_generation,
              op.action, op.status, op.effect, op.backend_id, op.target_key,
              op.accepted_spec_json, op.result_observed_json,
              r.form_url AS resource_form_url, r.principal AS resource_principal,
              r.space AS resource_space, r.target_key AS resource_target_key,
              r.deleted_at AS resource_deleted_at, r.observed_generation
       FROM tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
       WHERE op.id = ? AND op.resource_uid = ? AND op.principal = ? AND op.target_key = ?
         AND op.action IN ('create','update') AND op.status = 'succeeded'
         AND op.effect = 'complete' AND op.accepted_spec_json IS NOT NULL
         AND op.backend_id = r.backend_id AND op.target_key = r.target_key
       LIMIT 2`,
      [claim.workerVersionOperationId, claim.workerVersionUid, claim.principal, targetKey],
    );
    const source = sourceRows.length === 1 ? sourceRows[0] : null;
    if (
      !source ||
      source.resource_form_url !== WORKER_VERSION_FORM_URL ||
      source.resource_principal !== claim.principal ||
      source.resource_space !== claim.space ||
      source.resource_target_key !== targetKey ||
      source.resource_deleted_at !== null ||
      typeof source.source_generation !== "number" ||
      !Number.isSafeInteger(source.source_generation) ||
      source.source_generation < 1 ||
      typeof source.observed_generation !== "number" ||
      source.source_generation > source.observed_generation ||
      typeof source.accepted_spec_json !== "string" ||
      typeof source.result_observed_json !== "string"
    ) {
      return null;
    }

    let spec: ReturnType<typeof parseWorkerVersionSpec>;
    try {
      spec = parseWorkerVersionSpec(JSON.parse(source.accepted_spec_json));
      if (
        !isReadyWorkerVersionObservation(
          JSON.parse(source.result_observed_json),
          spec.bundle !== undefined,
        )
      ) {
        return null;
      }
    } catch {
      return null;
    }

    const declared = spec.serviceBindings.map((binding) => ({
      name: binding.name,
      resourceUid: binding.resource.resourceUid,
    }));
    if (
      spec.worker.resourceUid !== claim.workerUid ||
      canonicalJson(declared) !== canonicalJson(claim.bindings) ||
      !declared.some(
        (binding) => binding.name === bindingName && binding.resourceUid === selected.resourceUid,
      )
    ) {
      return null;
    }

    const digest = await bytesDigest(
      new TextEncoder().encode(`${claim.workerVersionUid}\u0000${source.source_generation}`),
    );
    if (claim.nativeVersionId !== `v2-${digest.slice("sha256:".length)}`) return null;

    const expectedReferences = referencesForWorkerVersion(spec);
    const referenceSets = await sql.query(
      "SELECT sealed FROM tf_v2_operation_reference_sets WHERE operation_id = ?",
      [claim.workerVersionOperationId],
    );
    if (referenceSets.length !== 1 || referenceSets[0]?.sealed !== 1) return null;
    const references = await sql.query(
      `SELECT ref.target_uid, ref.form_url, ref.readiness, ref.target_spec_path,
              ref.target_spec_equals
       FROM tf_v2_operation_references ref
       JOIN tf_v2_operation_reference_sets sealed
         ON sealed.operation_id = ref.operation_id AND sealed.sealed = 1
       WHERE ref.operation_id = ? ORDER BY ref.target_uid`,
      [claim.workerVersionOperationId],
    );
    if (!exactReferences(references, expectedReferences)) return null;

    const resources = await sql.query(
      `SELECT uid, principal, space, target_key, form_url, spec_json, deleted_at
       FROM tf_v2_resources WHERE uid IN (?, ?) ORDER BY uid LIMIT 3`,
      [claim.workerUid, selected.resourceUid],
    );
    if (resources.length !== new Set([claim.workerUid, selected.resourceUid]).size) return null;
    const resourceByUid = new Map(resources.map((row) => [row.uid, row] as const));
    const callerWorker = resourceByUid.get(claim.workerUid);
    const targetWorker = resourceByUid.get(selected.resourceUid);
    if (!validWorkerIdentity(callerWorker, claim) || !validWorkerIdentity(targetWorker, claim)) {
      return null;
    }

    const identity = Object.freeze({
      targetKey: claim.targetKey,
      principal: claim.principal,
      space: claim.space,
      resourceUid: selected.resourceUid,
    });
    return {
      identity,
      vector: canonicalJson({
        sourceOperation: [
          source.id,
          source.resource_uid,
          source.principal,
          source.source_generation,
          source.accepted_spec_json,
          source.result_observed_json,
        ],
        references,
        callerWorker: [callerWorker?.uid, callerWorker?.principal, callerWorker?.space],
        targetWorker: [
          targetWorker?.uid,
          targetWorker?.principal,
          targetWorker?.space,
          targetWorker?.spec_json,
        ],
      }),
    };
  }

  async function resolveCurrentBinding(
    input: V2ServiceBindingClaim,
    bindingName: string,
  ): Promise<V2ServiceBindingResolution | null> {
    try {
      const claim = copyClaim(input);
      if (!claim || typeof bindingName !== "string" || bindingName.length === 0) return null;
      const before = await capture(claim, bindingName);
      if (!before) return null;
      const after = await capture(claim, bindingName);
      if (!after || after.vector !== before.vector) return null;
      const vector = after.vector;
      return Object.freeze({
        identity: after.identity,
        vector,
        stillCurrent: async () => {
          try {
            const latest = await capture(claim, bindingName);
            return latest?.vector === vector;
          } catch {
            return false;
          }
        },
      });
    } catch {
      return null;
    }
  }

  return Object.freeze({ resolveCurrentBinding });
}

function validWorkerIdentity(row: Row | undefined, claim: V2ServiceBindingClaim): boolean {
  if (
    !row ||
    row.principal !== claim.principal ||
    row.space !== claim.space ||
    row.target_key !== claim.targetKey ||
    row.form_url !== MODULE_WORKER_FORM_URL ||
    row.deleted_at !== null ||
    typeof row.spec_json !== "string"
  ) {
    return false;
  }
  try {
    parseModuleWorkerSpec(JSON.parse(row.spec_json));
    return true;
  } catch {
    return false;
  }
}
