import { Database } from "bun:sqlite";
import { createActorResourceGraphReader } from "../../src/actor-resource-graph.ts";
import { MIGRATIONS } from "../../src/db-schema.ts";
import type { Sql } from "../../src/ports.ts";
import { createResourceDeploymentStore } from "../../src/resource-deployments.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { stableProductionTakoformCatalog } from "../../src/takoform/stable-production-catalog.ts";
import { createTakoformStore } from "../../src/takoform/store.ts";
import type { InstalledTakoformForm, TakoformStoredResource } from "../../src/takoform/types.ts";

const forms = stableProductionTakoformCatalog().forms;
function requiredForm(kind: string): InstalledTakoformForm {
  const form = forms.find((candidate) => candidate.identity.formRef.kind === kind);
  if (!form) throw new Error(`missing published ${kind} Form`);
  return form;
}
export const actorForm = requiredForm("ActorNamespace");
export const workerForm = requiredForm("ModuleWorker");
export const scope = { tenantId: "tenant-actor", namespaceResourceUid: "namespace-uid" };

export function resource(
  form: InstalledTakoformForm,
  name: string,
  uid: string,
): TakoformStoredResource {
  return {
    apiVersion: form.identity.formRef.apiVersion,
    kind: form.identity.formRef.kind,
    form: structuredClone(form.identity),
    metadata: { name, uid, space: "default", generation: "3", revision: "7" },
    spec:
      form === actorForm
        ? {
            className: "Counter",
            worker: {
              apiVersion: workerForm.identity.formRef.apiVersion,
              kind: "ModuleWorker",
              name: "worker",
            },
          }
        : {},
    status: { observedGeneration: "0", conditions: [] },
  };
}

export function insert(
  database: Database,
  stored: TakoformStoredResource,
  relations: unknown[],
  tenant = scope.tenantId,
): void {
  const { metadata } = stored;
  database
    .query(`INSERT INTO tf_resources
    (tenant_id, space, api_version, kind, name, uid, generation, revision, resource_json, relations_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      tenant,
      metadata.space,
      stored.apiVersion,
      stored.kind,
      metadata.name,
      metadata.uid,
      metadata.generation,
      metadata.revision,
      JSON.stringify(stored),
      JSON.stringify(relations),
      1000,
    );
  database
    .query(`INSERT INTO tf_resource_deletion_attestations
    (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json, state, closure_fence, effects_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'live', 1, '[]', 1000, 1000)`)
    .run(
      tenant,
      metadata.uid,
      metadata.space,
      stored.apiVersion,
      stored.kind,
      metadata.name,
      JSON.stringify(stored.form.formRef),
    );
}

export function fixture(
  change?: (source: TakoformStoredResource, target: TakoformStoredResource) => void,
) {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS) database.exec(migration.sql);
  const source = resource(actorForm, "counter", scope.namespaceResourceUid);
  const target = resource(workerForm, "worker", "worker-uid");
  change?.(source, target);
  const relation = {
    pointer: "/worker",
    relation: "/worker",
    targetApiVersion: target.apiVersion,
    targetKind: target.kind,
    targetName: target.metadata.name,
    targetUid: target.metadata.uid,
    targetRevision: "old-revision",
    targetFormRef: target.form.formRef,
  };
  insert(database, source, [relation]);
  insert(database, target, []);
  const backing = createSqliteSql(database);
  let queries = 0;
  const sql: Sql = {
    query(statement, params) {
      queries += 1;
      return backing.query(statement, params);
    },
    run: backing.run,
    batch: backing.batch,
  };
  const store = createTakoformStore(sql, () => new Date(1000));
  const read = createActorResourceGraphReader({ store, form: actorForm });
  const deployments = createResourceDeploymentStore(backing, () => new Date(1000));
  return {
    database,
    store,
    deployments,
    read,
    source,
    target,
    relation,
    queryCount: () => queries,
  };
}
