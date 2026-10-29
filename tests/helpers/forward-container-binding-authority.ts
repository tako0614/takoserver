import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { CONTAINER_CONTRACT as C } from "../../src/container-contract.ts";
import type { JsonObject, Sql } from "../../src/ports.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../../src/takoform-v2/engine.ts";
import {
  OBJECT_BUCKET_EOF_COUNTED_FORM_URL,
  OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL,
} from "../../src/takoform-v2/forms/object-bucket-binding-profile.ts";
import { WORKER_BUNDLE_FORM_URL } from "../../src/takoform-v2/forms/worker-bundle.ts";
import {
  fixedReferencesForForwardWorkerVersion,
  prepareForwardWorkerVersionReferences,
} from "../../src/takoform-v2/forms/worker-references.ts";
import {
  FORWARD_WORKER_VERSION_FORM_URL,
  MODULE_WORKER_FORM_URL,
  parseForwardWorkerVersionSpec,
  validateForwardWorkerVersionUpdate,
} from "../../src/takoform-v2/forms/worker-specs.ts";
import { createV2ForwardContainerBindingReader } from "../../src/takoform-v2/index.ts";
import {
  V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME,
  V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_SQL,
} from "../../src/takoform-v2/operation-generation-index.ts";
import type { V2Execution } from "../../src/takoform-v2/types.ts";

export const PRINCIPAL = "alice";
export const SPACE = "space";
export const TARGET = "private-hosted-target";
export const WORKER_BACKEND = "private-hosted-forward-version";
export const CONTAINER_BACKEND = "private-hosted-container";
type UpdateOutcome = "complete" | "none" | "partial" | "unknown";

