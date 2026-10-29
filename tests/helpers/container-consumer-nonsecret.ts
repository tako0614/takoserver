import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { CONTAINER_CONTRACT as C } from "../../src/container-contract.ts";
import type { JsonObject, Sql } from "../../src/ports.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../../src/takoform-v2/engine.ts";
import {
  fixedReferencesForContainerConsumerWorkerVersion,
  prepareContainerConsumerWorkerVersionReferences,
} from "../../src/takoform-v2/forms/container-consumer-references.ts";
import {
  CONTAINER_0_2_FORM_URL,
  CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
  parseContainerConsumerWorkerVersionSpec,
  validateContainerConsumerWorkerVersionUpdate,
} from "../../src/takoform-v2/forms/container-consumer-specs.ts";
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
import { V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_SQL } from "../../src/takoform-v2/operation-generation-index.ts";
import type { V2Execution } from "../../src/takoform-v2/types.ts";

/** Registered only so a Container-kind but unlisted Form version can be created and refused. */
export const CONTAINER_0_3_FORM_URL = "https://edge.forms.takoform.com/forms/Container/0.3.0/";
export const PRINCIPAL = "alice";
export const SPACE = "space";
export const TARGET = "private-hosted-target";
export const WORKER_BACKEND = "private-hosted-forward-version";
export const CONTAINER_BACKEND = "private-hosted-container";

/**
 * Real v2 engine, real migrations and the real binding reader over in-memory SQLite.
 * The Form backends only complete synchronously and report a ready Container with a
 * serving generation; they are acceptance mechanics, not native qualification.
 */
export async function containerConsumerFixture() {
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
  await sql.run(V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_SQL);
  const backend = (id: string, observed: JsonObject = {}) => ({
    id,
    targetKey: TARGET,
    execute: async (input: V2Execution) => ({
      kind: "complete" as const,
      observed:
        id === CONTAINER_BACKEND ? { ready: true, servingGeneration: input.generation } : observed,
      output: {},
    }),
    reconcile: async () => ({ kind: "unknown" as const }),
  });
  const metadata = (id: string, observed: JsonObject = {}) => ({
    validateCreate: () => undefined,
    validateUpdate: () => undefined,
    backend: backend(id, observed),
  });
  const versionObserved = { ready: true, resolvedBindings: true, bundleVerified: true };
  const engine = createTakoformV2Engine({
    sql,
    now: () => new Date("2026-10-27T00:00:00.000Z"),
    replayWindowSeconds: 3600,
    authorize: async () => true,
    forms: {
      [MODULE_WORKER_FORM_URL]: metadata("fixture-worker"),
      [WORKER_BUNDLE_FORM_URL]: metadata("fixture-bundle"),
      [C.formUrl]: metadata(CONTAINER_BACKEND),
      [CONTAINER_0_2_FORM_URL]: metadata(CONTAINER_BACKEND),
      [CONTAINER_0_3_FORM_URL]: metadata(CONTAINER_BACKEND),
      // Existing forward Version 0.7.0: byte-for-byte the previous registration.
      [FORWARD_WORKER_VERSION_FORM_URL]: {
        validateCreate: parseForwardWorkerVersionSpec,
        validateUpdate: validateForwardWorkerVersionUpdate,
        references: (spec) =>
          fixedReferencesForForwardWorkerVersion(parseForwardWorkerVersionSpec(spec)),
        prepareAdmission: prepareForwardWorkerVersionReferences,
        backend: backend(WORKER_BACKEND, versionObserved),
      },
      // New Version 0.8.0 on the same private backend identity.
      [CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL]: {
        validateCreate: parseContainerConsumerWorkerVersionSpec,
        validateUpdate: validateContainerConsumerWorkerVersionUpdate,
        references: (spec) =>
          fixedReferencesForContainerConsumerWorkerVersion(
            parseContainerConsumerWorkerVersionSpec(spec),
          ),
        prepareAdmission: prepareContainerConsumerWorkerVersionReferences,
        backend: backend(WORKER_BACKEND, versionObserved),
      },
    },
  });
  let serial = 0;
  const create = async (form: string, name: string, spec: JsonObject = {}) => {
    const op = await engine.acceptCreate({
      principal: PRINCIPAL,
      key: `container-consumer-${++serial}-create-key`,
      input: { form, space: SPACE, name, spec },
    });
    expect((await engine.runNext())?.status).toBe("succeeded");
    return op;
  };
  /** Accept a create that must be refused, returning the engine's refusal. */
  const refuse = async (form: string, name: string, spec: JsonObject) => {
    try {
      await engine.acceptCreate({
        principal: PRINCIPAL,
        key: `container-consumer-${++serial}-refused-key`,
        input: { form, space: SPACE, name, spec },
      });
      return null;
    } catch (error) {
      return error;
    }
  };
  let allowed = true;
  const reader = createV2ForwardContainerBindingReader({
    sql: sql as Sql,
    targetKey: TARGET,
    workerBackendId: WORKER_BACKEND,
    containerBackendId: CONTAINER_BACKEND,
    authorize: async () => allowed,
  });
  const claimFor = (
    version: { resourceUid: string; id: string },
    bindingName: string,
    targetUid: string,
    workerVersionGeneration = 1,
  ) => ({
    principal: PRINCIPAL,
    space: SPACE,
    workerVersionUid: version.resourceUid,
    workerVersionGeneration,
    operationId: version.id,
    bindingName,
    targetUid,
  });
  return {
    db,
    sql,
    engine,
    reader,
    create,
    refuse,
    claimFor,
    setAllowed(value: boolean) {
      allowed = value;
    },
    count(table: string, where = "1=1", params: unknown[] = []): number {
      return (
        db
          .query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
          .get(...(params as never[])) as {
          n: number;
        }
      ).n;
    },
    close() {
      db.close();
    },
  };
}
