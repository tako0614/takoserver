import { CONTAINER_CONTRACT as C, type ContainerBindingClaim } from "../container-contract.ts";
import { canonicalJson } from "../json.ts";
import type { Row, Sql, SqlStatement } from "../ports.ts";
import { referencesForContainerConsumerWorkerVersion } from "./forms/container-consumer-references.ts";
import {
  type CONTAINER_0_2_FORM_URL,
  CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
  isContainerConsumerTargetFormUrl,
} from "./forms/container-consumer-specs.ts";
import { referencesForForwardWorkerVersion } from "./forms/worker-references.ts";
import {
  FORWARD_WORKER_VERSION_FORM_URL,
  MAX_WORKER_BINDINGS_PER_KIND,
  parseForwardWorkerVersionSpec,
} from "./forms/worker-specs.ts";
import { isReadyWorkerVersionObservation } from "./forms/worker-version-observed.ts";
import {
  hasV2ForwardContainerOperationGenerationIndex,
  V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME,
} from "./operation-generation-index.ts";
import { MAX_FAILED_TAIL } from "./worker-publication-state.ts";

export interface V2ForwardContainerBindingClaim extends ContainerBindingClaim {
  /** Exact accepted generation that produced the private native Version. */
  readonly workerVersionGeneration: number;
}

/** Detached accepted graph data. This is neither a native grant nor a readiness proof. */
export interface V2ForwardContainerBindingSnapshot {
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workerVersionUid: string;
  /**
   * 0.7.0 only ever seals Container 0.1.0. 0.8.0 seals Container 0.1.0 or 0.2.0 per
   * binding. The pair is never reinterpreted: the Version Form and the target Form
   * are the exact sealed values.
   */
  readonly workerVersionFormUrl:
    | typeof FORWARD_WORKER_VERSION_FORM_URL
    | typeof CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL;
  readonly workerVersionGeneration: number;
  readonly sourceOperationId: string;
  readonly targetUid: string;
  readonly targetFormUrl: typeof C.formUrl | typeof CONTAINER_0_2_FORM_URL;
  /** Committed observation, which can predate a pending or failed desired generation. */
  readonly targetGeneration: number;
  readonly targetSourceOperationId: string;
}

