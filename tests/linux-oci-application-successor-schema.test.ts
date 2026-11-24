import { expect, spyOn, test } from "bun:test";
import type { Sql, SqlParam, SqlStatement } from "../src/ports.ts";
import * as sqlite from "../src/sql-sqlite.ts";
import {
  createV2ContainerHostAcceptance,
  inspectV2ContainerOwnerApplicationSuccessorSchema,
  inspectV2ContainerOwnerSelectedSchema,
  inspectV2ContainerOwnerShutdownIoSchema,
  V2_CONTAINER_F2_FORM,
  V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND,
  V2_CONTAINER_OWNER_APPLICATION_SUCCESSOR_EXPAND,
  V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND,
  V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND,
} from "../src/takoform-v2/container-owner-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { acceptedRawHttp } from "./helpers/linux-oci-owned-bundle-fixture.ts";
import { originalPeerDeleteFixture } from "./helpers/linux-oci-peer-delete-fixture.ts";

const successors = "tf_v2_container_application_successors";
const predecessors = "tf_v2_container_shutdown_io_closes";
const fenceDelete = "container_owner_application_successor_delete";

function selectedEngine(
  fixture: Awaited<ReturnType<typeof originalPeerDeleteFixture>>,
  ociParentControl: "sealed-original@1" | "sealed-peer-runtime-application-owner@1",
) {
  const form = fixture.composition.retainedForm;
  return createTakoformV2Engine(
    {
      sql: fixture.sql,
      authorize: async () => true,
      replayWindowSeconds: 3600,
      forms: { [V2_CONTAINER_F2_FORM]: form },
    },
    createV2ContainerHostAcceptance({
      sql: fixture.sql,
      installationId: "synthetic-oci-installation",
      backendId: form.backend.id,
      targetKey: form.backend.targetKey,
      ociParentControl,
    }),
  );
}

async function withOriginal(
  check: (
    fixture: Awaited<ReturnType<typeof originalPeerDeleteFixture>>,
    sql: Sql,
    coordinates: readonly [string, number, string, string],
    predecessor: string,
    expand: () => Promise<void>,
  ) => Promise<void>,
) {
  const createSql = sqlite.createSqliteSql;
  let database: Parameters<typeof createSql>[0] | undefined;
  const capture = spyOn(sqlite, "createSqliteSql").mockImplementation((db) => {
    database ??= db;
    return createSql(db);
  });
  const fixture = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    qualifiedProducer: true,
    runtimeApplicationOwner: true,
    allocationSchema: true,
  }).finally(() => capture.mockRestore());
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    if (!database) throw Error("original SQLite fixture missing");
    const contender = createSql(database);
    const otherwise = V2_CONTAINER_OWNER_APPLICATION_SUCCESSOR_EXPAND.statements;
    await fixture.sql.batch(
      V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND.statements.map((sql) => ({ sql })),
    );
    await fixture.sql.batch(V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND.statements);
    await expect(fixture.sql.batch(otherwise)).rejects.toMatchObject({ code: "constraint" });
    await fixture.sql.batch(V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND.statements);
    expect(await inspectV2ContainerOwnerApplicationSuccessorSchema(contender)).toBe(false);
    expect(await inspectV2ContainerOwnerShutdownIoSchema(contender)).toBe(true);
    const created = await fixture.create();
    expect(await fixture.engine.runNext()).toMatchObject({
      id: created.id,
      status: "succeeded",
      effect: "complete",
    });
    await fixture.composition.close();
    const original = fixture.recordedCreate();
    const coordinates = [
      created.resourceUid,
      created.generation,
      original.claimId,
      original.claimId,
    ] as const;
    const prior = await contender.query(`SELECT * FROM ${predecessors}`);
    expect(prior).toHaveLength(1);
    const predecessor = prior[0]?.close_document;
    if (typeof predecessor !== "string") throw Error("original shutdown receipt missing");
    const before = await contender.query(
      "SELECT name, sql FROM sqlite_schema WHERE name LIKE 'tf_v2_container_%' ORDER BY name",
    );
    const native = fixture.nativeCounts();
    const expand = async () => {
      await contender.batch(otherwise);
      expect(await inspectV2ContainerOwnerApplicationSuccessorSchema(contender)).toBe(true);
      expect(await inspectV2ContainerOwnerShutdownIoSchema(contender)).toBe(false);
      for (const layer of ["control", "allocation", "application-io", "final-delete"] as const)
        expect(await inspectV2ContainerOwnerSelectedSchema(contender, layer)).toBe(false);
      await expect(contender.batch(otherwise)).rejects.toMatchObject({ code: "constraint" });
      expect(
        await contender.query(
          "SELECT name, sql FROM sqlite_schema WHERE name LIKE 'tf_v2_container_%' AND name NOT LIKE 'tf_v2_container_application_successor%' AND name <> 'tf_v2_container_acceptances' ORDER BY name",
        ),
      ).toEqual(before.filter(({ name }) => name !== "tf_v2_container_acceptances"));
      expect(
        await contender.query(
          "SELECT count(*) AS selected FROM tf_v2_container_acceptances WHERE application_successor_owner_token IS NOT NULL",
        ),
      ).toEqual([{ selected: 0 }]);
    };
    await check(fixture, contender, coordinates, predecessor, expand);
    expect(await contender.query(`SELECT * FROM ${predecessors}`)).toEqual(prior);
    expect(fixture.nativeCounts()).toEqual(native);
    expect(fixture.network).not.toHaveBeenCalled();
  } finally {
    health.restore();
    await fixture.cleanup();
  }
}

