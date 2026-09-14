import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import type { Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import type { TakoformStoredRelation } from "../src/takoform/relations.ts";
import { createTakoformStore } from "../src/takoform/store.ts";
import type { TakoformStoredResource, TakoformV1Alpha3FormRef } from "../src/takoform/types.ts";

const TENANT_ID = "tenant-resource-relation-snapshot";
const SPACE = "main";
const POINTER = "/workflow";
const NOW = Date.parse("2026-09-13T00:00:00.000Z");
const SOURCE_FORM_REF: TakoformV1Alpha3FormRef = {
  apiVersion: "example.forms.invalid/v1",
  kind: "WorkflowSource",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
};
const TARGET_FORM_REF: TakoformV1Alpha3FormRef = {
  apiVersion: "example.forms.invalid/v1",
  kind: "WorkflowTarget",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"b".repeat(64)}`,
};
const SOURCE_UID = "uid_workflow_source";
const TARGET_UID = "uid_workflow_target";

interface ResourceIndex {
  readonly tenantId?: string;
  readonly space?: string;
  readonly apiVersion?: string;
  readonly kind?: string;
  readonly name?: string;
  readonly uid?: string;
  readonly generation?: string;
  readonly revision?: string;
  readonly updatedAt?: number;
}

interface AttestationOverrides {
  readonly tenantId?: string;
  readonly resourceUid?: string;
  readonly space?: string;
  readonly apiVersion?: string;
  readonly kind?: string;
  readonly name?: string;
  readonly formRefJson?: string;
  readonly state?: string;
}

interface FixtureOptions {
  readonly source?: TakoformStoredResource;
  readonly target?: TakoformStoredResource;
  readonly relations?: readonly unknown[];
  readonly sourceIndex?: ResourceIndex;
  readonly targetIndex?: ResourceIndex;
  readonly sourceAttestation?: AttestationOverrides | null;
  readonly targetAttestation?: AttestationOverrides | null;
}

interface Fixture {
  readonly database: Database;
  readonly store: ReturnType<typeof createTakoformStore>;
  readonly queryCount: () => number;
}

function resource(input: {
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly name: string;
  readonly uid: string;
  readonly space?: string;
  readonly generation?: string;
  readonly revision?: string;
}): TakoformStoredResource {
  const space = input.space ?? SPACE;
  const generation = input.generation ?? "1";
  const revision = input.revision ?? "1";
  return {
    apiVersion: input.formRef.apiVersion,
    kind: input.formRef.kind,
    form: { formRef: input.formRef },
    metadata: {
      name: input.name,
      space,
      uid: input.uid,
      generation,
      revision,
    },
    spec: { value: input.name },
    status: { observedGeneration: generation, conditions: [] },
  };
}

function relationFor(
  target: TakoformStoredResource,
  overrides: Record<string, unknown> = {},
): TakoformStoredRelation {
  return {
    pointer: POINTER,
    relation: POINTER,
    targetApiVersion: target.apiVersion,
    targetKind: target.kind,
    targetName: target.metadata.name,
    targetUid: target.metadata.uid,
    targetRevision: target.metadata.revision,
    targetFormRef: target.form.formRef,
    ...overrides,
  } as TakoformStoredRelation;
}

function openDatabase(): Database {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS) database.exec(migration.sql);
  return database;
}

function insertResource(
  database: Database,
  stored: TakoformStoredResource,
  relations: readonly unknown[],
  index: ResourceIndex = {},
): void {
  database
    .query(
      `INSERT INTO tf_resources
         (tenant_id, space, api_version, kind, name, uid, generation, revision,
          resource_json, relations_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      index.tenantId ?? TENANT_ID,
      index.space ?? stored.metadata.space,
      index.apiVersion ?? stored.apiVersion,
      index.kind ?? stored.kind,
      index.name ?? stored.metadata.name,
      index.uid ?? stored.metadata.uid,
      index.generation ?? stored.metadata.generation,
      index.revision ?? stored.metadata.revision,
      JSON.stringify(stored),
      JSON.stringify(relations),
      index.updatedAt ?? NOW,
    );
}

