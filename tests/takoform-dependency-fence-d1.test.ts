import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import {
  TAKOFORM_APPLY_SELECTION_VERSION,
  type TakoformApplySelection,
} from "../src/takoform/apply-selection.ts";
import {
  createResourceDependencySet,
  resourceDependencyClaimKeys,
} from "../src/takoform/dependency-fence.ts";
import type { TakoformStoredRelation } from "../src/takoform/relations.ts";
import { createTakoformStore, type ProviderMutationSaga } from "../src/takoform/store.ts";
import type { TakoformStoredResource, TakoformV1Alpha3FormRef } from "../src/takoform/types.ts";

const TENANT_ID = "tenant-d1-dependency-fence";
const SPACE = "main";
const NOW = Date.parse("2026-09-08T00:00:00.000Z");
const TARGET_FORM_REF: TakoformV1Alpha3FormRef = {
  apiVersion: "example.forms.invalid/v1",
  kind: "DependencyTarget",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
};
const SOURCE_FORM_REF: TakoformV1Alpha3FormRef = {
  apiVersion: "example.forms.invalid/v1",
  kind: "DependencyHolder",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"b".repeat(64)}`,
};
const APPLY_SELECTION: TakoformApplySelection = {
  version: TAKOFORM_APPLY_SELECTION_VERSION,
  kind: "provider",
  providerPackRef: "provider-dependency-fence",
  providerInstallationRef: "provider-dependency-fence.primary",
  technicalOffering: {
    id: "provider-dependency-fence.holder",
    kind: SOURCE_FORM_REF.kind,
    displayName: "Dependency holder",
    form: SOURCE_FORM_REF,
    bindingRefs: [],
    providedInterfaces: [],
    capabilities: ["create", "update"],
  },
  relations: [],
};

test("native D1 keeps a two-target dependency fence atomic through dispatch and commit", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "takoform-dependency-fence-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-17",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "dependency-fence-d1" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    await applyMigrations(database);
    const sql = createD1Sql(database);
    const store = createTakoformStore(sql, () => new Date(NOW));

    expect(
      await sql.query("SELECT COUNT(*) AS count FROM json_each(?)", [JSON.stringify(["a", "b"])]),
    ).toEqual([{ count: 2 }]);

    const targets = [
      targetResource("target-a", "uid_target_a"),
      targetResource("target-b", "uid_target_b"),
    ];
    for (const target of targets) {
      const address = resourceAddress(target);
      expect(
        await store.writeResource({
          address,
          resource: target,
          relations: [],
          expectedRevision: null,
        }),
      ).toBe(true);
      expect(
        await store.reserveResourceIncarnation({
          tenantId: TENANT_ID,
          resourceUid: target.metadata.uid,
          address,
          formRef: TARGET_FORM_REF,
        }),
      ).toBe(true);
    }

    const sourceUid = "uid_dependency_holder";
    const sourceAddress = {
      tenantId: TENANT_ID,
      space: SPACE,
      apiVersion: SOURCE_FORM_REF.apiVersion,
      kind: SOURCE_FORM_REF.kind,
      name: "holder",
    } as const;
    const relations = targets.map(
      (target, index): TakoformStoredRelation => ({
        pointer: `/targets/${index}`,
        relation: `/targets/${index}`,
        targetApiVersion: TARGET_FORM_REF.apiVersion,
        targetKind: TARGET_FORM_REF.kind,
        targetName: target.metadata.name,
        targetUid: target.metadata.uid,
        targetRevision: target.metadata.revision,
        targetFormRef: TARGET_FORM_REF,
      }),
    );

    const staleDependencies = await createResourceDependencySet({
      tenantId: TENANT_ID,
      space: SPACE,
      holderUid: "uid_stale_holder",
      operationId: "op_stale_dependency",
      relations: relations.map((relation, index) =>
        index === 1 ? { ...relation, targetRevision: "2" } : relation,
      ),
    });
    await expect(
      store.reserveResourceDependencies({
        tenantId: TENANT_ID,
        holderUid: "uid_stale_holder",
        reservationOwnerId: "op_stale_dependency",
        dependencies: staleDependencies,
        expiresAt: NOW + 60_000,
      }),
    ).rejects.toMatchObject({ code: "constraint" });
    expect(
      await sql.query(
        `SELECT resource_uid, state FROM tf_resource_deletion_attestations
         WHERE tenant_id = ? AND resource_uid IN (?, ?) ORDER BY resource_uid`,
        [TENANT_ID, "uid_target_a", "uid_target_b"],
      ),
    ).toEqual([
      { resource_uid: "uid_target_a", state: "live" },
      { resource_uid: "uid_target_b", state: "live" },
    ]);
    expect(
      await sql.query(
        `SELECT claim_key FROM tf_resource_claims
         WHERE tenant_id = ? AND holder_uid = ?`,
        [TENANT_ID, "uid_stale_holder"],
      ),
    ).toEqual([]);
    expect(await sql.query("SELECT token FROM tf_operation_commit_guards")).toEqual([]);

    const dependencies = await createResourceDependencySet({
      tenantId: TENANT_ID,
      space: SPACE,
      holderUid: sourceUid,
      operationId: "op_dependency_commit",
      relations,
    });
    expect(dependencies.fences).toHaveLength(2);
    await store.reserveResourceDependencies({
      tenantId: TENANT_ID,
      holderUid: sourceUid,
      reservationOwnerId: "dependency-reservation",
      dependencies,
      expiresAt: NOW + 60_000,
    });
    expect(
      await store.readProviderMutationDependencies({
        tenantId: TENANT_ID,
        resourceUid: sourceUid,
        operationId: dependencies.operationId,
      }),
    ).toEqual(null);
    const reserved = await sql.query(
      `SELECT claim_key, state, owner_operation_id, expires_at
       FROM tf_resource_claims WHERE tenant_id = ? AND holder_uid = ? ORDER BY claim_key`,
      [TENANT_ID, sourceUid],
    );
    expect(reserved).toHaveLength(resourceDependencyClaimKeys(dependencies).length);
    expect(reserved.every((row) => row.state === "reserved")).toBe(true);
    expect(
      await sql.query(
        `SELECT resource_uid, state FROM tf_resource_deletion_attestations
         WHERE tenant_id = ? AND resource_uid IN (?, ?) ORDER BY resource_uid`,
        [TENANT_ID, "uid_target_a", "uid_target_b"],
      ),
    ).toEqual([
      { resource_uid: "uid_target_a", state: "live" },
      { resource_uid: "uid_target_b", state: "live" },
    ]);

    await expect(
      store.prepareResourceDeletion({
        tenantId: TENANT_ID,
        resourceUid: "uid_target_a",
        address: resourceAddress(targets[0] as TakoformStoredResource),
        formRef: TARGET_FORM_REF,
        operationId: "op_delete_target_while_held",
      }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
      hostCode: "cross_resource_precondition",
    });

    const saga: ProviderMutationSaga = {
      operationId: dependencies.operationId,
      operationKind: "apply",
      replayKey: "replay_dependency_commit",
      tenantId: TENANT_ID,
      fingerprint: "fingerprint_dependency_commit",
      resourceUid: sourceUid,
      target: sourceAddress,
    };
    await store.reserveResourceIncarnation({
      tenantId: TENANT_ID,
      resourceUid: sourceUid,
      address: sourceAddress,
      formRef: SOURCE_FORM_REF,
    });
    await store.acceptProviderMutationSaga(saga);
    expect(
      await store.acquireProviderMutationExecution({
        tenantId: TENANT_ID,
        operationId: saga.operationId,
        resourceUid: sourceUid,
        leaseToken: "lease_dependency_commit",
        leaseUntil: NOW + 60_000,
      }),
    ).toEqual({ kind: "acquired", mode: "initial" });
    expect(
      await store.bindProviderMutationApplySelection({
        tenantId: TENANT_ID,
        operationId: saga.operationId,
        resourceUid: sourceUid,
        fingerprint: saga.fingerprint,
        leaseToken: "lease_dependency_commit",
        mode: "initial",
        selection: APPLY_SELECTION,
      }),
    ).toEqual(APPLY_SELECTION);
    expect(
      await store.markProviderMutationDispatch({
        tenantId: TENANT_ID,
        operationId: saga.operationId,
        resourceUid: sourceUid,
        leaseToken: "lease_dependency_commit",
        dependencyReservationOwnerId: "dependency-reservation",
        dependencySet: dependencies,
      }),
    ).toBe(true);
    const dispatched = await sql.query(
      `SELECT state, owner_operation_id, expires_at
       FROM tf_resource_claims WHERE tenant_id = ? AND holder_uid = ? ORDER BY claim_key`,
      [TENANT_ID, sourceUid],
    );
    expect(dispatched.every((row) => row.state === "reserved")).toBe(true);
    expect(dispatched.every((row) => row.owner_operation_id === saga.operationId)).toBe(true);
    expect(dispatched.every((row) => row.expires_at === 253402300799999)).toBe(true);

    const receipt = { observed: { backend: "native-d1" } };
    await store.recordProviderMutationReceipt({
      tenantId: TENANT_ID,
      operationId: saga.operationId,
      resourceUid: sourceUid,
      leaseToken: "lease_dependency_commit",
      receipt,
    });
    const source = sourceResource(sourceAddress, sourceUid, relations);
    await store.commitImmediateMutation({
      tenantId: TENANT_ID,
      operationId: saga.operationId,
      operation: "create",
      createdAt: new Date(NOW).toISOString(),
      mutation: {
        kind: "write",
        resourceUid: sourceUid,
        address: sourceAddress,
        expectedRevision: null,
        resource: source,
        relations,
        replayKey: saga.replayKey,
        replay: {
          fingerprint: saga.fingerprint,
          status: 201,
          resource: source,
          boundUid: sourceUid,
        },
        providerReceipt: receipt,
        dependencySet: dependencies,
      },
    });

    expect(await store.readResource(sourceAddress)).toEqual(source);
    const committed = await sql.query(
      `SELECT state, owner_operation_id, expires_at
       FROM tf_resource_claims WHERE tenant_id = ? AND holder_uid = ? ORDER BY claim_key`,
      [TENANT_ID, sourceUid],
    );
    expect(committed).toHaveLength(resourceDependencyClaimKeys(dependencies).length);
    expect(committed.every((row) => row.state === "committed")).toBe(true);
    expect(committed.every((row) => row.owner_operation_id === saga.operationId)).toBe(true);
    expect(committed.every((row) => row.expires_at === null)).toBe(true);
    expect(
      await store.readProviderMutationDependencies({
        tenantId: TENANT_ID,
        resourceUid: sourceUid,
        operationId: saga.operationId,
      }),
    ).toEqual(dependencies);
    await expect(
      store.prepareResourceDeletion({
        tenantId: TENANT_ID,
        resourceUid: "uid_target_b",
        address: resourceAddress(targets[1] as TakoformStoredResource),
        formRef: TARGET_FORM_REF,
        operationId: "op_delete_target_after_commit",
      }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
      hostCode: "cross_resource_precondition",
    });
  } finally {
    await runtime.dispose();
  }
  // Include cold Miniflare startup, the full migration history, D1 RPC
  // assertions, and awaited cleanup in a bounded native integration budget.
}, 30_000);

async function applyMigrations(
  database: Awaited<ReturnType<Miniflare["getD1Database"]>>,
): Promise<void> {
  for (const migration of MIGRATIONS) {
    for (const statement of splitMigration(migration.sql)) {
      await database.prepare(statement).run();
    }
  }
}

function splitMigration(source: string): readonly string[] {
  const statements: string[] = [];
  let rest = source.replace(/^\s*--.*$/gmu, "").trim();
  while (rest.length > 0) {
    if (/^CREATE\s+(?:TEMP\s+)?TRIGGER\b/iu.test(rest)) {
      const end = /^END\s*;/imu.exec(rest);
      if (!end || end.index === undefined) throw new Error("incomplete migration trigger");
      const boundary = end.index + end[0].length;
      statements.push(rest.slice(0, boundary).trim());
      rest = rest.slice(boundary).trim();
      continue;
    }
    const boundary = rest.indexOf(";");
    if (boundary < 0) {
      statements.push(rest);
      break;
    }
    const statement = rest.slice(0, boundary).trim();
    if (statement.length > 0) statements.push(statement);
    rest = rest.slice(boundary + 1).trim();
  }
  return statements;
}

function resourceAddress(resource: TakoformStoredResource) {
  return {
    tenantId: TENANT_ID,
    space: resource.metadata.space,
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    name: resource.metadata.name,
  } as const;
}

function targetResource(name: string, uid: string): TakoformStoredResource {
  return {
    apiVersion: TARGET_FORM_REF.apiVersion,
    kind: TARGET_FORM_REF.kind,
    form: { formRef: TARGET_FORM_REF },
    metadata: { name, space: SPACE, uid, generation: "1", revision: "1" },
    spec: { role: "target" },
    status: { observedGeneration: "1", conditions: [] },
  };
}

function sourceResource(
  address: {
    readonly tenantId: string;
    readonly space: string;
    readonly apiVersion: string;
    readonly kind: string;
    readonly name: string;
  },
  uid: string,
  relations: readonly TakoformStoredRelation[],
): TakoformStoredResource {
  return {
    apiVersion: address.apiVersion,
    kind: address.kind,
    form: { formRef: SOURCE_FORM_REF },
    metadata: { name: address.name, space: address.space, uid, generation: "1", revision: "1" },
    spec: { relationCount: relations.length },
    status: { observedGeneration: "1", conditions: [] },
  };
}
