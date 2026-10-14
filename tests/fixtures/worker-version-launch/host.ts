import { Database } from "bun:sqlite";
import { migrateSqlite } from "../../../src/migrate-sqlite.ts";
import type { JsonObject, JsonValue } from "../../../src/ports.ts";
import { createSqliteSql } from "../../../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../../../src/takoform-v2/engine.ts";
import { ACTOR_NAMESPACE_FORM_URL } from "../../../src/takoform-v2/forms/actor-namespace.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "../../../src/takoform-v2/forms/at-least-once-queue.ts";
import { DURABLE_WORKFLOW_FORM_URL } from "../../../src/takoform-v2/forms/durable-workflow.ts";
import { EDGE_KV_NAMESPACE_FORM_URL } from "../../../src/takoform-v2/forms/edge-kv-namespace.ts";
import { OBJECT_BUCKET_FORM_URL } from "../../../src/takoform-v2/forms/object-bucket.ts";
import { SQLITE_DATABASE_FORM_URL } from "../../../src/takoform-v2/forms/sqlite-database.ts";
import { WORKER_BUNDLE_FORM_URL } from "../../../src/takoform-v2/forms/worker-bundle.ts";
import { referencesForWorkerVersion } from "../../../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseWorkerVersionSpec,
  validateWorkerVersionUpdate,
  WORKER_VERSION_FORM_URL,
} from "../../../src/takoform-v2/forms/worker-specs.ts";
import type {
  V2Backend,
  V2Execution,
  V2Form,
  V2Operation,
} from "../../../src/takoform-v2/types.ts";

export const MOCK_BINDING_TARGETS = {
  kvBindings: { form: EDGE_KV_NAMESPACE_FORM_URL, name: "CACHE" },
  sqliteBindings: { form: SQLITE_DATABASE_FORM_URL, name: "DB" },
  bucketBindings: { form: OBJECT_BUCKET_FORM_URL, name: "BUCKET" },
  queueProducerBindings: { form: AT_LEAST_ONCE_QUEUE_FORM_URL, name: "QUEUE" },
  serviceBindings: { form: MODULE_WORKER_FORM_URL, name: "SERVICE" },
  actorBindings: { form: ACTOR_NAMESPACE_FORM_URL, name: "ACTOR" },
  workflowBindings: { form: DURABLE_WORKFLOW_FORM_URL, name: "WORKFLOW" },
} as const;

/** Real Core acceptance and custody with mock backend effects; no Worker execution. */
export function createWorkerVersionLaunchMock(options: { loseVersionCreateAck?: boolean } = {}) {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  let clockMs = Date.now();
  let keySequence = 0;
  const effects: { mode: "execute" | "reconcile"; execution: V2Execution }[] = [];
  const backend: V2Backend = {
    id: "fixture-worker-version-launch",
    targetKey: "fixture-worker-version-launch-target",
    async execute(execution) {
      effects.push({ mode: "execute", execution });
      if (
        options.loseVersionCreateAck &&
        execution.form === WORKER_VERSION_FORM_URL &&
        execution.action === "create"
      ) {
        return { kind: "unknown" };
      }
      return { kind: "complete", observed: { fixtureOnly: true }, output: {} };
    },
    async reconcile(execution) {
      effects.push({ mode: "reconcile", execution });
      return { kind: "complete", observed: { fixtureOnly: true }, output: {} };
    },
  };
  const targetForm: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    backend,
  };
  const versionForm: V2Form = {
    validateCreate: parseWorkerVersionSpec,
    validateUpdate: validateWorkerVersionUpdate,
    references: (spec) => referencesForWorkerVersion(parseWorkerVersionSpec(spec)),
    rejectDeleteWhileReferenced: true,
    backend,
  };
  const targets: Record<string, V2Form> = {
    [MODULE_WORKER_FORM_URL]: targetForm,
    [WORKER_BUNDLE_FORM_URL]: targetForm,
    ...Object.fromEntries(
      Object.values(MOCK_BINDING_TARGETS).map(({ form }) => [form, targetForm]),
    ),
  };
  const engineFor = (retainedBackend?: V2Backend) =>
    createTakoformV2Engine({
      sql,
      now: () => new Date(clockMs),
      replayWindowSeconds: 3_600,
      leaseMilliseconds: 1_000,
      authorize: async (principal, space) =>
        (principal === "org:fixture" || principal === "org:other") &&
        (space === "fixture" || space === "other-space"),
      forms: retainedBackend ? targets : { ...targets, [WORKER_VERSION_FORM_URL]: versionForm },
      ...(retainedBackend
        ? {
            retainedForms: {
              [WORKER_VERSION_FORM_URL]: {
                ...versionForm,
                validateCreate() {
                  throw new Error("retained-only create validation must not run");
                },
                validateUpdate() {
                  throw new Error("retained-only update validation must not run");
                },
                backend: retainedBackend,
              },
            },
          }
        : {}),
    });
  const engine = engineFor();
  async function create(form: string, name: string, spec: JsonObject = {}, space = "fixture") {
    const accepted = await engine.acceptCreate({
      principal: "org:fixture",
      key: `launch-mock-create-${++keySequence}`,
      input: { form, name, space, spec },
    });
    const settled = await engine.runNext();
    if (settled?.id !== accepted.id || settled.status !== "succeeded") {
      throw new Error("mock target did not settle its exact operation");
    }
    return accepted;
  }
  async function seed() {
    const worker = await create(MODULE_WORKER_FORM_URL, "worker");
    const bundle = await create(WORKER_BUNDLE_FORM_URL, "bundle");
    const spec: Record<string, JsonValue> = {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch", "queue", "scheduled"],
    };
    const bindings: Record<string, V2Operation> = {};
    for (const [key, { form, name }] of Object.entries(MOCK_BINDING_TARGETS)) {
      const target = await create(form, key);
      bindings[key] = target;
      spec[key] = [{ name, resource: { resourceUid: target.resourceUid } }];
    }
    return { worker, bundle, bindings, spec };
  }
  return {
    database,
    sql,
    engine,
    backend,
    effects,
    create,
    seed,
    retainedEngine: (selected: V2Backend = backend) => engineFor(selected),
    advance: () => {
      clockMs += 2_000;
    },
    close: () => database.close(),
  };
}