function insertAttestation(
  database: Database,
  stored: TakoformStoredResource,
  index: ResourceIndex = {},
  overrides: AttestationOverrides = {},
): void {
  database
    .query(
      `INSERT INTO tf_resource_deletion_attestations
         (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
          state, closure_fence, effects_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      overrides.tenantId ?? index.tenantId ?? TENANT_ID,
      overrides.resourceUid ?? index.uid ?? stored.metadata.uid,
      overrides.space ?? index.space ?? stored.metadata.space,
      overrides.apiVersion ?? index.apiVersion ?? stored.apiVersion,
      overrides.kind ?? index.kind ?? stored.kind,
      overrides.name ?? index.name ?? stored.metadata.name,
      overrides.formRefJson ?? JSON.stringify(stored.form.formRef),
      overrides.state ?? "live",
      1,
      "[]",
      NOW,
      NOW,
    );
}

function fixture(options: FixtureOptions = {}): Fixture {
  const database = openDatabase();
  const source =
    options.source ??
    resource({ formRef: SOURCE_FORM_REF, name: "source", uid: SOURCE_UID, revision: "1" });
  const target =
    options.target ??
    resource({ formRef: TARGET_FORM_REF, name: "target", uid: TARGET_UID, revision: "2" });
  const sourceIndex = options.sourceIndex ?? {};
  const targetIndex = options.targetIndex ?? {};
  insertResource(database, source, options.relations ?? [relationFor(target)], sourceIndex);
  insertResource(database, target, [], targetIndex);
  if (options.sourceAttestation !== null) {
    insertAttestation(database, source, sourceIndex, options.sourceAttestation ?? {});
  }
  if (options.targetAttestation !== null) {
    insertAttestation(database, target, targetIndex, options.targetAttestation ?? {});
  }

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
  return {
    database,
    store: createTakoformStore(sql, () => new Date(NOW)),
    queryCount: () => queries,
  };
}

test("reads one live relation target snapshot atomically and does not write", async () => {
  const target = resource({
    formRef: TARGET_FORM_REF,
    name: "target",
    uid: TARGET_UID,
    revision: "2",
  });
  const relation = relationFor(target, { targetRevision: "1" });
  const f = fixture({ target, relations: [relation] });
  const beforeResources = f.database
    .query(
      `SELECT tenant_id, space, api_version, kind, name, uid, generation, revision,
              resource_json, relations_json, updated_at
       FROM tf_resources ORDER BY tenant_id, name`,
    )
    .all();
  const beforeAttestations = f.database
    .query(
      `SELECT tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
              state, closure_fence, effects_json, created_at, updated_at
       FROM tf_resource_deletion_attestations ORDER BY tenant_id, resource_uid`,
    )
    .all();

  const snapshot = await f.store.resourceWithRelationTargetByUid(TENANT_ID, SOURCE_UID, POINTER);

  expect(f.queryCount()).toBe(1);
  expect(snapshot?.source.uid).toBe(SOURCE_UID);
  expect(snapshot?.target.uid).toBe(TARGET_UID);
  expect(snapshot?.target.revision).toBe("2");
  expect(snapshot?.relation.targetRevision).toBe("1");
  expect(snapshot?.relation.relation).toBe(POINTER);
  expect(
    f.database
      .query(
        `SELECT tenant_id, space, api_version, kind, name, uid, generation, revision,
                resource_json, relations_json, updated_at
         FROM tf_resources ORDER BY tenant_id, name`,
      )
      .all(),
  ).toEqual(beforeResources);
  expect(
    f.database
      .query(
        `SELECT tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
                state, closure_fence, effects_json, created_at, updated_at
         FROM tf_resource_deletion_attestations ORDER BY tenant_id, resource_uid`,
      )
      .all(),
  ).toEqual(beforeAttestations);
});

for (const state of ["pending", "closed", "cancelled"] as const) {
  test(`refuses a ${state} source lifecycle attestation`, async () => {
    const f = fixture({ sourceAttestation: { state } });
    expect(
      await f.store.resourceWithRelationTargetByUid(TENANT_ID, SOURCE_UID, POINTER),
    ).toBeNull();
  });

  test(`refuses a ${state} target lifecycle attestation`, async () => {
    const f = fixture({ targetAttestation: { state } });
    expect(
      await f.store.resourceWithRelationTargetByUid(TENANT_ID, SOURCE_UID, POINTER),
    ).toBeNull();
  });
}

test("refuses either missing lifecycle attestation", async () => {
  const missingSource = fixture({ sourceAttestation: null });
  expect(
    await missingSource.store.resourceWithRelationTargetByUid(TENANT_ID, SOURCE_UID, POINTER),
  ).toBeNull();

  const missingTarget = fixture({ targetAttestation: null });
  expect(
    await missingTarget.store.resourceWithRelationTargetByUid(TENANT_ID, SOURCE_UID, POINTER),
  ).toBeNull();
});

const identityCases: readonly {
  readonly name: string;
  readonly options?: FixtureOptions;
  readonly sourceUid?: string;
}[] = [
  { name: "unknown source UID", sourceUid: "uid_missing_source" },
  { name: "source indexed metadata mismatch", options: { sourceIndex: { name: "wrong" } } },
  {
    name: "target resource in another tenant",
    options: { targetIndex: { tenantId: "tenant-other" } },
  },
  {
    name: "target resource in another space",
    options: {
      target: resource({
        formRef: TARGET_FORM_REF,
        name: "target",
        uid: TARGET_UID,
        space: "other",
        revision: "2",
      }),
    },
  },
  {
    name: "target address mismatch",
    options: {
      relations: [
        relationFor(resource({ formRef: TARGET_FORM_REF, name: "target", uid: TARGET_UID }), {
          targetName: "wrong",
        }),
      ],
    },
  },
  {
    name: "target UID mismatch",
    options: {
      relations: [
        relationFor(resource({ formRef: TARGET_FORM_REF, name: "target", uid: TARGET_UID }), {
          targetUid: "uid_missing_target",
        }),
      ],
    },
  },
  {
    name: "target FormRef mismatch",
    options: {
      target: resource({
        formRef: {
          ...TARGET_FORM_REF,
          schemaDigest: `sha256:${"c".repeat(64)}`,
        },
        name: "target",
        uid: TARGET_UID,
        revision: "2",
      }),
      relations: [
        relationFor(
          resource({
            formRef: TARGET_FORM_REF,
            name: "target",
            uid: TARGET_UID,
            revision: "2",
          }),
          { targetRevision: "1" },
        ),
      ],
    },
  },
];

for (const candidate of identityCases) {
  test(`refuses ${candidate.name}`, async () => {
    const f = fixture(candidate.options);
    expect(
      await f.store.resourceWithRelationTargetByUid(
        TENANT_ID,
        candidate.sourceUid ?? SOURCE_UID,
        POINTER,
      ),
    ).toBeNull();
  });
}

test("refuses duplicate matching relations, including one with a missing target", async () => {
  const target = resource({
    formRef: TARGET_FORM_REF,
    name: "target",
    uid: TARGET_UID,
    revision: "2",
  });
  const valid = relationFor(target, { targetRevision: "1" });
  const missing = relationFor(target, { targetUid: "uid_missing_target" });
  const f = fixture({ target, relations: [valid, missing] });
  expect(await f.store.resourceWithRelationTargetByUid(TENANT_ID, SOURCE_UID, POINTER)).toBeNull();
});

test("refuses a missing target even when a new resource reuses its name", async () => {
  const target = resource({
    formRef: TARGET_FORM_REF,
    name: "target",
    uid: "uid_target_new",
    revision: "1",
  });
  const relation = relationFor(target, { targetUid: TARGET_UID, targetRevision: "1" });
  const f = fixture({ target, relations: [relation] });
  expect(await f.store.resourceWithRelationTargetByUid(TENANT_ID, SOURCE_UID, POINTER)).toBeNull();
});

test("refuses duplicate source UIDs instead of choosing one address", async () => {
  const f = fixture();
  const duplicate = resource({
    formRef: SOURCE_FORM_REF,
    name: "duplicate-source",
    uid: SOURCE_UID,
  });
  insertResource(f.database, duplicate, [
    relationFor(resource({ formRef: TARGET_FORM_REF, name: "target", uid: TARGET_UID })),
  ]);
  expect(await f.store.resourceWithRelationTargetByUid(TENANT_ID, SOURCE_UID, POINTER)).toBeNull();
});

test("refuses duplicate target UIDs instead of choosing one address", async () => {
  const f = fixture();
  const duplicate = resource({
    formRef: TARGET_FORM_REF,
    name: "duplicate-target",
    uid: TARGET_UID,
  });
  insertResource(f.database, duplicate, []);
  expect(await f.store.resourceWithRelationTargetByUid(TENANT_ID, SOURCE_UID, POINTER)).toBeNull();
});

test("fails closed for a valid JSON relation with a wrong-type target UID", async () => {
  const target = resource({
    formRef: TARGET_FORM_REF,
    name: "target",
    uid: TARGET_UID,
    revision: "2",
  });
  const malformed = relationFor(target, { targetUid: 42 });
  const f = fixture({ target, relations: [malformed] });
  expect(await f.store.resourceWithRelationTargetByUid(TENANT_ID, SOURCE_UID, POINTER)).toBeNull();
});

test("preserves JSON storage constraints and refuses scalar relation entries", async () => {
  const target = resource({ formRef: TARGET_FORM_REF, name: "target", uid: TARGET_UID });
  const f = fixture();
  const update = f.database.query(
    "UPDATE tf_resources SET relations_json = ? WHERE tenant_id = ? AND uid = ?",
  );
  for (const raw of ["{", "{}"]) {
    expect(() => update.run(raw, TENANT_ID, SOURCE_UID)).toThrow("CHECK constraint failed");
  }
  update.run(JSON.stringify(["scalar", relationFor(target)]), TENANT_ID, SOURCE_UID);
  expect(await f.store.resourceWithRelationTargetByUid(TENANT_ID, SOURCE_UID, POINTER)).toBeNull();
  expect(f.queryCount()).toBe(1);
});