type VersionForm =
  | typeof FORWARD_WORKER_VERSION_FORM_URL
  | typeof CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL;

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function generation(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Core's post-acceptance, read-only graph reader for a private Hosted Container
 * owner. The owner separately checks the native Version, Container and caller
 * liveness before it issues or uses any execution authority.
 */
export function createV2ForwardContainerBindingReader(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly workerBackendId: string;
  readonly containerBackendId: string;
  readonly authorize: (principal: string, space: string) => Promise<boolean>;
}) {
  if (
    !options?.sql ||
    typeof options.sql.query !== "function" ||
    !identity(options.targetKey) ||
    !identity(options.workerBackendId) ||
    !identity(options.containerBackendId) ||
    typeof options.authorize !== "function"
  ) {
    throw new TypeError("Forward Container binding reader requires trusted options");
  }
  // Capture trusted construction values; subsequent mutation of the options
  // object cannot retarget this reader.
  const query = options.sql.query.bind(options.sql);
  const indexSql = { query };
  const rawBatch: unknown = options.sql.batch;
  if (rawBatch !== undefined && typeof rawBatch !== "function")
    throw new TypeError("Forward Container read batch unavailable");
  const batch = typeof rawBatch === "function" ? rawBatch.bind(options.sql) : undefined;
  async function readBatch(
    statements: readonly SqlStatement[],
  ): Promise<readonly (readonly Row[])[]> {
    if (!batch)
      return Promise.all(statements.map((statement) => query(statement.sql, statement.params)));
    const results: unknown = await batch(statements);
    if (!Array.isArray(results) || results.length !== statements.length)
      throw new TypeError("incomplete Forward Container read batch");
    const rows: (readonly Row[])[] = [];
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      const resultRows: unknown = result?.rows;
      if (!result || typeof result !== "object" || !Array.isArray(resultRows))
        throw new TypeError("invalid Forward Container read result");
      for (let rowIndex = 0; rowIndex < resultRows.length; rowIndex++) {
        const row = resultRows[rowIndex];
        if (!row || typeof row !== "object" || Array.isArray(row))
          throw new TypeError("invalid Forward Container read row");
      }
      rows.push(resultRows);
    }
    return rows;
  }
  const { targetKey, workerBackendId, containerBackendId, authorize } = options;

  function targetStatement(
    claim: V2ForwardContainerBindingClaim,
    targetForm: string,
  ): SqlStatement {
    return {
      sql: `SELECT r.uid, r.principal, r.target_key, r.backend_id, r.phase,
                r.busy_operation, r.generation, r.observed_generation, r.observed_json,
                observed.id AS observed_operation_id,
                observed.result_observed_json AS source_result_observed_json,
                current.id AS current_operation_id, current.action AS current_action,
                current.status AS current_status, current.effect AS current_effect,
                current.dispatch_possible AS current_dispatch_possible,
                current.result_observed_json AS current_result_observed_json,
                current.result_output_json AS current_result_output_json
         FROM tf_v2_resources r
         JOIN tf_v2_operations observed INDEXED BY ${V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME}
           ON observed.resource_uid = r.uid
           AND observed.generation = r.observed_generation
         JOIN tf_v2_operations current ON current.id = r.last_operation
         JOIN tf_v2_resource_references edge ON edge.target_uid = r.uid
         WHERE edge.referrer_uid = ? AND r.uid = ? AND r.principal = ? AND r.space = ?
           AND r.target_key = ? AND r.backend_id = ? AND r.form_url = ?
           AND r.deleted_at IS NULL AND r.phase <> 'deleting'
           AND observed.principal = r.principal AND observed.target_key = r.target_key
           AND observed.backend_id = r.backend_id
           AND observed.action IN ('create','update') AND observed.status = 'succeeded'
           AND observed.effect = 'complete'
           AND current.resource_uid = r.uid AND current.principal = r.principal
           AND current.target_key = r.target_key AND current.backend_id = r.backend_id
           AND current.generation = r.generation AND current.accepted_spec_json = r.spec_json
         LIMIT 2`,
      params: [
        claim.workerVersionUid,
        claim.targetUid,
        claim.principal,
        claim.space,
        targetKey,
        containerBackendId,
        targetForm,
      ],
    };
  }

  async function exactReferences(
    operationIds: readonly string[],
    versionUid: string,
    spec: ReturnType<typeof parseForwardWorkerVersionSpec>,
    versionForm: VersionForm,
    claims: readonly V2ForwardContainerBindingClaim[],
  ): Promise<{
    readonly sealed: readonly { readonly resourceUid: string; readonly formUrl: string }[];
    readonly targets: readonly (readonly Row[])[] | undefined;
  } | null> {
    let expectedUids: readonly string[] | undefined;
    let sealed: { readonly resourceUid: string; readonly formUrl: string }[] = [];
    const ids = [...new Set(operationIds)];
    const statements: SqlStatement[] = ids.flatMap((operationId) => [
      {
        sql: "SELECT sealed FROM tf_v2_operation_reference_sets WHERE operation_id = ?",
        params: [operationId],
      },
      {
        sql: `SELECT target_uid, form_url, readiness, target_spec_path, target_spec_equals
         FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid`,
        params: [operationId],
      },
    ]);
    statements.push({
      sql: "SELECT target_uid FROM tf_v2_resource_references WHERE referrer_uid = ? ORDER BY target_uid",
      params: [versionUid],
    });
    if (versionForm === FORWARD_WORKER_VERSION_FORM_URL)
      statements.push(...claims.map((claim) => targetStatement(claim, C.formUrl)));
    const reads = await readBatch(statements);
    for (let index = 0; index < ids.length; index++) {
      const sets = reads[index * 2];
      const actual = reads[index * 2 + 1];
      if (sets?.length !== 1 || sets[0]?.sealed !== 1 || !actual) return null;
      const sealedTargets = actual.map((row) => {
        if (!identity(row.target_uid) || !identity(row.form_url))
          throw new TypeError("invalid sealed reference");
        return { resourceUid: row.target_uid, formUrl: row.form_url };
      });
      // A resource's Form is immutable and the Core schema forces each sealed Form to equal the
      // live Form, so every Operation of this Version seals the same target Forms.
      sealed = sealedTargets;
      const references =
        versionForm === CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL
          ? referencesForContainerConsumerWorkerVersion(spec, sealedTargets)
          : referencesForForwardWorkerVersion(spec, sealedTargets);
      const expected = references.map((ref) => ({
        target_uid: ref.resourceUid,
        form_url: ref.formUrl,
        readiness: ref.readiness,
        target_spec_path: ref.targetSpecMatch ? `$.${ref.targetSpecMatch.path.join(".")}` : null,
        target_spec_equals: ref.targetSpecMatch?.equals ?? null,
      }));
      if (canonicalJson(actual) !== canonicalJson(expected)) return null;
      const uids = expected.map((ref) => ref.target_uid);
      if (expectedUids && canonicalJson(expectedUids) !== canonicalJson(uids)) return null;
      expectedUids = uids;
    }
    if (!expectedUids) return null;
    const edges = reads[ids.length * 2];
    return canonicalJson(edges) ===
      canonicalJson(expectedUids.map((target_uid) => ({ target_uid })))
      ? {
          sealed,
          targets:
            versionForm === FORWARD_WORKER_VERSION_FORM_URL
              ? reads.slice(ids.length * 2 + 1)
              : undefined,
        }
      : null;
  }

  /** Keep an observed source only through Core states known to have no later effect. */
  async function knownCurrentTail(
    row: Readonly<Record<string, unknown>>,
    observedOperationId: string,
    tailQuery: Sql["query"] = query,
  ): Promise<boolean> {
    if (
      !identity(row.uid) ||
      !identity(row.principal) ||
      !identity(row.target_key) ||
      !identity(row.backend_id) ||
      !identity(row.current_operation_id) ||
      !generation(row.generation) ||
      !generation(row.observed_generation) ||
      row.observed_generation > row.generation ||
      typeof row.observed_json !== "string" ||
      typeof row.source_result_observed_json !== "string" ||
      row.observed_json !== row.source_result_observed_json
    )
      return false;
    if (row.generation === row.observed_generation) {
      return (
        row.current_operation_id === observedOperationId &&
        row.current_action !== "delete" &&
        row.current_status === "succeeded" &&
        row.current_effect === "complete" &&
        row.phase === "idle" &&
        row.busy_operation === null
      );
    }
    if (row.current_action !== "update") return false;
    const pending =
      (row.current_status === "queued" || row.current_status === "waiting_input") &&
      row.current_effect === "none" &&
      row.current_dispatch_possible === 0 &&
      row.current_result_observed_json === null &&
      row.current_result_output_json === null &&
      row.phase === "pending" &&
      row.busy_operation === row.current_operation_id;
    const failedNoEffect =
      row.current_status === "failed" &&
      row.current_effect === "none" &&
      row.current_result_observed_json === null &&
      row.current_result_output_json === null &&
      row.phase === "error" &&
      row.busy_operation === null;
    if (!pending && !failedNoEffect) return false;
    const count = row.generation - row.observed_generation;
    if (count - (pending ? 1 : 0) > MAX_FAILED_TAIL) return false;

    // A later failed/none Operation cannot erase an earlier partial or
    // unknown effect. Count the full generation interval, including the latest
    // Operation, so gaps and duplicate generations also fail closed.
    const tails = await tailQuery(
      `SELECT COUNT(*) AS operation_count, COUNT(DISTINCT generation) AS distinct_generations,
              MIN(generation) AS first_generation, MAX(generation) AS last_generation,
              SUM(CASE WHEN generation < ? AND
                (action <> 'update' OR status <> 'failed' OR effect <> 'none'
                 OR principal <> ? OR target_key <> ? OR backend_id <> ?
                 OR result_observed_json IS NOT NULL OR result_output_json IS NOT NULL)
                THEN 1 ELSE 0 END) AS invalid_prior
       FROM tf_v2_operations INDEXED BY ${V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME}
       WHERE resource_uid = ? AND generation > ? AND generation <= ?`,
      [
        row.generation,
        row.principal,
        row.target_key,
        row.backend_id,
        row.uid,
        row.observed_generation,
        row.generation,
      ],
    );
    const tail = tails.length === 1 ? tails[0] : null;
    return (
      tail?.operation_count === count &&
      tail.distinct_generations === count &&
      tail.first_generation === row.observed_generation + 1 &&
      tail.last_generation === row.generation &&
      tail.invalid_prior === 0
    );
  }

  const readMany = async (
    inputs: readonly V2ForwardContainerBindingClaim[],
  ): Promise<readonly V2ForwardContainerBindingSnapshot[] | null> => {
    // A bulk accepted-data read has one owner and immutable Version coordinate.
    // Snapshot every binding before authorization; mixed owners/Versions and
    // duplicate names never gain authority through batching.
    let claims: V2ForwardContainerBindingClaim[];
    try {
      if (!Array.isArray(inputs)) return null;
      const count = inputs.length;
      if (!Number.isSafeInteger(count) || count < 1 || count > MAX_WORKER_BINDINGS_PER_KIND)
        return null;
      claims = Array.from({ length: count }, (_, index) => {
        const input = inputs[index];
        if (!input) throw new TypeError("missing Forward Container claim");
        return {
          principal: input.principal,
          space: input.space,
          workerVersionUid: input.workerVersionUid,
          workerVersionGeneration: input.workerVersionGeneration,
          operationId: input.operationId,
          bindingName: input.bindingName,
          targetUid: input.targetUid,
        };
      });
      if (
        claims.some(
          (claim) =>
            !identity(claim.principal) ||
            !identity(claim.space) ||
            !identity(claim.workerVersionUid) ||
            !generation(claim.workerVersionGeneration) ||
            !identity(claim.operationId) ||
            !identity(claim.bindingName) ||
            !identity(claim.targetUid),
        )
      )
        return null;
    } catch {
      return null;
    }
    const claim = claims[0];
    if (
      !claim ||
      new Set(claims.map((item) => item.bindingName)).size !== claims.length ||
      claims.some(
        (item) =>
          item.principal !== claim.principal ||
          item.space !== claim.space ||
          item.workerVersionUid !== claim.workerVersionUid ||
          item.workerVersionGeneration !== claim.workerVersionGeneration ||
          item.operationId !== claim.operationId,
      )
    )
      return null;
    const targetClaims = [...new Map(claims.map((item) => [item.targetUid, item])).values()];
    try {
      if (!(await authorize(claim.principal, claim.space))) return null;
      if (!(await hasV2ForwardContainerOperationGenerationIndex(indexSql))) return null;
      const versions = await query(
        `SELECT r.uid, r.form_url, r.principal, r.target_key, r.backend_id, r.phase,
                r.busy_operation, r.generation, r.observed_generation, r.spec_json,
                r.observed_json, source.generation AS source_generation,
                source.accepted_spec_json,
                source.result_observed_json AS source_result_observed_json,
                current.id AS current_operation_id, current.action AS current_action,
                current.status AS current_status, current.effect AS current_effect,
                current.dispatch_possible AS current_dispatch_possible,
                current.result_observed_json AS current_result_observed_json,
                current.result_output_json AS current_result_output_json
         FROM tf_v2_resources r
         JOIN tf_v2_operations source ON source.id = ? AND source.resource_uid = r.uid
         JOIN tf_v2_operations current ON current.id = r.last_operation
         WHERE r.uid = ? AND r.principal = ? AND r.space = ? AND r.target_key = ?
           AND r.backend_id = ? AND r.form_url IN (?, ?) AND r.deleted_at IS NULL
           AND r.phase <> 'deleting'
           AND source.principal = r.principal AND source.target_key = r.target_key
           AND source.backend_id = r.backend_id AND source.generation = ?
           AND source.action IN ('create','update') AND source.status = 'succeeded'
           AND source.effect = 'complete' AND source.accepted_spec_json = r.spec_json
           AND current.resource_uid = r.uid AND current.principal = r.principal
           AND current.target_key = r.target_key AND current.backend_id = r.backend_id
           AND current.generation = r.generation AND current.accepted_spec_json = r.spec_json
         LIMIT 2`,
        [
          claim.operationId,
          claim.workerVersionUid,
          claim.principal,
          claim.space,
          targetKey,
          workerBackendId,
          FORWARD_WORKER_VERSION_FORM_URL,
          CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
          claim.workerVersionGeneration,
        ],
      );
      const version = versions.length === 1 ? versions[0] : null;
      const versionForm = version?.form_url;
      if (
        !version ||
        (versionForm !== FORWARD_WORKER_VERSION_FORM_URL &&
          versionForm !== CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL) ||
        !generation(version.generation) ||
        !generation(version.observed_generation) ||
        version.source_generation !== claim.workerVersionGeneration ||
        version.observed_generation !== claim.workerVersionGeneration ||
        !identity(version.current_operation_id) ||
        typeof version.accepted_spec_json !== "string" ||
        typeof version.observed_json !== "string" ||
        !(await knownCurrentTail(version, claim.operationId))
      )
        return null;
      const spec = parseForwardWorkerVersionSpec(JSON.parse(version.accepted_spec_json));
      if (
        !isReadyWorkerVersionObservation(
          JSON.parse(version.observed_json),
          spec.bundle !== undefined,
        ) ||
        !claims.every((claim) =>
          spec.containerBindings.some(
            (binding) =>
              binding.name === claim.bindingName &&
              binding.resource.resourceUid === claim.targetUid,
          ),
        )
      )
        return null;
      const sealed = await exactReferences(
        [claim.operationId, version.current_operation_id],
        claim.workerVersionUid,
        spec,
        versionForm,
        targetClaims,
      );
      if (!sealed) return null;
      const forms = targetClaims.map((claim) => {
        const matches = sealed.sealed.filter((row) => row.resourceUid === claim.targetUid);
        return versionForm === FORWARD_WORKER_VERSION_FORM_URL
          ? C.formUrl
          : matches.length === 1 && isContainerConsumerTargetFormUrl(matches[0]?.formUrl)
            ? matches[0].formUrl
            : null;
      });
      if (forms.some((form) => form === null)) return null;
      const targetReads =
        sealed.targets ??
        (await readBatch(
          targetClaims.map((claim, index) => targetStatement(claim, forms[index] as string)),
        ));
      if (targetReads.length !== targetClaims.length) return null;
      const targets = targetReads.map((rows) => (rows.length === 1 ? rows[0] : null));
      if (
        targets.some(
          (target) =>
            !target ||
            !generation(target.observed_generation) ||
            !identity(target.observed_operation_id) ||
            typeof target.observed_json !== "string",
        )
      )
        return null;
      // Keep all original no-effect-tail predicates. Only independent tail
      // SELECTs within this same bounded read are submitted together.
      const tailPlans: { statement: SqlStatement; resolve(rows: readonly Row[]): void }[] = [];
      let collecting = true;
      const tailChecks = Promise.all(
        targets.map((target) =>
          knownCurrentTail(target as Row, String(target?.observed_operation_id), (sql, params) =>
            !collecting
              ? Promise.resolve([])
              : new Promise((resolve) =>
                  tailPlans.push({ statement: { sql, ...(params ? { params } : {}) }, resolve }),
                ),
          ),
        ),
      );
      collecting = false;
      // A future asynchronous prelude cannot enqueue work after submission.
      // Observe rejection immediately while the independent batch is pending.
      void tailChecks.catch(() => {});
      try {
        const tailRows = tailPlans.length
          ? await readBatch(tailPlans.map((plan) => plan.statement))
          : [];
        for (const [index, plan] of tailPlans.entries()) plan.resolve(tailRows[index] ?? []);
      } catch {
        for (const plan of tailPlans) plan.resolve([]);
      }
      if (!(await tailChecks).every(Boolean)) return null;
      const byUid = new Map<string, { target: Row; form: string }>();
      for (const [index, target] of targets.entries()) {
        const targetClaim = targetClaims[index],
          targetForm = forms[index];
        if (!target || !targetClaim || !targetForm) return null;
        const observation: unknown = JSON.parse(String(target.observed_json));
        if (
          !observation ||
          typeof observation !== "object" ||
          Array.isArray(observation) ||
          (observation as Record<string, unknown>)[C.fields.ready] !== true ||
          (observation as Record<string, unknown>)[C.fields.servingGeneration] !==
            target.observed_generation
        )
          return null;
        byUid.set(targetClaim.targetUid, { target, form: targetForm });
      }
      return claims.map((claim) => {
        const selected = byUid.get(claim.targetUid);
        if (!selected) throw new TypeError("missing accepted Container target");
        return {
          principal: claim.principal,
          space: claim.space,
          targetKey,
          workerVersionUid: claim.workerVersionUid,
          workerVersionFormUrl: versionForm,
          workerVersionGeneration: claim.workerVersionGeneration,
          sourceOperationId: claim.operationId,
          targetUid: claim.targetUid,
          targetFormUrl: selected.form as V2ForwardContainerBindingSnapshot["targetFormUrl"],
          targetGeneration: selected.target.observed_generation as number,
          targetSourceOperationId: selected.target.observed_operation_id as string,
        };
      });
    } catch {
      return null;
    }
  };
  const readOne = async (
    input: V2ForwardContainerBindingClaim,
  ): Promise<V2ForwardContainerBindingSnapshot | null> => (await readMany([input]))?.[0] ?? null;
  return Object.assign(readOne, { readMany });
}