function reserve(
  sql: Sql,
  coordinates: readonly SqlParam[],
  predecessor: string,
  epoch: number,
  token: string,
  replace = false,
) {
  return sql.run(
    `INSERT ${replace ? "OR REPLACE " : ""}INTO ${successors}
      (resource_uid, generation, claim_id, native_id, epoch, owner_token, predecessor_close_document)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [...coordinates, epoch, token, predecessor],
  );
}

function withPrecheckedSchema(statements: readonly SqlStatement[], admission: SqlStatement) {
  const guardPrefix = "SELECT 1 AS permitted WHERE (";
  const ownerScope = " AND (EXISTS (SELECT 1 FROM main.tf_v2_container_instances";
  const boundary = admission.sql.lastIndexOf(ownerScope);
  const schema = admission.sql.slice(guardPrefix.length, boundary);
  const schemaBindings = schema.match(/\?/gu)?.length ?? 0;
  if (
    boundary < 0 ||
    schemaBindings === 0 ||
    !schema.includes("container_owner_shutdown_io_values")
  )
    throw Error("unexpected ordinary acceptance schema guard");
  let changed = 0;
  const stale = statements.map((statement) => {
    const index = statement.sql.indexOf(schema);
    if (index < 0) return statement;
    const before = statement.sql.slice(0, index);
    const bindingsBefore = before.match(/\?/gu)?.length ?? 0;
    const params = statement.params;
    if (!params || !statement.sql.startsWith(ownerScope, index + schema.length))
      throw Error("unexpected ordinary acceptance scope");
    changed++;
    return {
      sql: `${before}1${statement.sql.slice(index + schema.length)}`,
      params: [
        ...params.slice(0, bindingsBefore),
        ...params.slice(bindingsBefore + schemaBindings),
      ],
    };
  });
  if (changed !== 2 || stale.at(-1) !== statements.at(-1))
    throw Error("fixture must preserve the original acceptance terminal");
  return stale;
}

test("a committed successor defeats a prepared stale DELETE and remains held after lost ACK", async () => {
  await withOriginal(async (f, contender, coordinates, predecessor, expand) => {
    const token = "a".repeat(64);
    const other = "b".repeat(64);
    const request = {
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: coordinates[0],
      expectedGeneration: coordinates[1],
    };
    const snapshot = () =>
      Promise.all([
        f.sql.query("SELECT * FROM tf_v2_resources"),
        f.sql.query("SELECT * FROM tf_v2_operations"),
        f.sql.query("SELECT * FROM tf_v2_container_acceptances").then((rows) =>
          rows.map(({ application_successor_owner_token, ...accepted }) => {
            expect(application_successor_owner_token ?? null).toBeNull();
            return accepted;
          }),
        ),
        f.sql.query("SELECT * FROM tf_v2_container_instances"),
        f.sql.query("SELECT * FROM tf_v2_container_create_claims"),
      ]);
    const before = await snapshot();
    const rawBatch = f.sql.batch.bind(f.sql);
    const batch = spyOn(f.sql, "batch").mockImplementation(async (statements) => {
      const admission = statements.find(({ sql }) =>
        sql.startsWith("SELECT 1 AS permitted WHERE ("),
      );
      if (
        !admission ||
        !statements.at(-1)?.sql.includes("INSERT OR ABORT INTO main.tf_v2_container_acceptances")
      )
        throw Error("expected an ordinary prepared DELETE batch");
      expect(await contender.query(admission.sql, admission.params)).toEqual([{ permitted: 1 }]);
      await expand();
      // The exact prepared write rechecks the schema inside its transaction,
      // before any successor exists.
      await expect(rawBatch(statements)).rejects.toThrow("container_owner_invariant");
      expect(await snapshot()).toEqual(before);
      await expect(
        reserve(contender, coordinates, `${predecessor} `, 1, token),
      ).rejects.toMatchObject({ code: "constraint" });
      await expect(
        reserve(
          contender,
          [coordinates[0], coordinates[1], other, coordinates[3]],
          predecessor,
          1,
          token,
        ),
      ).rejects.toMatchObject({ code: "constraint" });
      const lostAck = async () => {
        expect((await reserve(contender, coordinates, predecessor, 1, token)).changes).toBe(1);
        throw Error("fixture reservation acknowledgement lost");
      };
      await expect(lostAck()).rejects.toThrow("fixture reservation acknowledgement lost");
      // This fixture carries only the old schema precheck across installation.
      // The actual Core mutations, live owner scope and terminal remain intact.
      return rawBatch(withPrecheckedSchema(statements, admission));
    });
    let staleWriter: ReturnType<typeof f.reconstructNormal> | undefined;
    try {
      staleWriter = f.reconstructNormal();
      await expect(staleWriter.engine.acceptDelete(request)).rejects.toThrow(fenceDelete);
      expect(await snapshot()).toEqual(before);
    } finally {
      batch.mockRestore();
      await staleWriter?.close();
    }
    // No ACK is required to make the reservation effective on another reader.
    // It cannot be reclaimed, replaced, advanced, or expired while the holder
    // has an uncertain result.
    await expect(reserve(f.sql, coordinates, predecessor, 1, other)).rejects.toMatchObject({
      code: "constraint",
    });
    await expect(reserve(f.sql, coordinates, predecessor, 1, token, true)).rejects.toMatchObject({
      code: "constraint",
    });
    await expect(reserve(f.sql, coordinates, predecessor, 2, other)).rejects.toMatchObject({
      code: "constraint",
    });
    await expect(f.sql.run(`DELETE FROM ${successors}`)).rejects.toMatchObject({
      code: "constraint",
    });
    expect(
      await f.sql.query(`SELECT epoch, owner_token, close_document FROM ${successors}`),
    ).toEqual([{ epoch: 1, owner_token: token, close_document: null }]);

    // Structural fixture only. A later runtime must authenticate this scope
    // and ciphertext before treating it as terminal or permitting reattach.
    const closeScope = {
      ...JSON.parse(predecessor).scope,
      purpose: "takoserver.linux-oci-host-application-successor-close@1",
      epoch: 1,
      ownerToken: token,
    };
    const closeDocument = (scope: object) =>
      JSON.stringify({
        kind: "linux-oci-sealed-host-application-successor-close@1",
        scope,
        keyId: "fixture",
        nonce: "fixture",
        ciphertext: "fixture",
      });
    const recordClose = (document: string) =>
      contender.run(
        `UPDATE ${successors} SET close_document=? WHERE resource_uid=? AND generation=? AND epoch=1 AND owner_token=?`,
        [document, coordinates[0], coordinates[1], token],
      );
    await expect(recordClose(closeDocument({ ...closeScope, epoch: true }))).rejects.toMatchObject({
      code: "constraint",
    });
    await expect(
      recordClose(closeDocument({ ...closeScope, ownerToken: other })),
    ).rejects.toMatchObject({
      code: "constraint",
    });
    const close = closeDocument(closeScope);
    expect((await recordClose(close)).changes).toBe(1);
    await expect(recordClose(close)).rejects.toMatchObject({ code: "constraint" });
    await expect(
      selectedEngine(f, "sealed-original@1").acceptDelete({
        principal: "synthetic-oci-parent",
        key: crypto.randomUUID(),
        uid: coordinates[0],
        expectedGeneration: coordinates[1],
      }),
    ).rejects.toThrow();
    await expect(reserve(contender, coordinates, predecessor, 2, other)).rejects.toMatchObject({
      code: "constraint",
    });
    await expect(reserve(contender, coordinates, close, 3, other)).rejects.toMatchObject({
      code: "constraint",
    });
    expect((await reserve(contender, coordinates, close, 2, other)).changes).toBe(1);
    expect(
      await contender.query(
        `SELECT epoch, predecessor_close_document, close_document FROM ${successors} ORDER BY epoch`,
      ),
    ).toEqual([
      { epoch: 1, predecessor_close_document: predecessor, close_document: close },
      { epoch: 2, predecessor_close_document: close, close_document: null },
    ]);
  });
}, 20_000);

test("an accepted ordinary DELETE fences a reservation holding a previously read receipt", async () => {
  await withOriginal(async (f, contender, coordinates, predecessor, expand) => {
    const fresh = f.reconstructNormal();
    try {
      const accepted = await fresh.engine.acceptDelete({
        principal: "synthetic-oci-parent",
        key: crypto.randomUUID(),
        uid: coordinates[0],
        expectedGeneration: coordinates[1],
      });
      expect(accepted.status).toBe("queued");
      await expand();
      await expect(
        reserve(contender, coordinates, predecessor, 1, "c".repeat(64)),
      ).rejects.toMatchObject({ code: "constraint" });
      expect(await contender.query(`SELECT epoch FROM ${successors}`)).toEqual([]);
      expect(
        await contender.query(
          "SELECT retire_operation_id, serving_generation FROM tf_v2_container_instances WHERE resource_uid=?",
          [coordinates[0]],
        ),
      ).toEqual([{ retire_operation_id: accepted.id, serving_generation: null }]);
    } finally {
      await fresh.close();
    }
  });
}, 20_000);

test("selected OCI DELETE atomically binds the latest application owner without closing it", async () => {
  await withOriginal(async (f, contender, coordinates, predecessor, expand) => {
    await expand();
    const token = "d".repeat(64);
    expect((await reserve(contender, coordinates, predecessor, 1, token)).changes).toBe(1);
    const engine = selectedEngine(f, "sealed-peer-runtime-application-owner@1");
    const accepted = await engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: coordinates[0],
      expectedGeneration: coordinates[1],
    });
    expect(accepted.status).toBe("queued");
    expect(
      await contender.query(
        "SELECT application_successor_owner_token FROM tf_v2_container_acceptances WHERE operation_id=?",
        [accepted.id],
      ),
    ).toEqual([{ application_successor_owner_token: token }]);
    expect(
      await contender.query(
        "SELECT retire_operation_id, serving_generation FROM tf_v2_container_instances WHERE resource_uid=?",
        [coordinates[0]],
      ),
    ).toEqual([{ retire_operation_id: accepted.id, serving_generation: null }]);
    expect(await contender.query(`SELECT close_document FROM ${successors}`)).toEqual([
      { close_document: null },
    ]);
  });
}, 20_000);

test("selected OCI UPDATE binds the current application owner and retains serving until cutover", async () => {
  await withOriginal(async (f, contender, coordinates, predecessor, expand) => {
    const [uid, generation] = coordinates;
    const token = "e".repeat(64);
    const [resource] = await contender.query("SELECT spec_json FROM tf_v2_resources WHERE uid=?", [
      uid,
    ]);
    if (typeof resource?.spec_json !== "string") throw Error("original Container spec missing");
    const request = {
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid,
      expectedGeneration: generation,
      spec: { ...JSON.parse(resource.spec_json), workloadRevision: "2".repeat(64) },
    };
    const instance = () =>
      contender.query(
        "SELECT desired_generation, serving_generation, runtime_epoch FROM tf_v2_container_instances WHERE resource_uid=?",
        [uid],
      );
    const before = await instance();
    const updates = () =>
      contender.query("SELECT count(*) AS updates FROM tf_v2_operations WHERE action='update'");
    const rawBatch = f.sql.batch.bind(f.sql);
    const batch = spyOn(f.sql, "batch").mockImplementation(async (statements) => {
      const admission = statements.find(({ sql }) =>
        sql.startsWith("SELECT 1 AS permitted WHERE ("),
      );
      if (!admission) throw Error("expected an ordinary prepared UPDATE batch");
      expect(await contender.query(admission.sql, admission.params)).toEqual([{ permitted: 1 }]);
      await expand();
      expect((await reserve(contender, coordinates, predecessor, 1, token)).changes).toBe(1);
      const refused = await rawBatch(statements);
      expect(refused[statements.indexOf(admission)]?.rows).toEqual([]);
      expect(await instance()).toEqual(before);
      expect(await updates()).toEqual([{ updates: 0 }]);
      return rawBatch(withPrecheckedSchema(statements, admission));
    });
    try {
      const stale = selectedEngine(f, "sealed-peer-runtime-application-owner@1");
      await expect(stale.acceptUpdate(request)).rejects.toThrow(
        "container_owner_application_successor_update",
      );
    } finally {
      batch.mockRestore();
    }
    expect(await instance()).toEqual(before);
    expect(await updates()).toEqual([{ updates: 0 }]);
    await expect(selectedEngine(f, "sealed-original@1").acceptUpdate(request)).rejects.toThrow();
    expect(await instance()).toEqual(before);
    const engine = selectedEngine(f, "sealed-peer-runtime-application-owner@1");
    const accepted = await engine.acceptUpdate(request);
    expect(accepted).toMatchObject({
      status: "queued",
      action: "update",
      generation: generation + 1,
    });
    expect(await engine.acceptUpdate(request)).toMatchObject({ id: accepted.id });
    expect(
      await contender.query(
        "SELECT application_successor_owner_token FROM tf_v2_container_acceptances WHERE operation_id=?",
        [accepted.id],
      ),
    ).toEqual([{ application_successor_owner_token: token }]);
    expect(await instance()).toEqual([{ ...before[0], desired_generation: generation + 1 }]);
    expect(await contender.query(`SELECT close_document FROM ${successors}`)).toEqual([
      { close_document: null },
    ]);
  });
}, 20_000);

test("selected OCI Host starts its first accepted CREATE on the exact successor schema", async () => {
  const fixture = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    qualifiedProducer: true,
    runtimeApplicationOwner: true,
    allocationSchema: true,
  });
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    await fixture.sql.batch(
      V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND.statements.map((sql) => ({ sql })),
    );
    await fixture.sql.batch(V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND.statements);
    await fixture.sql.batch(V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND.statements);
    await fixture.sql.batch(V2_CONTAINER_OWNER_APPLICATION_SUCCESSOR_EXPAND.statements);
    const created = await fixture.create();
    expect(created).toMatchObject({ status: "queued", effect: "none", generation: 1 });
    expect(
      await fixture.sql.query(
        "SELECT action, application_successor_owner_token FROM tf_v2_container_acceptances WHERE operation_id=?",
        [created.id],
      ),
    ).toEqual([{ action: "create", application_successor_owner_token: null }]);
    expect(await fixture.sql.query(`SELECT owner_token FROM ${successors}`)).toEqual([]);
    expect(fixture.nativeCounts()).toEqual({ processes: 0, requests: [] });
    expect(await fixture.engine.runNext()).toMatchObject({
      id: created.id,
      status: "succeeded",
      effect: "complete",
    });
    const original = fixture.recordedCreate();
    expect(
      await fixture.sql.query(
        `SELECT claim_id, native_id, state, allocation_cleanup,
          json_extract(native_control, '$.kind') AS control_kind,
          application_io_cleanup IS NOT NULL AS application_io_initialized
         FROM tf_v2_container_create_claims WHERE resource_uid=?`,
        [created.resourceUid],
      ),
    ).toEqual([
      {
        claim_id: original.claimId,
        native_id: original.claimId,
        state: "bound",
        allocation_cleanup: "untouched",
        control_kind: "linux-oci-sealed-control@1",
        application_io_initialized: 1,
      },
    ]);
    expect(
      await fixture.sql.query(
        "SELECT native_id, state FROM tf_v2_container_start_attempts WHERE resource_uid=?",
        [created.resourceUid],
      ),
    ).toEqual([{ native_id: original.claimId, state: "running" }]);
    await fixture.composition.close();
    expect(
      await fixture.sql.query(
        `SELECT claim_id, native_id, json_extract(close_document, '$.kind') AS kind
         FROM ${predecessors} WHERE resource_uid=?`,
        [created.resourceUid],
      ),
    ).toEqual([
      {
        claim_id: original.claimId,
        native_id: original.claimId,
        kind: "linux-oci-sealed-host-shutdown-io-close@1",
      },
    ]);
  } finally {
    health.restore();
    await fixture.cleanup();
  }
}, 20_000);
