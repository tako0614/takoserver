/**
 * Actual Engine/Store bindings and SQLite constraints, with controlled native
 * route rows. Shared DDL is UNALLOCATED test-only preparation, not a migration,
 * native/provider qualification, registered product grant or carrier adoption.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { type JsonObject, type Sql, SqlError, type SqlStatement } from "../src/ports.ts";
import { createSharedAppLedger } from "../src/shared-app-ledger.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  parseWorkerEndpointSpec,
  validateWorkerEndpointUpdate,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import {
  createWorkerEndpointOriginV2Acceptance,
  createWorkerEndpointOriginV2Publication,
  type WorkerEndpointOriginV2PublicationPreparation,
} from "../src/worker-endpoint-origin-v2-acceptance.ts";

const FORM = "https://forms.example.test/PublicationEndpoint/1.0.0/";
const WORKER = "https://forms.example.test/PublicationWorker/1.0.0/";
const DEPLOYMENT = "https://forms.example.test/PublicationDeployment/1.0.0/";
const TARGET = "origin-publication-fixture";
const BACKEND = "origin-publication-endpoint";
const PROVIDER = "origin-provider-fixture";
const ORGANIZATION = "publication-org";
const PRINCIPAL = `org:${ORGANIZATION}`;
const OWNER = { organizationId: ORGANIZATION, product: "takoserver" as const };
const NAME = "publication-name";
const HOSTNAME = `${NAME}.app-staging.takos.jp`;
const AT = "2026-10-15T00:00:00.000Z";
const SCRIPT = `v2w-${"a".repeat(48)}`;
const BINDINGS = "shared_app_staging_endpoint_bindings";
const HISTORY = "shared_app_staging_route_commands";

function sharedFixtureSchema(db: Database): void {
  // Explicit preparatory fixture, matching the existing ledger's real constraints.
  db.exec(`CREATE TABLE shared_app_staging_assignments (
    incarnation TEXT PRIMARY KEY CHECK(length(incarnation)=32), name TEXT NOT NULL,
    organization_id TEXT NOT NULL, product TEXT NOT NULL
      CHECK(product IN ('takoserver','takosumi-hosted')),
    reservation_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=1),
    state TEXT NOT NULL CHECK(state IN ('reserved','active','released')),
    script TEXT, released_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(organization_id,reservation_id), CHECK(updated_at>=created_at),
    CHECK((state='released')=(released_at IS NOT NULL)),
    CHECK(state<>'reserved' OR script IS NULL), CHECK(state<>'active' OR script IS NOT NULL))`);
  db.exec(`CREATE TABLE shared_app_staging_names (
    normalized_name TEXT PRIMARY KEY,
    incarnation TEXT NOT NULL REFERENCES shared_app_staging_assignments(incarnation),
    generation INTEGER NOT NULL, state TEXT NOT NULL, released_at INTEGER,
    updated_at INTEGER NOT NULL, CHECK((state='released')=(released_at IS NOT NULL)))`);
  db.exec(`CREATE TABLE ${HISTORY} (
    organization_id TEXT NOT NULL, product TEXT NOT NULL, reservation_id TEXT NOT NULL,
    name TEXT NOT NULL, incarnation TEXT NOT NULL REFERENCES shared_app_staging_assignments(incarnation),
    action TEXT NOT NULL CHECK(action IN ('activate','advance','retire')), command_ref TEXT NOT NULL,
    prior_generation INTEGER NOT NULL, prior_state TEXT NOT NULL, prior_script TEXT,
    next_script TEXT, endpoint_uid TEXT NOT NULL, endpoint_generation INTEGER NOT NULL,
    worker_uid TEXT NOT NULL, deployment_uid TEXT NOT NULL, deployment_generation INTEGER NOT NULL,
    source_operation_id TEXT NOT NULL, provider_id TEXT NOT NULL, target_key TEXT NOT NULL,
    next_generation INTEGER NOT NULL, next_state TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(organization_id,command_ref), UNIQUE(incarnation,next_generation),
    CHECK(next_generation=prior_generation+1),
    CHECK((action='activate' AND prior_state='reserved' AND prior_script IS NULL)
      OR (action<>'activate' AND prior_state='active' AND prior_script IS NOT NULL)),
    CHECK((action='retire' AND next_state='reserved' AND next_script IS NULL)
      OR (action<>'retire' AND next_state='active' AND next_script IS NOT NULL)))`);
  db.exec(`CREATE TABLE shared_app_staging_batch_assertions (
    witness TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1),
    apply_effects INTEGER NOT NULL CHECK(apply_effects IN (0,1)))`);
  db.exec(`CREATE TABLE ${BINDINGS} (
    incarnation TEXT PRIMARY KEY REFERENCES shared_app_staging_assignments(incarnation),
    organization_id TEXT NOT NULL, product TEXT NOT NULL, reservation_id TEXT NOT NULL,
    name TEXT NOT NULL, endpoint_uid TEXT NOT NULL UNIQUE REFERENCES tf_v2_resources(uid),
    endpoint_generation INTEGER NOT NULL CHECK(endpoint_generation>=1),
    form_url TEXT NOT NULL, backend_id TEXT NOT NULL, target_key TEXT NOT NULL,
    create_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id),
    current_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id))`);
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "origin-publication-"));
  const path = join(directory, "state.sqlite");
  let db = new Database(path);
  migrateSqlite(db);
  sharedFixtureSchema(db);
  let raw = createSqliteSql(db);
  let loseAck = false;
  let readGate: { entered(): void; wait: Promise<void> } | null = null;
  const batches: (readonly SqlStatement[])[] = [];
  const sql: Sql = {
    async query(query, params) {
      if (readGate && query === `SELECT * FROM ${BINDINGS} WHERE endpoint_uid = ?`) {
        const gate = readGate;
        readGate = null;
        gate.entered();
        await gate.wait;
      }
      return raw.query(query, params);
    },
    run: (...args) => raw.run(...args),
    async batch(statements) {
      batches.push(statements);
      const result = await raw.batch(statements);
      if (loseAck) {
        loseAck = false;
        throw new SqlError("unavailable", "fixture committed ACK lost");
      }
      return result;
    },
  };
  const ledger = createSharedAppLedger({ environment: "staging", primary: () => sql });
  const complete: V2Form["backend"] = {
    id: "origin-publication-complete",
    targetKey: TARGET,
    async execute(input) {
      return { kind: "complete", observed: { ready: true }, output: input.previousOutput };
    },
    async reconcile() {
      return { kind: "unknown" };
    },
  };
  const base: V2Form = { validateCreate() {}, validateUpdate() {}, backend: complete };
  const forms: Record<string, V2Form> = {
    [WORKER]: base,
    [DEPLOYMENT]: base,
    [FORM]: {
      ...base,
      validateCreate: parseWorkerEndpointSpec,
      validateUpdate: validateWorkerEndpointUpdate,
      initialOutput: () => ({ hostname: "ordinary.example.invalid" }),
      references(spec) {
        const worker = spec.worker;
        if (
          !worker ||
          typeof worker !== "object" ||
          Array.isArray(worker) ||
          !("resourceUid" in worker) ||
          typeof worker.resourceUid !== "string"
        )
          throw new Error("missing fixture Worker");
        return [{ resourceUid: worker.resourceUid, formUrl: WORKER, readiness: "ready" }];
      },
      backend: { ...complete, id: BACKEND },
    },
  };
  const options = {
    sql,
    forms,
    now: () => new Date(AT),
    replayWindowSeconds: 3600,
    authorize: async (principal: string, space: string) => principal === `org:${space}`,
  };
  const engine = createTakoformV2Engine(
    options,
    createWorkerEndpointOriginV2Acceptance({
      sql,
      ledger,
      formUrl: FORM,
      backendId: BACKEND,
      targetKey: TARGET,
    }),
  );
  const store = createV2Store(sql);
  const create = async (form: string, name: string, spec: JsonObject) =>
    engine.acceptCreate({
      principal: PRINCIPAL,
      key: `fixture-create-${name}`,
      input: { form, space: ORGANIZATION, name, spec },
    });
  const worker = await create(WORKER, "worker", {});
  expect(await engine.runNext()).toMatchObject({ id: worker.id, status: "succeeded" });
  const deployment = await create(DEPLOYMENT, "deployment", {
    worker: { resourceUid: worker.resourceUid },
  });
  expect(await engine.runNext()).toMatchObject({ id: deployment.id, status: "succeeded" });
  const workerValue = {
    schema: "takoserver.v2-wfp-worker-route@v1",
    generation: 1,
    targetKey: TARGET,
    workerUid: worker.resourceUid,
    deploymentUid: deployment.resourceUid,
    deploymentGeneration: 1,
    sourceOperationId: deployment.id,
    releases: [
      {
        versionUid: "fixture-native-version",
        versionGeneration: 1,
        scriptName: SCRIPT,
        weight: 10_000,
        descriptorDigest: `sha256:${"b".repeat(64)}`,
        providerEtag: "fixture-etag",
      },
    ],
  };
  // Controlled native route, pinned to real accepted Worker/Deployment rows.
  await sql.run(
    `INSERT INTO cloudflare_managed_worker_routes
    (provider_id,route_kind,route_key,owner_native_id,generation,operation_id,state,value_json)
    VALUES (?,'worker',?,?,1,?,'active',?)`,
    [
      PROVIDER,
      `worker/v2/${worker.resourceUid}`,
      `v2-worker:${worker.resourceUid}`,
      `v2-worker:${deployment.id}`,
      JSON.stringify(workerValue),
    ],
  );
  const claim = async (id: string): Promise<V2Execution> => {
    const operation = await store.operation(id);
    const resource = operation ? await store.resource(operation.resource_uid) : null;
    if (!operation || !resource) throw new Error("missing actual accepted operation");
    const token = crypto.randomUUID();
    expect(await store.claim(id, token, Date.parse(AT), Date.parse(AT) + 120_000)).toBe(true);
    expect(await store.markDispatch(id, token, AT)).toBe(true);
    return {
      operationId: id,
      leaseToken: token,
      backendKey: operation.backend_key,
      backendId: operation.backend_id,
      targetKey: operation.target_key,
      resourceUid: resource.uid,
      principal: operation.principal,
      action: operation.action,
      generation: operation.generation,
      form: resource.form_url,
      space: resource.space,
      name: resource.name,
      spec: JSON.parse(operation.accepted_spec_json),
      previousObserved: JSON.parse(resource.observed_json),
      previousOutput: JSON.parse(resource.output_json),
    };
  };
  const held = await ledger
    .forTrustedOwner(OWNER)
    .reserve({ reservationId: "original-reservation", name: NAME });
  const endpoint = await create(FORM, NAME, { worker: { resourceUid: worker.resourceUid } });
  const execution = await claim(endpoint.id);
  const receiver = (selectedSql = sql, selectedLedger = ledger) =>
    createWorkerEndpointOriginV2Publication({
      sql: selectedSql,
      ledger: selectedLedger,
      formUrl: FORM,
      backendId: BACKEND,
      targetKey: TARGET,
      providerId: PROVIDER,
    });
  const settle = async (input: V2Execution) => {
    expect(
      await store.settle({
        id: input.operationId,
        token: input.leaseToken,
        status: "succeeded",
        effect: "complete",
        at: AT,
        retainUntil: "2026-10-15T01:00:00.000Z",
        observedJson: '{"ready":true}',
        outputJson: JSON.stringify(input.previousOutput),
      }),
    ).toBe(true);
  };
  const fail = async (input: V2Execution, effect: "none" | "partial" = "none") => {
    expect(
      await store.settle({
        id: input.operationId,
        token: input.leaseToken,
        status: "failed",
        effect,
        at: AT,
        retainUntil: "2026-10-15T01:00:00.000Z",
        error: { code: "fixture_terminal_failure", message: "controlled execution failure" },
      }),
    ).toBe(true);
  };
  const ownerStatement = async (
    input: V2Execution,
    preparation: WorkerEndpointOriginV2PublicationPreparation,
  ) => {
    const effects = preparation.effects;
    if (!effects) throw new Error("expected fresh fixed effects");
    const before = await raw.query(
      `SELECT * FROM cloudflare_managed_worker_routes
      WHERE provider_id=? AND route_kind='host' AND route_key=?`,
      [PROVIDER, `host/v2/${HOSTNAME}`],
    );
    const previous = before[0];
    const generation = Number(previous?.generation ?? 0) + 1;
    const removing = input.action === "delete";
    const nativeId = removing ? input.operationId : deployment.id;
    const value = removing
      ? { schema: "takoserver.managed-worker-route-tombstone@v1", generation }
      : {
          schema: "takoserver.v2-wfp-host-route@v1",
          targetKey: TARGET,
          hostname: HOSTNAME,
          workerUid: worker.resourceUid,
          deploymentUid: deployment.resourceUid,
          deploymentGeneration: 1,
          endpointUid: endpoint.resourceUid,
          endpointGeneration: input.generation,
          sourceOperationId: deployment.id,
          generation,
        };
    return previous
      ? {
          sql: `UPDATE cloudflare_managed_worker_routes SET generation=?,operation_id=?,state=?,value_json=?
        WHERE provider_id=? AND route_kind='host' AND route_key=? AND generation=?
        AND operation_id=? AND value_json=? AND (${effects.publicationGuard.sql})`,
          params: [
            generation,
            `v2-host:${nativeId}:${HOSTNAME}`,
            removing ? "tombstone" : "active",
            JSON.stringify(value),
            PROVIDER,
            `host/v2/${HOSTNAME}`,
            Number(previous.generation),
            String(previous.operation_id),
            String(previous.value_json),
            ...(effects.publicationGuard.params ?? []),
          ],
        }
      : {
          sql: `INSERT INTO cloudflare_managed_worker_routes
        (provider_id,route_kind,route_key,owner_native_id,generation,operation_id,state,value_json)
        SELECT ?,'host',?,?,1,?,'active',? WHERE (${effects.publicationGuard.sql}) ON CONFLICT DO NOTHING`,
          params: [
            PROVIDER,
            `host/v2/${HOSTNAME}`,
            `v2-worker:${worker.resourceUid}`,
            `v2-host:${nativeId}:${HOSTNAME}`,
            JSON.stringify(value),
            ...(effects.publicationGuard.params ?? []),
          ],
        };
  };
  const publish = async (
    input: V2Execution,
    preparation: WorkerEndpointOriginV2PublicationPreparation,
  ) => {
    const effects = preparation.effects;
    if (!effects) throw new Error("readback must not write");
    const mutation = await ownerStatement(input, preparation);
    const statements = [...effects.before, mutation, ...effects.after];
    for (const statement of statements)
      expect(statement.params?.length ?? 0).toBeLessThanOrEqual(100);
    return sql.batch(statements);
  };
  return {
    sql,
    ledger,
    engine,
    store,
    held,
    endpoint,
    execution,
    worker,
    deployment,
    receiver,
    raw: () => raw,
    db: () => db,
    batches,
    claim,
    settle,
    fail,
    publish,
    ownerStatement,
    options,
    loseAck() {
      loseAck = true;
    },
    holdRead() {
      let entered!: () => void;
      let release!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      readGate = { entered, wait };
      return { entered: enteredPromise, release };
    },
    reopen() {
      db.close();
      db = new Database(path);
      raw = createSqliteSql(db);
      const reopened = createSqliteSql(db);
      const reopenedLedger = createSharedAppLedger({
        environment: "staging",
        primary: () => reopened,
      });
      return { sql: reopened, ledger: reopenedLedger };
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function prepared(f: Fixture, input = f.execution) {
  const result = await f.receiver().prepare(input);
  expect(result.kind).toBe("shared");
  if (result.kind !== "shared") throw new Error("actual binding was refused");
  return result.preparation;
}

function effectsEmpty(f: Fixture) {
  for (const table of [HISTORY, "shared_app_staging_batch_assertions"])
    expect(f.db().query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  expect(
    f
      .db()
      .query(`SELECT count(*) AS n FROM cloudflare_managed_worker_routes
    WHERE route_kind='host'`)
      .get(),
  ).toEqual({ n: 0 });
}

test("actual acceptance binding publishes once with original Endpoint command and retained native Deployment identity", async () => {
  const f = await fixture();
  try {
    const preparation = await prepared(f);
    const effects = preparation.effects;
    if (!effects) throw new Error("missing fresh preparation");
    expect(effects.original.commandRef).toBe(`v2-host:${f.endpoint.id}:${HOSTNAME}`);
    expect(effects.original.sourceOperationId).toBe(f.endpoint.id);
    expect(await preparation.observe()).toBe("unknown");
    const result = await f.publish(f.execution, preparation);
    expect(result[effects.before.length]?.changes).toBe(1);
    expect(await preparation.observe()).toBe("confirmed");
    expect(
      f
        .db()
        .query(`SELECT operation_id FROM cloudflare_managed_worker_routes
      WHERE route_kind='host'`)
        .get(),
    ).toEqual({ operation_id: `v2-host:${f.deployment.id}:${HOSTNAME}` });
    const replay = await prepared(f);
    expect(replay.effects).toBeUndefined();
    const writes = f.batches.length;
    expect(await replay.observe()).toBe("confirmed");
    expect(f.batches.length).toBe(writes);
    expect(f.db().query(`SELECT count(*) AS n FROM ${HISTORY}`).get()).toEqual({ n: 1 });
  } finally {
    f.close();
  }
});

test("missing actual owner mutation hits terminal CHECK and rolls back every prepared effect", async () => {
  const f = await fixture();
  try {
    const preparation = await prepared(f);
    const effects = preparation.effects;
    if (!effects) throw new Error("missing fresh preparation");
    await expect(f.sql.batch([...effects.before, ...effects.after])).rejects.toMatchObject({
      code: "constraint",
      message: expect.stringContaining("CHECK constraint failed"),
    });
    effectsEmpty(f);
    expect(await f.ledger.forTrustedOwner(OWNER).readOriginal(f.held.reservationId)).toEqual(
      f.held,
    );
    expect(await preparation.observe()).toBe("unknown");
  } finally {
    f.close();
  }
});

test("one real SQLite batch prevents stale binding or native CAS from committing ledger history", async () => {
  for (const race of ["binding", "native"] as const) {
    const f = await fixture();
    try {
      const preparation = await prepared(f);
      const mutation = await f.ownerStatement(f.execution, preparation);
      if (race === "binding")
        f.db().query(`UPDATE ${BINDINGS} SET current_operation_id=?`).run(f.deployment.id);
      else
        await f.raw().run(
          `INSERT INTO cloudflare_managed_worker_routes
          (provider_id,route_kind,route_key,owner_native_id,generation,operation_id,state,value_json)
          VALUES (?,'host',?,'foreign-owner',1,'foreign-route','active','{}')`,
          [PROVIDER, `host/v2/${HOSTNAME}`],
        );
      const effects = preparation.effects;
      if (!effects) throw new Error("missing fresh preparation");
      await expect(
        f.sql.batch([...effects.before, mutation, ...effects.after]),
      ).rejects.toMatchObject({
        code: "constraint",
        message: expect.stringContaining("CHECK constraint failed"),
      });
      expect(f.db().query(`SELECT count(*) AS n FROM ${HISTORY}`).get()).toEqual({ n: 0 });
      expect(await f.ledger.forTrustedOwner(OWNER).readOriginal(f.held.reservationId)).toEqual(
        f.held,
      );
      expect(await preparation.observe()).toBe("unknown");
    } finally {
      f.close();
    }
  }
});

test("same-worker UPDATE advances binding and original history while native ID stays; DELETE retires last live binding without release", async () => {
  const f = await fixture();
  try {
    await f.publish(f.execution, await prepared(f));
    await f.settle(f.execution);
    const updated = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "fixture-update-original",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 1,
      spec: f.execution.spec,
    });
    const update = await f.claim(updated.id);
    const preparation = await prepared(f, update);
    expect(preparation.effects?.original.commandRef).toBe(`v2-host:${updated.id}:${HOSTNAME}`);
    await f.publish(update, preparation);
    expect(await preparation.observe()).toBe("confirmed");
    expect(
      f
        .db()
        .query(`SELECT operation_id FROM cloudflare_managed_worker_routes WHERE route_kind='host'`)
        .get(),
    ).toEqual({ operation_id: `v2-host:${f.deployment.id}:${HOSTNAME}` });
    await f.settle(update);
    const deleted = await f.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "fixture-delete-original",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 2,
    });
    const deletion = await f.claim(deleted.id);
    const retiring = await prepared(f, deletion);
    await f.publish(deletion, retiring);
    expect(await retiring.observe()).toBe("retired");
    expect(await f.ledger.forTrustedOwner(OWNER).readOriginal(f.held.reservationId)).toMatchObject({
      incarnation: f.held.incarnation,
      generation: 4,
      state: "reserved",
      script: null,
      releasedAt: null,
    });
    expect(
      f
        .db()
        .query(
          `SELECT endpoint_generation,create_operation_id,current_operation_id FROM ${BINDINGS}`,
        )
        .get(),
    ).toEqual({
      endpoint_generation: 2,
      create_operation_id: f.endpoint.id,
      current_operation_id: updated.id,
    });
    expect(f.db().query(`SELECT count(*) AS n FROM ${HISTORY}`).get()).toEqual({ n: 3 });
  } finally {
    f.close();
  }
});

test("failed no-effect CREATE can be deleted without inventing a live route or ledger history", async () => {
  const f = await fixture();
  try {
    await f.fail(f.execution);
    const deleted = await f.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "fixture-delete-failed-create",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 1,
    });
    const deletion = await f.claim(deleted.id);
    expect(deletion.generation).toBe(2);
    const writes = f.batches.length;
    const preparation = await prepared(f, deletion);
    expect(preparation.effects).toBeUndefined();
    expect(await preparation.observe()).toBe("retired");
    expect(f.batches.length).toBe(writes);
    effectsEmpty(f);
    expect(await f.ledger.forTrustedOwner(OWNER).readOriginal(f.held.reservationId)).toEqual(
      f.held,
    );
    expect(
      f.db().query(`SELECT endpoint_generation,current_operation_id FROM ${BINDINGS}`).get(),
    ).toEqual({ endpoint_generation: 1, current_operation_id: f.endpoint.id });
    await f.settle(deletion);
    expect(await f.store.resource(f.endpoint.resourceUid)).toMatchObject({
      deleted_at: AT,
      busy_operation: null,
      generation: 2,
    });
  } finally {
    f.close();
  }
});

test("DELETE retires last confirmed live generation across consecutive failed no-effect UPDATEs and recovers its lost ACK", async () => {
  const f = await fixture();
  try {
    await f.publish(f.execution, await prepared(f));
    await f.settle(f.execution);
    let lastUpdateId = "";
    for (const generation of [1, 2]) {
      const accepted = await f.engine.acceptUpdate({
        principal: PRINCIPAL,
        key: `fixture-failed-update-${generation}`,
        uid: f.endpoint.resourceUid,
        expectedGeneration: generation,
        spec: f.execution.spec,
      });
      lastUpdateId = accepted.id;
      await f.fail(await f.claim(accepted.id));
    }
    expect(
      f.db().query(`SELECT endpoint_generation,current_operation_id FROM ${BINDINGS}`).get(),
    ).toEqual({ endpoint_generation: 3, current_operation_id: lastUpdateId });
    const prior = f
      .db()
      .query<{ value_json: unknown }, []>(
        `SELECT value_json FROM cloudflare_managed_worker_routes WHERE route_kind='host'`,
      )
      .get();
    if (!prior || typeof prior.value_json !== "string")
      throw new Error("missing live native route");
    expect(JSON.parse(prior.value_json).endpointGeneration).toBe(1);
    const deleted = await f.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "fixture-delete-after-failed-updates",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 3,
    });
    const deletion = await f.claim(deleted.id);
    expect(deletion.generation).toBe(4);
    const retiring = await prepared(f, deletion);
    expect(retiring.effects?.original.endpointGeneration).toBe(4);
    f.loseAck();
    await expect(f.publish(deletion, retiring)).rejects.toBeInstanceOf(SqlError);
    expect(await retiring.observe()).toBe("retired");
    const writes = f.batches.length;
    const reopened = f.reopen();
    const replay = await f.receiver(reopened.sql, reopened.ledger).prepare(deletion);
    expect(replay.kind).toBe("shared");
    if (replay.kind !== "shared") throw new Error("lost DELETE ACK lost its actual original");
    expect(replay.preparation.effects).toBeUndefined();
    expect(await replay.preparation.observe()).toBe("retired");
    expect(f.batches.length).toBe(writes);
    expect(
      f
        .db()
        .query(`SELECT endpoint_generation,action FROM ${HISTORY} ORDER BY next_generation`)
        .all(),
    ).toEqual([
      { endpoint_generation: 1, action: "activate" },
      { endpoint_generation: 4, action: "retire" },
    ]);
    expect(
      await reopened.ledger.forTrustedOwner(OWNER).readOriginal(f.held.reservationId),
    ).toMatchObject({
      incarnation: f.held.incarnation,
      generation: 3,
      state: "reserved",
      releasedAt: null,
    });
    expect(
      f.db().query(`SELECT endpoint_generation,current_operation_id FROM ${BINDINGS}`).get(),
    ).toEqual({ endpoint_generation: 3, current_operation_id: lastUpdateId });
  } finally {
    f.close();
  }
});

test("repeated no-effect DELETEs keep the actual older binding and never-live cleanup invents no history", async () => {
  const f = await fixture();
  try {
    await f.fail(f.execution);
    for (const generation of [1, 2]) {
      const deleted = await f.engine.acceptDelete({
        principal: PRINCIPAL,
        key: `fixture-repeated-delete-${generation}`,
        uid: f.endpoint.resourceUid,
        expectedGeneration: generation,
      });
      await f.fail(await f.claim(deleted.id));
    }
    const request = {
      principal: PRINCIPAL,
      key: "fixture-repeated-delete-final",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 3,
    };
    const accepted = await f.engine.acceptDelete(request);
    const deletion = await f.claim(accepted.id);
    const writes = f.batches.length;
    const preparation = await prepared(f, deletion);
    expect(preparation.effects).toBeUndefined();
    expect(await preparation.observe()).toBe("retired");
    expect(f.batches.length).toBe(writes);
    effectsEmpty(f);
    expect(
      f.db().query(`SELECT endpoint_generation,current_operation_id FROM ${BINDINGS}`).get(),
    ).toEqual({ endpoint_generation: 1, current_operation_id: f.endpoint.id });
    await f.settle(deletion);
    expect((await f.engine.acceptDelete(request)).id).toBe(accepted.id);
    const operations = f.db().query("SELECT id FROM tf_v2_operations ORDER BY id").all();
    await expect(
      f.engine.acceptDelete({
        ...request,
        key: "fixture-repeated-delete-after-success",
        expectedGeneration: 4,
      }),
    ).rejects.toMatchObject({ code: "gone", status: 410 });
    expect(f.db().query("SELECT id FROM tf_v2_operations ORDER BY id").all()).toEqual(operations);
    effectsEmpty(f);
  } finally {
    f.close();
  }
});

test("serving DELETE pins live, binding and accepted generations independently and atomically fences an earlier DELETE effect", async () => {
  const f = await fixture();
  try {
    await f.publish(f.execution, await prepared(f));
    await f.settle(f.execution);
    const updated = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "fixture-update-before-delete-retry",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 1,
      spec: f.execution.spec,
    });
    await f.fail(await f.claim(updated.id));
    const earlier = await f.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "fixture-delete-before-delete-retry",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 2,
    });
    await f.fail(await f.claim(earlier.id));
    const deleted = await f.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "fixture-serving-delete-retry",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 3,
    });
    const deletion = await f.claim(deleted.id);
    const retiring = await prepared(f, deletion);
    expect(retiring.effects?.original.endpointGeneration).toBe(4);
    expect(retiring.effects?.original.commandRef).toBe(`v2-host:${deleted.id}:${HOSTNAME}`);
    const currentBinding = f.db().query(`SELECT * FROM ${BINDINGS}`).all();
    const boundOperation = await f.store.operation(updated.id);
    f.db().query("UPDATE tf_v2_operations SET effect='partial' WHERE id=?").run(earlier.id);
    const tables = [
      "shared_app_staging_names",
      "shared_app_staging_assignments",
      HISTORY,
      "shared_app_staging_batch_assertions",
      BINDINGS,
      "cloudflare_managed_worker_routes",
    ];
    const before = tables.map((table) => f.db().query(`SELECT * FROM ${table}`).all());
    await expect(f.publish(deletion, retiring)).rejects.toMatchObject({
      code: "constraint",
      message: expect.stringContaining("CHECK constraint failed"),
    });
    for (const [index, table] of tables.entries()) {
      const expected = before[index];
      if (expected === undefined) throw new Error("missing paired durable snapshot");
      expect(f.db().query(`SELECT * FROM ${table}`).all()).toEqual(expected);
    }
    expect(f.db().query(`SELECT * FROM ${BINDINGS}`).all()).toEqual(currentBinding);
    expect(await f.store.operation(updated.id)).toEqual(boundOperation);
    expect(await retiring.observe()).toBe("unknown");
    f.db().query("UPDATE tf_v2_operations SET effect='none' WHERE id=?").run(earlier.id);
    const retry = await prepared(f, deletion);
    await f.publish(deletion, retry);
    expect(await retry.observe()).toBe("retired");
    expect(
      f
        .db()
        .query(`SELECT endpoint_generation,action FROM ${HISTORY} ORDER BY next_generation`)
        .all(),
    ).toEqual([
      { endpoint_generation: 1, action: "activate" },
      { endpoint_generation: 4, action: "retire" },
    ]);
    expect(
      f.db().query(`SELECT endpoint_generation,current_operation_id FROM ${BINDINGS}`).get(),
    ).toEqual({ endpoint_generation: 2, current_operation_id: updated.id });
  } finally {
    f.close();
  }
});

test("partial DELETE lineage refuses cleanup while unknown DELETE stays busy without accepting a successor", async () => {
  for (const effect of ["partial", "unknown"] as const) {
    const f = await fixture();
    try {
      await f.publish(f.execution, await prepared(f));
      await f.settle(f.execution);
      const deleted = await f.engine.acceptDelete({
        principal: PRINCIPAL,
        key: `fixture-${effect}-delete-predecessor`,
        uid: f.endpoint.resourceUid,
        expectedGeneration: 1,
      });
      const deletion = await f.claim(deleted.id);
      const tables = [HISTORY, BINDINGS, "cloudflare_managed_worker_routes"];
      const before = tables.map((table) => f.db().query(`SELECT * FROM ${table}`).all());
      const writes = f.batches.length;
      let expectedWrites = writes;
      if (effect === "partial") {
        await f.fail(deletion, effect);
        const next = await f.engine.acceptDelete({
          principal: PRINCIPAL,
          key: "fixture-delete-after-partial-delete",
          uid: f.endpoint.resourceUid,
          expectedGeneration: 2,
        });
        const nextExecution = await f.claim(next.id);
        const acceptedBatches = f.batches.slice(writes);
        expect(acceptedBatches).toHaveLength(1);
        const acceptedBatch = acceptedBatches[0];
        if (!acceptedBatch) throw new Error("missing actual Core acceptance batch");
        expect(
          acceptedBatch.some((statement) =>
            /^\s*INSERT INTO tf_v2_operations\b/u.test(statement.sql),
          ),
        ).toBe(true);
        for (const statement of acceptedBatch)
          expect(statement.sql).not.toMatch(/shared_app_|cloudflare_managed_worker_routes/u);
        expectedWrites = f.batches.length;
        expect(await f.receiver().prepare(nextExecution)).toEqual({ kind: "refused" });
      } else {
        expect(
          await f.store.settle({
            id: deletion.operationId,
            token: deletion.leaseToken,
            status: "reconciling",
            effect: "unknown",
            at: AT,
            retainUntil: "2026-10-15T01:00:00.000Z",
          }),
        ).toBe(true);
        const operations = f.db().query("SELECT id FROM tf_v2_operations ORDER BY id").all();
        await expect(
          f.engine.acceptDelete({
            principal: PRINCIPAL,
            key: "fixture-delete-after-unknown-delete",
            uid: f.endpoint.resourceUid,
            expectedGeneration: 2,
          }),
        ).rejects.toMatchObject({ code: "resource_busy", status: 409 });
        expect(f.db().query("SELECT id FROM tf_v2_operations ORDER BY id").all()).toEqual(
          operations,
        );
      }
      // Core may accept a successor after partial, but no serving/history write is authorized.
      for (const [index, table] of tables.entries()) {
        const expected = before[index];
        if (expected === undefined) throw new Error("missing paired durable snapshot");
        expect(f.db().query(`SELECT * FROM ${table}`).all()).toEqual(expected);
      }
      expect(f.batches.length).toBe(expectedWrites);
    } finally {
      f.close();
    }
  }
});

test("accepted UPDATE publishes after a failed no-effect UPDATE or DELETE and lost ACK retains the actual prior live proof", async () => {
  for (const predecessor of ["update", "delete"] as const) {
    const f = await fixture();
    try {
      await f.publish(f.execution, await prepared(f));
      await f.settle(f.execution);
      const prior =
        predecessor === "update"
          ? await f.engine.acceptUpdate({
              principal: PRINCIPAL,
              key: "fixture-failed-update-reapply",
              uid: f.endpoint.resourceUid,
              expectedGeneration: 1,
              spec: f.execution.spec,
            })
          : await f.engine.acceptDelete({
              principal: PRINCIPAL,
              key: "fixture-failed-delete-reapply",
              uid: f.endpoint.resourceUid,
              expectedGeneration: 1,
            });
      await f.fail(await f.claim(prior.id));
      const updated = await f.engine.acceptUpdate({
        principal: PRINCIPAL,
        key: `fixture-reapply-after-${predecessor}`,
        uid: f.endpoint.resourceUid,
        expectedGeneration: 2,
        spec: f.execution.spec,
      });
      const execution = await f.claim(updated.id);
      const preparation = await prepared(f, execution);
      expect(preparation.effects?.original).toMatchObject({
        action: "advance",
        endpointGeneration: 3,
        sourceOperationId: updated.id,
        commandRef: `v2-host:${updated.id}:${HOSTNAME}`,
      });
      f.loseAck();
      await expect(f.publish(execution, preparation)).rejects.toBeInstanceOf(SqlError);
      const writes = f.batches.length;
      const reopened = f.reopen();
      const replay = await f.receiver(reopened.sql, reopened.ledger).prepare(execution);
      expect(replay.kind).toBe("shared");
      if (replay.kind !== "shared") throw new Error("reapplied UPDATE lost its real prior history");
      expect(replay.preparation.effects).toBeUndefined();
      expect(await replay.preparation.observe()).toBe("confirmed");
      expect(f.batches.length).toBe(writes);
      expect(
        f
          .db()
          .query(`SELECT endpoint_generation,action FROM ${HISTORY} ORDER BY next_generation`)
          .all(),
      ).toEqual([
        { endpoint_generation: 1, action: "activate" },
        { endpoint_generation: 3, action: "advance" },
      ]);
      expect(
        f
          .db()
          .query(
            `SELECT endpoint_generation,current_operation_id,create_operation_id FROM ${BINDINGS}`,
          )
          .get(),
      ).toEqual({
        endpoint_generation: 3,
        current_operation_id: updated.id,
        create_operation_id: f.endpoint.id,
      });
    } finally {
      f.close();
    }
  }
});

test("first publication UPDATE after a failed no-effect CREATE activates only its unchanged original and later DELETE retires it", async () => {
  for (const intermediateDelete of [false, true]) {
    const f = await fixture();
    try {
      await f.fail(f.execution);
      if (intermediateDelete) {
        const deleted = await f.engine.acceptDelete({
          principal: PRINCIPAL,
          key: "fixture-first-publication-failed-delete",
          uid: f.endpoint.resourceUid,
          expectedGeneration: 1,
        });
        await f.fail(await f.claim(deleted.id));
      }
      const generation = intermediateDelete ? 3 : 2;
      const updated = await f.engine.acceptUpdate({
        principal: PRINCIPAL,
        key: "fixture-first-publication-update",
        uid: f.endpoint.resourceUid,
        expectedGeneration: generation - 1,
        spec: f.execution.spec,
      });
      const execution = await f.claim(updated.id);
      effectsEmpty(f);
      expect(await f.ledger.forTrustedOwner(OWNER).readOriginal(f.held.reservationId)).toEqual(
        f.held,
      );
      const preparation = await prepared(f, execution);
      expect(preparation.effects?.original).toMatchObject({
        action: "activate",
        endpointGeneration: generation,
        sourceOperationId: updated.id,
        commandRef: `v2-host:${updated.id}:${HOSTNAME}`,
        incarnation: f.held.incarnation,
        expectedGeneration: f.held.generation,
      });
      await f.publish(execution, preparation);
      expect(await preparation.observe()).toBe("confirmed");
      const replay = await prepared(f, execution);
      expect(replay.effects).toBeUndefined();
      expect(await replay.observe()).toBe("confirmed");
      await f.settle(execution);
      expect(await f.store.operation(f.endpoint.id)).toMatchObject({
        status: "failed",
        effect: "none",
      });
      const deleted = await f.engine.acceptDelete({
        principal: PRINCIPAL,
        key: "fixture-delete-recovered-first-publication",
        uid: f.endpoint.resourceUid,
        expectedGeneration: generation,
      });
      const deletion = await f.claim(deleted.id);
      const retirement = await prepared(f, deletion);
      await f.publish(deletion, retirement);
      expect(await retirement.observe()).toBe("retired");
      expect(
        f
          .db()
          .query(`SELECT endpoint_generation,action FROM ${HISTORY} ORDER BY next_generation`)
          .all(),
      ).toEqual([
        { endpoint_generation: generation, action: "activate" },
        { endpoint_generation: generation + 1, action: "retire" },
      ]);
      expect(
        await f.ledger.forTrustedOwner(OWNER).readOriginal(f.held.reservationId),
      ).toMatchObject({
        incarnation: f.held.incarnation,
        state: "reserved",
        generation: 3,
        releasedAt: null,
      });
    } finally {
      f.close();
    }
  }
});

test("UPDATE refuses partial or succeeded-without-history predecessors and unknown predecessor remains busy", async () => {
  for (const outcome of ["partial", "unknown", "succeeded-without-history"] as const) {
    const f = await fixture();
    try {
      await f.publish(f.execution, await prepared(f));
      await f.settle(f.execution);
      const updated = await f.engine.acceptUpdate({
        principal: PRINCIPAL,
        key: `fixture-${outcome}-update`,
        uid: f.endpoint.resourceUid,
        expectedGeneration: 1,
        spec: f.execution.spec,
      });
      const execution = await f.claim(updated.id);
      if (outcome === "partial") await f.fail(execution, "partial");
      else if (outcome === "succeeded-without-history") await f.settle(execution);
      else
        expect(
          await f.store.settle({
            id: execution.operationId,
            token: execution.leaseToken,
            status: "reconciling",
            effect: "unknown",
            at: AT,
            retainUntil: "2026-10-15T01:00:00.000Z",
          }),
        ).toBe(true);
      const tables = [
        HISTORY,
        "shared_app_staging_names",
        "shared_app_staging_assignments",
        "cloudflare_managed_worker_routes",
      ];
      const before = tables.map((table) => f.db().query(`SELECT * FROM ${table}`).all());
      const request = {
        principal: PRINCIPAL,
        key: `fixture-next-after-${outcome}`,
        uid: f.endpoint.resourceUid,
        expectedGeneration: 2,
        spec: f.execution.spec,
      };
      if (outcome === "unknown")
        await expect(f.engine.acceptUpdate(request)).rejects.toMatchObject({
          code: "resource_busy",
          status: 409,
        });
      else {
        const next = await f.engine.acceptUpdate(request);
        expect(await f.receiver().prepare(await f.claim(next.id))).toEqual({ kind: "refused" });
      }
      for (const [index, table] of tables.entries()) {
        const expected = before[index];
        if (expected === undefined) throw new Error("missing paired durable snapshot");
        expect(f.db().query(`SELECT * FROM ${table}`).all()).toEqual(expected);
      }
    } finally {
      f.close();
    }
  }
});

test("UPDATE rechecks mixed earlier UPDATE and DELETE lineage inside its own native and ledger batch", async () => {
  const f = await fixture();
  try {
    await f.publish(f.execution, await prepared(f));
    await f.settle(f.execution);
    const earlier = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "fixture-update-before-mixed-reapply",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 1,
      spec: f.execution.spec,
    });
    await f.fail(await f.claim(earlier.id));
    const deleted = await f.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "fixture-delete-before-mixed-reapply",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 2,
    });
    await f.fail(await f.claim(deleted.id));
    const updated = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "fixture-update-after-mixed-reapply",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 3,
      spec: f.execution.spec,
    });
    const execution = await f.claim(updated.id);
    const preparation = await prepared(f, execution);
    const current = await f.store.operation(updated.id);
    f.db().query("UPDATE tf_v2_operations SET effect='partial' WHERE id=?").run(earlier.id);
    const tables = [
      HISTORY,
      BINDINGS,
      "shared_app_staging_names",
      "shared_app_staging_assignments",
      "shared_app_staging_batch_assertions",
      "cloudflare_managed_worker_routes",
    ];
    const before = tables.map((table) => f.db().query(`SELECT * FROM ${table}`).all());
    await expect(f.publish(execution, preparation)).rejects.toMatchObject({
      code: "constraint",
      message: expect.stringContaining("CHECK constraint failed"),
    });
    expect(await preparation.observe()).toBe("unknown");
    expect(await f.store.operation(updated.id)).toEqual(current);
    for (const [index, table] of tables.entries()) {
      const expected = before[index];
      if (expected === undefined) throw new Error("missing paired durable snapshot");
      expect(f.db().query(`SELECT * FROM ${table}`).all()).toEqual(expected);
    }
  } finally {
    f.close();
  }
});

test("partial CREATE effects refuse accepted DELETE cleanup while unknown CREATE remains busy", async () => {
  for (const effect of ["partial", "unknown"] as const) {
    const f = await fixture();
    try {
      if (effect === "unknown") {
        const beforeBinding = f.db().query(`SELECT * FROM ${BINDINGS}`).all();
        const beforeOperations = f.db().query("SELECT id FROM tf_v2_operations ORDER BY id").all();
        const writes = f.batches.length;
        expect(
          await f.store.settle({
            id: f.execution.operationId,
            token: f.execution.leaseToken,
            status: "reconciling",
            effect: "unknown",
            at: AT,
            retainUntil: "2026-10-15T01:00:00.000Z",
          }),
        ).toBe(true);
        expect(await f.store.operation(f.execution.operationId)).toMatchObject({
          status: "reconciling",
          effect: "unknown",
        });
        await expect(
          f.engine.acceptDelete({
            principal: PRINCIPAL,
            key: "fixture-delete-unknown-create",
            uid: f.endpoint.resourceUid,
            expectedGeneration: 1,
          }),
        ).rejects.toMatchObject({ code: "resource_busy", status: 409 });
        expect(await f.store.resource(f.endpoint.resourceUid)).toMatchObject({
          generation: 1,
          busy_operation: f.execution.operationId,
        });
        expect(f.db().query(`SELECT * FROM ${BINDINGS}`).all()).toEqual(beforeBinding);
        expect(f.db().query("SELECT id FROM tf_v2_operations ORDER BY id").all()).toEqual(
          beforeOperations,
        );
        expect(f.batches.length).toBe(writes);
        effectsEmpty(f);
        continue;
      }
      await f.fail(f.execution, effect);
      const deleted = await f.engine.acceptDelete({
        principal: PRINCIPAL,
        key: `fixture-delete-${effect}-create`,
        uid: f.endpoint.resourceUid,
        expectedGeneration: 1,
      });
      const deletion = await f.claim(deleted.id);
      const writes = f.batches.length;
      expect(await f.receiver().prepare(deletion)).toEqual({ kind: "refused" });
      expect(f.batches.length).toBe(writes);
      effectsEmpty(f);
    } finally {
      f.close();
    }
  }
});

test("failed UPDATE interval is rechecked inside the retirement batch and corrupt or partial lineage cannot retire", async () => {
  const f = await fixture();
  try {
    await f.publish(f.execution, await prepared(f));
    await f.settle(f.execution);
    const updated = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "fixture-failed-update-cas",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 1,
      spec: f.execution.spec,
    });
    await f.fail(await f.claim(updated.id));
    const lastUpdate = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "fixture-failed-update-cas-second",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 2,
      spec: f.execution.spec,
    });
    await f.fail(await f.claim(lastUpdate.id));
    const currentBinding = f.db().query(`SELECT * FROM ${BINDINGS}`).all();
    const currentOperation = await f.store.operation(lastUpdate.id);
    const deleted = await f.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "fixture-delete-interval-cas",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 3,
    });
    const deletion = await f.claim(deleted.id);
    const earlierOperation = await f.store.operation(updated.id);
    // Accepted identity cannot be corrupted through the actual canonical schema.
    expect(() =>
      f
        .db()
        .query("UPDATE tf_v2_operations SET accepted_spec_json='{}' WHERE id=?")
        .run(updated.id),
    ).toThrow("tf_v2_operation_identity_immutable");
    expect(await f.store.operation(updated.id)).toEqual(earlierOperation);
    // Effect-only drift is permitted by the physical failed/partial CHECK. The
    // unchanged identity and bound-current Operation must not authorize it.
    f.db().query("UPDATE tf_v2_operations SET effect='partial' WHERE id=?").run(updated.id);
    expect(await f.receiver().prepare(deletion)).toEqual({ kind: "refused" });
    f.db().query("UPDATE tf_v2_operations SET effect='none' WHERE id=?").run(updated.id);
    const retiring = await prepared(f, deletion);
    // A change after preparation must fail the same atomic batch, not just its initial read.
    f.db().query("UPDATE tf_v2_operations SET effect='partial' WHERE id=?").run(updated.id);
    expect(f.db().query(`SELECT * FROM ${BINDINGS}`).all()).toEqual(currentBinding);
    expect(await f.store.operation(lastUpdate.id)).toEqual(currentOperation);
    const durableTables = [
      "shared_app_staging_names",
      "shared_app_staging_assignments",
      HISTORY,
      "shared_app_staging_batch_assertions",
      BINDINGS,
      "cloudflare_managed_worker_routes",
    ];
    const beforeRollback = durableTables.map((table) =>
      f.db().query(`SELECT * FROM ${table}`).all(),
    );
    await expect(f.publish(deletion, retiring)).rejects.toMatchObject({
      code: "constraint",
      message: expect.stringContaining("CHECK constraint failed"),
    });
    for (const [index, table] of durableTables.entries()) {
      const expected = beforeRollback[index];
      if (expected === undefined) throw new Error("missing paired durable snapshot");
      expect(f.db().query(`SELECT * FROM ${table}`).all()).toEqual(expected);
    }
    expect(await retiring.observe()).toBe("unknown");
    expect(f.db().query(`SELECT count(*) AS n FROM ${HISTORY}`).get()).toEqual({ n: 1 });
    expect(
      f
        .db()
        .query(
          `SELECT state,generation FROM cloudflare_managed_worker_routes WHERE route_kind='host'`,
        )
        .get(),
    ).toEqual({ state: "active", generation: 1 });
    expect(await f.ledger.forTrustedOwner(OWNER).readOriginal(f.held.reservationId)).toMatchObject({
      state: "active",
      generation: 2,
    });
  } finally {
    f.close();
  }
});

test("owning Endpoint validator rejects a different ready Worker before accepting a new binding generation", async () => {
  const f = await fixture();
  try {
    await f.publish(f.execution, await prepared(f));
    await f.settle(f.execution);
    const other = await f.engine.acceptCreate({
      principal: PRINCIPAL,
      key: "fixture-create-another-worker",
      input: { form: WORKER, space: ORGANIZATION, name: "another-worker", spec: {} },
    });
    expect(await f.engine.runNext()).toMatchObject({ id: other.id, status: "succeeded" });
    const beforeBinding = f.db().query(`SELECT * FROM ${BINDINGS}`).all();
    const beforeOperations = f.db().query("SELECT id FROM tf_v2_operations ORDER BY id").all();
    await expect(
      f.engine.acceptUpdate({
        principal: PRINCIPAL,
        key: "fixture-update-different-worker",
        uid: f.endpoint.resourceUid,
        expectedGeneration: 1,
        spec: { worker: { resourceUid: other.resourceUid } },
      }),
    ).rejects.toMatchObject({ code: "invalid_spec" });
    expect(f.db().query(`SELECT * FROM ${BINDINGS}`).all()).toEqual(beforeBinding);
    expect(f.db().query("SELECT id FROM tf_v2_operations ORDER BY id").all()).toEqual(
      beforeOperations,
    );
    expect(f.db().query(`SELECT count(*) AS n FROM ${HISTORY}`).get()).toEqual({ n: 1 });
  } finally {
    f.close();
  }
});

test("lost batch ACK reconciles from an actual reopened SQLite connection without a second write", async () => {
  const f = await fixture();
  try {
    const preparation = await prepared(f);
    f.loseAck();
    await expect(f.publish(f.execution, preparation)).rejects.toBeInstanceOf(SqlError);
    const writes = f.batches.length;
    const reopened = f.reopen();
    const result = await f.receiver(reopened.sql, reopened.ledger).prepare(f.execution);
    expect(result.kind).toBe("shared");
    if (result.kind !== "shared") throw new Error("original lost ACK was refused");
    expect(result.preparation.effects).toBeUndefined();
    expect(await result.preparation.observe()).toBe("confirmed");
    expect(f.batches.length).toBe(writes);
    expect(f.db().query(`SELECT count(*) AS n FROM ${HISTORY}`).get()).toEqual({ n: 1 });
  } finally {
    f.close();
  }
});

test("captured input is immutable across the first await and a different atomic Sql is refused", async () => {
  const f = await fixture();
  try {
    const receiver = f.receiver();
    expect(() => receiver.assertSql({ ...f.sql })).toThrow("same atomic Sql");
    const callerSpec = { worker: { resourceUid: f.worker.resourceUid } };
    const callerOutput = { hostname: HOSTNAME, url: `https://${HOSTNAME}/` };
    f.execution.spec = callerSpec;
    f.execution.previousOutput = callerOutput;
    const gate = f.holdRead();
    const promise = receiver.prepare(f.execution);
    await gate.entered;
    f.execution.principal = "org:foreign";
    f.execution.space = "foreign";
    f.execution.name = "foreign-name";
    callerSpec.worker = { resourceUid: "foreign-worker" };
    callerOutput.hostname = "foreign-name.app-staging.takos.jp";
    gate.release();
    const result = await promise;
    expect(result.kind).toBe("shared");
    if (result.kind !== "shared") throw new Error("captured original changed");
    expect(result.preparation.effects?.original).toMatchObject({
      organizationId: ORGANIZATION,
      name: NAME,
      workerUid: f.worker.resourceUid,
      commandRef: `v2-host:${f.endpoint.id}:${HOSTNAME}`,
    });
  } finally {
    f.close();
  }
});

test("missing, foreign, released and wrong original-create bindings refuse without native or ledger effects", async () => {
  for (const invalid of [
    "missing",
    "foreign",
    "released",
    "create-operation",
    "standalone-activate",
    "wrong-space",
  ] as const) {
    const f = await fixture();
    try {
      if (invalid === "missing") f.db().exec(`DELETE FROM ${BINDINGS}`);
      if (invalid === "foreign") f.db().exec(`UPDATE ${BINDINGS} SET organization_id='foreign'`);
      if (invalid === "released") await f.ledger.forTrustedOwner(OWNER).release(f.held);
      if (invalid === "create-operation")
        f.db().query(`UPDATE ${BINDINGS} SET create_operation_id=?`).run(f.deployment.id);
      if (invalid === "standalone-activate")
        await f.ledger.forTrustedOwner(OWNER).activate(f.held, SCRIPT);
      if (invalid === "wrong-space") f.execution.space = "foreign-space";
      expect(await f.receiver().prepare(f.execution)).toEqual({ kind: "refused" });
      effectsEmpty(f);
    } finally {
      f.close();
    }
  }
});

test("ordinary unbound output stays ordinary; shared multi-release input refuses rather than selecting its first script", async () => {
  const f = await fixture();
  try {
    const ordinary = createTakoformV2Engine(f.options);
    const accepted = await ordinary.acceptCreate({
      principal: PRINCIPAL,
      key: "fixture-ordinary-key",
      input: { form: FORM, space: ORGANIZATION, name: "ordinary-name", spec: f.execution.spec },
    });
    const input = await f.claim(accepted.id);
    const writes = f.batches.length;
    expect(await f.receiver().prepare(input)).toEqual({ kind: "ordinary" });
    expect(f.batches.length).toBe(writes);
    const rows = await f
      .raw()
      .query(`SELECT value_json FROM cloudflare_managed_worker_routes WHERE route_kind='worker'`);
    const value = rows[0]?.value_json;
    if (typeof value !== "string") throw new Error("missing actual native Worker route");
    const worker = JSON.parse(value);
    worker.releases[0].weight = 5_000;
    worker.releases.push({
      ...worker.releases[0],
      versionUid: "second-version",
      scriptName: "second-script",
    });
    await f
      .raw()
      .run(`UPDATE cloudflare_managed_worker_routes SET value_json=? WHERE route_kind='worker'`, [
        JSON.stringify(worker),
      ]);
    expect(await f.receiver().prepare(f.execution)).toEqual({ kind: "refused" });
    effectsEmpty(f);
  } finally {
    f.close();
  }
});