/** Core acceptance mechanics only: these backends are not native qualification. */
export async function fixture(
  options: { installIndex?: boolean; bindingCount?: number; distinctTargets?: boolean } = {},
) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0070_takoform_v2.sql",
    "0071_v2_sqlite_migration_set_custody.sql",
    "0073_v2_reference_acceptance.sql",
    "0081_v2_private_inputs.sql",
  ])
    db.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  const sql = createSqliteSql(db);
  if (options.installIndex !== false)
    await sql.run(V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_SQL);
  let containerUpdateOutcome: UpdateOutcome = "complete";
  let versionUpdateOutcome: UpdateOutcome = "complete";
  const backend = (id: string, observed: JsonObject = {}) => ({
    id,
    targetKey: TARGET,
    execute: async (input: V2Execution) => {
      const outcome =
        input.action === "update"
          ? id === CONTAINER_BACKEND
            ? containerUpdateOutcome
            : id === WORKER_BACKEND
              ? versionUpdateOutcome
              : "complete"
          : "complete";
      if (outcome === "none")
        return { kind: "no_effect" as const, code: "fixture_no_effect", message: "fixture" };
      if (outcome === "unknown")
        return { kind: "unknown" as const, code: "fixture_unknown", message: "fixture" };
      if (outcome === "partial")
        return {
          kind: "partial" as const,
          code: "fixture_partial",
          message: "fixture",
          observed: id === CONTAINER_BACKEND ? { ready: true, servingGeneration: 1 } : observed,
        };
      return {
        kind: "complete" as const,
        observed:
          id === CONTAINER_BACKEND
            ? { ready: true, servingGeneration: input.generation }
            : observed,
        output: {},
      };
    },
    reconcile: async () => ({ kind: "unknown" as const }),
  });
  const metadata = (id: string, observed: JsonObject = {}) => ({
    validateCreate: () => undefined,
    validateUpdate: () => undefined,
    backend: backend(id, observed),
  });
  const engine = createTakoformV2Engine({
    sql,
    now: () => new Date("2026-10-22T00:00:00.000Z"),
    replayWindowSeconds: 3600,
    authorize: async () => true,
    forms: {
      [MODULE_WORKER_FORM_URL]: metadata("fixture-worker"),
      [WORKER_BUNDLE_FORM_URL]: metadata("fixture-bundle"),
      [C.formUrl]: metadata(CONTAINER_BACKEND),
      [OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL]: metadata("fixture-bucket-a", { ready: true }),
      [OBJECT_BUCKET_EOF_COUNTED_FORM_URL]: metadata("fixture-bucket-b", { ready: true }),
      [FORWARD_WORKER_VERSION_FORM_URL]: {
        validateCreate: parseForwardWorkerVersionSpec,
        validateUpdate: validateForwardWorkerVersionUpdate,
        references: (spec) =>
          fixedReferencesForForwardWorkerVersion(parseForwardWorkerVersionSpec(spec)),
        prepareAdmission: prepareForwardWorkerVersionReferences,
        backend: backend(WORKER_BACKEND, {
          ready: true,
          resolvedBindings: true,
          bundleVerified: true,
        }),
      },
    },
  });
  let serial = 0;
  const create = async (form: string, name: string, spec: JsonObject = {}) => {
    const op = await engine.acceptCreate({
      principal: PRINCIPAL,
      key: `forward-container-${++serial}-create-key`,
      input: { form, space: SPACE, name, spec },
    });
    expect((await engine.runNext())?.status).toBe("succeeded");
    return op;
  };
  const worker = await create(MODULE_WORKER_FORM_URL, "worker");
  const bundle = await create(WORKER_BUNDLE_FORM_URL, "bundle");
  const container = await create(C.formUrl, "container");
  const bucketA = await create(OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL, "bucket-a");
  const bucketB = await create(OBJECT_BUCKET_EOF_COUNTED_FORM_URL, "bucket-b");
  const extraBucket = await create(OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL, "extra-bucket");
  const containers = [container];
  if (options.distinctTargets)
    for (let i = 1; i < (options.bindingCount ?? 1); i++)
      containers.push(await create(C.formUrl, `container-${i}`));
  const spec = {
    worker: { resourceUid: worker.resourceUid },
    bundle: { resourceUid: bundle.resourceUid },
    handlers: ["fetch"],
    bucketBindings: [
      { name: "A", resource: { resourceUid: bucketA.resourceUid } },
      { name: "B", resource: { resourceUid: bucketB.resourceUid } },
    ],
    containerBindings: Array.from({ length: options.bindingCount ?? 1 }, (_, index) => ({
      name: index === 0 ? "APP" : `APP${index}`,
      resource: { resourceUid: (containers[index] ?? container).resourceUid },
    })),
  };
  const version = await create(FORWARD_WORKER_VERSION_FORM_URL, "version", spec);
  const claim = {
    principal: PRINCIPAL,
    space: SPACE,
    workerVersionUid: version.resourceUid,
    workerVersionGeneration: 1,
    operationId: version.id,
    bindingName: "APP",
    targetUid: container.resourceUid,
  };
  let allowed = true;
  let graphLookups = 0;
  let indexedTailQueries = 0;
  const readerSql: Sql = {
    ...sql,
    async batch(statements) {
      for (const { sql: statement } of statements) {
        if (statement.includes("FROM tf_v2_resources")) graphLookups += 1;
        if (
          statement.includes("COUNT(DISTINCT generation)") &&
          statement.includes(`INDEXED BY ${V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME}`)
        )
          indexedTailQueries += 1;
      }
      return sql.batch(statements);
    },
    async query(statement, params) {
      if (statement.includes("FROM tf_v2_resources")) graphLookups += 1;
      if (
        statement.includes("COUNT(DISTINCT generation)") &&
        statement.includes(`INDEXED BY ${V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME}`)
      )
        indexedTailQueries += 1;
      return sql.query(statement, params);
    },
  };
  const reader = createV2ForwardContainerBindingReader({
    sql: readerSql,
    targetKey: TARGET,
    workerBackendId: WORKER_BACKEND,
    containerBackendId: CONTAINER_BACKEND,
    authorize: async () => allowed,
  });
  return {
    db,
    sql,
    engine,
    reader,
    claim,
    spec,
    version,
    container,
    bucketA,
    extraBucket,
    create,
    setContainerUpdateOutcome(value: UpdateOutcome) {
      containerUpdateOutcome = value;
    },
    setVersionUpdateOutcome(value: UpdateOutcome) {
      versionUpdateOutcome = value;
    },
    setAllowed(value: boolean) {
      allowed = value;
    },
    graphLookups() {
      return graphLookups;
    },
    indexedTailQueries() {
      return indexedTailQueries;
    },
    close() {
      db.close();
    },
  };
}
