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
import { canonicalJson } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { type JsonObject, type Sql, SqlError, type SqlStatement } from "../src/ports.ts";
import {
  createSharedAppLedger,
  type SharedAppNativeRouteRowPin,
} from "../src/shared-app-ledger.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { referencesForWorkerForm } from "../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
  parseWorkerDeploymentSpec,
  parseWorkerEndpointSpec,
  parseWorkerVersionSpec,
  validateWorkerDeploymentUpdate,
  validateWorkerEndpointUpdate,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import { createV2NativeEffectCustody } from "../src/takoform-v2/worker-native-effects.ts";
import {
  createWorkerEndpointOriginV2Acceptance,
  createWorkerEndpointOriginV2FormRouteAcceptance,
  createWorkerEndpointOriginV2FormRoutePublication,
  createWorkerEndpointOriginV2Publication,
  type WorkerEndpointOriginV2FormRoutePreparation,
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

// Additive schema is UNALLOCATED and fixture-owned. Existing scalar fixture
// above keeps its original DDL, so these checks cannot mask a legacy regression.
function formRouteFixtureSchema(db: Database): void {
  db.exec(`CREATE TABLE shared_app_staging_assignments (
    incarnation TEXT PRIMARY KEY CHECK(length(incarnation)=32), name TEXT NOT NULL,
    organization_id TEXT NOT NULL, product TEXT NOT NULL CHECK(product IN ('takoserver','takosumi-hosted')),
    reservation_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740990),
    state TEXT NOT NULL CHECK(state IN ('reserved','active','released')), script TEXT, released_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, binding_kind TEXT, binding_json TEXT,
    UNIQUE(organization_id,reservation_id), CHECK(updated_at>=created_at), CHECK((state='released')=(released_at IS NOT NULL)),
    CHECK((binding_kind IS NULL AND binding_json IS NULL
      AND (state<>'reserved' OR script IS NULL) AND (state<>'active' OR script IS NOT NULL))
    OR (binding_kind IS 'form-v2@1' AND script IS NULL AND
      ((state IN ('reserved','released') AND binding_json IS NULL)
      OR (state='active' AND binding_json IS NOT NULL AND CASE WHEN json_valid(binding_json)=1
        THEN json_type(binding_json) IS 'object' AND json_extract(binding_json,'$.kind') IS 'form-v2@1' ELSE 0 END)))))`);
  db.exec(`CREATE TABLE shared_app_staging_names (
    normalized_name TEXT PRIMARY KEY, incarnation TEXT NOT NULL REFERENCES shared_app_staging_assignments(incarnation),
    generation INTEGER NOT NULL, state TEXT NOT NULL, released_at INTEGER, updated_at INTEGER NOT NULL,
    CHECK((state='released')=(released_at IS NOT NULL)))`);
  db.exec(`CREATE TABLE ${HISTORY} (
    organization_id TEXT NOT NULL, product TEXT NOT NULL, reservation_id TEXT NOT NULL, name TEXT NOT NULL,
    incarnation TEXT NOT NULL REFERENCES shared_app_staging_assignments(incarnation),
    action TEXT NOT NULL CHECK(action IN ('activate','advance','retire')), command_ref TEXT NOT NULL,
    prior_generation INTEGER NOT NULL, prior_state TEXT NOT NULL, prior_script TEXT, next_script TEXT,
    endpoint_uid TEXT NOT NULL, endpoint_generation INTEGER NOT NULL, worker_uid TEXT NOT NULL,
    deployment_uid TEXT NOT NULL, deployment_generation INTEGER NOT NULL, source_operation_id TEXT NOT NULL,
    provider_id TEXT NOT NULL, target_key TEXT NOT NULL, next_generation INTEGER NOT NULL, next_state TEXT NOT NULL,
    created_at INTEGER NOT NULL, form_v2_original_json TEXT,
    PRIMARY KEY(organization_id,command_ref), UNIQUE(incarnation,next_generation), CHECK(next_generation=prior_generation+1),
    CHECK((form_v2_original_json IS NULL
      AND ((action='activate' AND prior_state='reserved' AND prior_script IS NULL)
        OR (action<>'activate' AND prior_state='active' AND prior_script IS NOT NULL))
      AND ((action='retire' AND next_state='reserved' AND next_script IS NULL)
        OR (action<>'retire' AND next_state='active' AND next_script IS NOT NULL)))
    OR (form_v2_original_json IS NOT NULL AND CASE WHEN json_valid(form_v2_original_json)=1 THEN
      json_type(form_v2_original_json) IS 'object' AND json_extract(form_v2_original_json,'$.action') IS action
      AND ((action='activate' AND prior_state='reserved') OR (action<>'activate' AND prior_state='active'))
      AND ((json_extract(form_v2_original_json,'$.expected.kind') IS 'scalar'
        AND json_extract(form_v2_original_json,'$.expected.value.script') IS prior_script)
        OR (json_extract(form_v2_original_json,'$.expected.kind') IS 'form-v2@1' AND prior_script IS NULL))
      AND next_script IS NULL AND ((action='retire' AND next_state='reserved') OR (action<>'retire' AND next_state='active'))
      ELSE 0 END)))`);
  db.exec(`CREATE TABLE shared_app_staging_batch_assertions (
    witness TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1), apply_effects INTEGER NOT NULL CHECK(apply_effects IN (0,1)))`);
  db.exec(`CREATE TABLE ${BINDINGS} (
    incarnation TEXT PRIMARY KEY REFERENCES shared_app_staging_assignments(incarnation),
    organization_id TEXT NOT NULL, product TEXT NOT NULL, reservation_id TEXT NOT NULL, name TEXT NOT NULL,
    endpoint_uid TEXT NOT NULL UNIQUE REFERENCES tf_v2_resources(uid), endpoint_generation INTEGER NOT NULL CHECK(endpoint_generation>=1),
    form_url TEXT NOT NULL, backend_id TEXT NOT NULL, target_key TEXT NOT NULL,
    create_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id), current_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id))`);
}

async function formRouteFixture(releaseCount = 2, adopted = true) {
  const directory = mkdtempSync(join(tmpdir(), "form-route-receiver-"));
  const path = join(directory, "state.sqlite");
  let db = new Database(path);
  migrateSqlite(db);
  formRouteFixtureSchema(db);
  let raw = createSqliteSql(db);
  let loseAck = false;
  let reads = 0;
  let gate: { entered(): void; wait: Promise<void> } | null = null;
  const batches: (readonly SqlStatement[])[] = [];
  const sql: Sql = {
    async query(query, params) {
      reads++;
      if (gate) {
        const held = gate;
        gate = null;
        held.entered();
        await held.wait;
      }
      return raw.query(query, params);
    },
    run: (...args) => raw.run(...args),
    async batch(statements) {
      batches.push(statements);
      const result = await raw.batch(statements);
      if (loseAck) {
        loseAck = false;
        throw new SqlError("unavailable", "controlled native atom ACK lost");
      }
      return result;
    },
  };
  const nowMs = Date.now();
  const at = new Date(nowMs).toISOString();
  const backend = (id: string): V2Form["backend"] => ({
    id,
    targetKey: TARGET,
    async execute(input) {
      const selectedVersions = Array.isArray(input.spec.versions)
        ? input.spec.versions.map((item) => {
            const version = item as { workerVersion: { resourceUid: string }; weight: number };
            return { resourceUid: version.workerVersion.resourceUid, weight: version.weight };
          })
        : [];
      return {
        kind: "complete",
        observed: {
          ready: true,
          active: true,
          selectedVersions,
          tlsReady: true,
          activeDeploymentRouteReady: true,
        },
        output: input.previousOutput,
      };
    },
    async reconcile() {
      return { kind: "unknown" };
    },
  });
  const workerBackend = "weighted-worker-fixture";
  const versionBackend = "weighted-version-fixture";
  const deploymentBackend = "weighted-deployment-fixture";
  const endpointBackend = "weighted-endpoint-fixture";
  const declare = (
    form: string,
    validateCreate: (spec: unknown) => unknown,
    validateUpdate: (before: unknown, after: unknown) => unknown,
    id: string,
  ): V2Form => ({
    validateCreate,
    validateUpdate,
    backend: backend(id),
    references: (spec) => referencesForWorkerForm(form, spec),
  });
  const ledger = createSharedAppLedger({
    environment: "staging",
    primary: () => sql,
    clock: () => new Date(nowMs),
  });
  const forms: Record<string, V2Form> = {
    [MODULE_WORKER_FORM_URL]: declare(
      MODULE_WORKER_FORM_URL,
      parseModuleWorkerSpec,
      (_, next) => parseModuleWorkerSpec(next),
      workerBackend,
    ),
    [WORKER_VERSION_FORM_URL]: declare(
      WORKER_VERSION_FORM_URL,
      parseWorkerVersionSpec,
      (_, next) => parseWorkerVersionSpec(next),
      versionBackend,
    ),
    [WORKER_DEPLOYMENT_FORM_URL]: declare(
      WORKER_DEPLOYMENT_FORM_URL,
      parseWorkerDeploymentSpec,
      validateWorkerDeploymentUpdate,
      deploymentBackend,
    ),
    [WORKER_ENDPOINT_FORM_URL]: {
      ...declare(
        WORKER_ENDPOINT_FORM_URL,
        parseWorkerEndpointSpec,
        validateWorkerEndpointUpdate,
        endpointBackend,
      ),
      initialOutput: () => ({
        hostname: "ordinary.example.invalid",
        url: "https://ordinary.example.invalid/",
      }),
    },
    // Artifact bytes/provider compilation are outside this fixture. Every Core
    // reference/lease and0074 intent+receipt below is nevertheless real SQL custody.
    [WORKER_BUNDLE_FORM_URL]: {
      validateCreate() {},
      validateUpdate() {},
      backend: backend("weighted-bundle-fixture"),
    },
  };
  const engineOptions = {
    sql,
    forms,
    now: () => new Date(nowMs),
    replayWindowSeconds: 3600,
    authorize: async (principal: string, space: string) => principal === `org:${space}`,
  };
  const engine = createTakoformV2Engine(
    engineOptions,
    adopted
      ? createWorkerEndpointOriginV2FormRouteAcceptance({
          sql,
          ledger,
          formUrl: WORKER_ENDPOINT_FORM_URL,
          backendId: endpointBackend,
          targetKey: TARGET,
        })
      : undefined,
  );
  const store = createV2Store(sql);
  const accept = (form: string, name: string, spec: JsonObject) =>
    engine.acceptCreate({
      principal: PRINCIPAL,
      key: `weighted-create-${name}`,
      input: { form, space: ORGANIZATION, name, spec },
    });
  const claim = async (id: string): Promise<V2Execution> => {
    const operation = await store.operation(id);
    const resource = operation ? await store.resource(operation.resource_uid) : null;
    if (!operation || !resource) throw new Error("missing real accepted weighted source");
    const token = crypto.randomUUID();
    expect(await store.claim(id, token, nowMs, nowMs + 120_000)).toBe(true);
    expect(await store.markDispatch(id, token, at)).toBe(true);
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
  const settle = async (
    input: V2Execution,
    status: "succeeded" | "failed" = "succeeded",
    effect: "complete" | "none" | "partial" = status === "succeeded" ? "complete" : "none",
  ) => {
    const observed = await backend(input.backendId).execute(input);
    expect(
      await store.settle({
        id: input.operationId,
        token: input.leaseToken,
        status,
        effect,
        at,
        retainUntil: new Date(nowMs + 3_600_000).toISOString(),
        ...(observed.kind === "complete" && status === "succeeded"
          ? {
              observedJson: JSON.stringify(observed.observed),
              outputJson: JSON.stringify(observed.output),
            }
          : {
              error: { code: "controlled_no_effect", message: "fixture native operation refused" },
            }),
      }),
    ).toBe(true);
  };
  const worker = await accept(MODULE_WORKER_FORM_URL, "weighted-worker", {});
  expect(await engine.runNext()).toMatchObject({ id: worker.id, status: "succeeded" });
  const bundle = await accept(WORKER_BUNDLE_FORM_URL, "weighted-bundle", {});
  expect(await engine.runNext()).toMatchObject({ id: bundle.id, status: "succeeded" });
  const native = createV2NativeEffectCustody({ sql, now: () => new Date(nowMs) });
  const allReleases: {
    versionUid: string;
    versionGeneration: number;
    scriptName: string;
    weight: number;
    descriptorDigest: `sha256:${string}`;
    providerEtag: string;
  }[] = [];
  for (let index = 0; index < 8; index++) {
    const version = await accept(WORKER_VERSION_FORM_URL, `weighted-version-${index}`, {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
    });
    const execution = await claim(version.id);
    const identity = {
      execution,
      nativeIdentity: `integration-v2-${String(index).repeat(48)}`,
      closureDigest: `sha256:${String(index + 1).repeat(64)}` as const,
    };
    expect(await native.grant(identity)).toBe("granted");
    expect(await native.acknowledge({ ...identity, receipt: `weighted-etag-${index}` })).toBe(true);
    expect(await native.confirm({ ...identity, receipt: `weighted-etag-${index}` })).toBe(true);
    await settle(execution);
    allReleases.push({
      versionUid: version.resourceUid,
      versionGeneration: 1,
      scriptName: identity.nativeIdentity,
      weight: 0,
      descriptorDigest: identity.closureDigest,
      providerEtag: `weighted-etag-${index}`,
    });
  }
  allReleases.sort((left, right) => (left.versionUid < right.versionUid ? -1 : 1));
  const releases = (count: number) =>
    allReleases.slice(0, count).map((release) => ({ ...release, weight: 10_000 / count }));
  const deploymentSpec = (count: number): JsonObject => ({
    worker: { resourceUid: worker.resourceUid },
    versions: releases(count).map((release) => ({
      workerVersion: { resourceUid: release.versionUid },
      weight: release.weight,
    })),
  });
  const deployment = await accept(
    WORKER_DEPLOYMENT_FORM_URL,
    "weighted-deployment",
    deploymentSpec(releaseCount),
  );
  expect(await engine.runNext()).toMatchObject({ id: deployment.id, status: "succeeded" });
  const workerRow = (
    source = deployment.id,
    generation = 1,
    deploymentGeneration = 1,
    count = releaseCount,
  ): SharedAppNativeRouteRowPin => ({
    providerId: PROVIDER,
    routeKind: "worker",
    routeKey: `worker/v2/${worker.resourceUid}`,
    ownerNativeId: `v2-worker:${worker.resourceUid}`,
    generation,
    operationId: `v2-worker:${source}`,
    state: "active",
    valueJson: JSON.stringify({
      schema: "takoserver.v2-wfp-worker-route@v1",
      targetKey: TARGET,
      workerUid: worker.resourceUid,
      deploymentUid: deployment.resourceUid,
      deploymentGeneration,
      sourceOperationId: source,
      releases: releases(count),
      generation,
    }),
  });
  const putRow = async (row: SharedAppNativeRouteRowPin) =>
    sql.run(
      `INSERT INTO cloudflare_managed_worker_routes
    (provider_id,route_kind,route_key,owner_native_id,generation,operation_id,state,value_json) VALUES(?,?,?,?,?,?,?,?)`,
      [
        row.providerId,
        row.routeKind,
        row.routeKey,
        row.ownerNativeId,
        row.generation,
        row.operationId,
        row.state,
        row.valueJson,
      ],
    );
  await putRow(workerRow());
  const held = adopted
    ? await ledger
        .forTrustedOwner(OWNER)
        .reserve({ reservationId: "weighted-original", name: NAME })
    : null;
  const endpoint = await accept(WORKER_ENDPOINT_FORM_URL, NAME, {
    worker: { resourceUid: worker.resourceUid },
  });
  const execution = await claim(endpoint.id);
  const hostRow = (
    input = execution,
    source = deployment.id,
    generation = 1,
    deploymentGeneration = 1,
  ): SharedAppNativeRouteRowPin => ({
    providerId: PROVIDER,
    routeKind: "host",
    routeKey: `host/v2/${HOSTNAME}`,
    ownerNativeId: `v2-worker:${worker.resourceUid}`,
    generation,
    operationId: `v2-host:${input.action === "delete" ? input.operationId : source}:${HOSTNAME}`,
    state: input.action === "delete" ? "tombstone" : "active",
    valueJson:
      input.action === "delete"
        ? JSON.stringify({ schema: "takoserver.managed-worker-route-tombstone@v1", generation })
        : JSON.stringify(
            {
              schema: "takoserver.v2-wfp-host-route@v1",
              targetKey: TARGET,
              hostname: HOSTNAME,
              workerUid: worker.resourceUid,
              deploymentUid: deployment.resourceUid,
              deploymentGeneration,
              endpointUid: endpoint.resourceUid,
              endpointGeneration: input.generation,
              sourceOperationId: source,
              generation,
            },
            null,
            1,
          ),
  });
  const receiver = (selectedSql = sql, selectedLedger = ledger) =>
    createWorkerEndpointOriginV2FormRoutePublication({
      sql: selectedSql,
      ledger: selectedLedger,
      providerId: PROVIDER,
      targetKey: TARGET,
      endpoint: { formUrl: WORKER_ENDPOINT_FORM_URL, backendId: endpointBackend },
      worker: { formUrl: MODULE_WORKER_FORM_URL, backendId: workerBackend },
      deployment: { formUrl: WORKER_DEPLOYMENT_FORM_URL, backendId: deploymentBackend },
      version: { formUrl: WORKER_VERSION_FORM_URL, backendId: versionBackend },
    });
  const apply = async (
    preparations: readonly WorkerEndpointOriginV2FormRoutePreparation[],
    writes: readonly SharedAppNativeRouteRowPin[],
    omit = -1,
  ) => {
    const effects = preparations.map((prepared) => {
      if (!prepared.effects) throw new Error("historical replay must not repeat native writes");
      return prepared.effects;
    });
    const guards = effects.map((effect) => `(${effect.publicationGuard.sql})`).join(" AND ");
    const params = effects.flatMap((effect) => [...(effect.publicationGuard.params ?? [])]);
    const transitions: SqlStatement[] = [];
    for (let index = 0; index < writes.length; index++) {
      if (index === omit) continue;
      const row = writes[index];
      if (!row) throw new Error("missing declared row");
      const before = effects[0]?.original.nativeBefore.find(
        (before) => before.routeKind === row.routeKind && before.routeKey === row.routeKey,
      )?.row;
      transitions.push(
        before
          ? {
              sql: `UPDATE cloudflare_managed_worker_routes SET owner_native_id=?,generation=?,operation_id=?,state=?,value_json=?
          WHERE provider_id=? AND route_kind=? AND route_key=? AND owner_native_id=? AND generation=? AND operation_id=?
          AND state=? AND value_json=? AND (${guards})`,
              params: [
                row.ownerNativeId,
                row.generation,
                row.operationId,
                row.state,
                row.valueJson,
                row.providerId,
                row.routeKind,
                row.routeKey,
                before.ownerNativeId,
                before.generation,
                before.operationId,
                before.state,
                before.valueJson,
                ...params,
              ],
            }
          : {
              sql: `INSERT INTO cloudflare_managed_worker_routes
          (provider_id,route_kind,route_key,owner_native_id,generation,operation_id,state,value_json)
          SELECT ?,?,?,?,?,?,?,? WHERE (${guards}) ON CONFLICT DO NOTHING`,
              params: [
                row.providerId,
                row.routeKind,
                row.routeKey,
                row.ownerNativeId,
                row.generation,
                row.operationId,
                row.state,
                row.valueJson,
                ...params,
              ],
            },
      );
    }
    const statements = [
      ...effects.flatMap((effect) => effect.before),
      ...transitions,
      ...effects.flatMap((effect) => effect.after),
    ];
    for (const statement of statements) {
      expect(statement.params?.length ?? 0).toBeLessThanOrEqual(100);
      expect(new TextEncoder().encode(statement.sql).byteLength).toBeLessThanOrEqual(100_000);
      for (const value of statement.params ?? [])
        if (typeof value === "string")
          expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(2_000_000);
    }
    return sql.batch(statements);
  };
  const endpointPreparation = async (input = execution, row = hostRow(input)) => {
    const result = await receiver().prepareEndpointFormV2(input, [row]);
    expect(result.kind).toBe("shared");
    if (result.kind !== "shared") throw new Error("expected genuine closed Endpoint preparation");
    return result.preparation;
  };
  const deploymentUpdate = async (count = 8) => {
    const current = await store.resource(deployment.resourceUid);
    const host = await raw.query(
      "SELECT generation FROM cloudflare_managed_worker_routes WHERE route_kind='host' AND route_key=?",
      [`host/v2/${HOSTNAME}`],
    );
    if (!current) throw new Error("missing actual Deployment predecessor");
    const workerGeneration = await raw.query(
      "SELECT generation FROM cloudflare_managed_worker_routes WHERE route_kind='worker' AND route_key=?",
      [`worker/v2/${worker.resourceUid}`],
    );
    const hostGeneration = host[0]?.generation ?? 0;
    const nativeWorkerGeneration = workerGeneration[0]?.generation;
    if (typeof hostGeneration !== "number" || typeof nativeWorkerGeneration !== "number")
      throw new Error("missing actual native predecessor generations");
    const operation = await engine.acceptUpdate({
      principal: PRINCIPAL,
      key: `weighted-deployment-next-${current.generation + 1}-${count}`,
      uid: deployment.resourceUid,
      expectedGeneration: current.generation,
      spec: deploymentSpec(count),
    });
    const input = await claim(operation.id);
    const rows = [
      hostRow(execution, input.operationId, hostGeneration + 1, input.generation),
      workerRow(input.operationId, nativeWorkerGeneration + 1, input.generation, count),
    ];
    return { input, rows };
  };
  return {
    db: () => db,
    sql,
    raw: () => raw,
    ledger,
    engine,
    store,
    held,
    endpoint,
    worker,
    deployment,
    execution,
    receiver,
    hostRow,
    workerRow,
    releases,
    endpointPreparation,
    apply,
    settle,
    claim,
    deploymentUpdate,
    deploymentSpec,
    batches,
    readCount: () => reads,
    holdNextRead() {
      let entered!: () => void;
      let release!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      gate = { entered, wait };
      return { entered: enteredPromise, release };
    },
    loseAck() {
      loseAck = true;
    },
    reopen() {
      db.close();
      db = new Database(path);
      raw = createSqliteSql(db);
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("typed closed receiver preserves actual1/2/8 accepted releases and raw native bytes in one atom", async () => {
  for (const count of [1, 2, 8]) {
    const f = await formRouteFixture(count);
    try {
      const row = f.hostRow();
      const preparation = await f.endpointPreparation(f.execution, row);
      expect(preparation.effects?.original.nextBinding?.releases).toEqual(f.releases(count));
      expect(preparation.effects?.original.nativeBefore).toHaveLength(2);
      expect(preparation.effects?.original.nativeAfter).toHaveLength(2);
      expect(preparation.effects?.original.nextBinding?.hostRow.valueJson).toBe(row.valueJson);
      expect(preparation.effects?.original.nativeAfter[1]?.row).toEqual(
        preparation.effects?.original.nativeBefore[1]?.row,
      );
      await f.apply([preparation], [row]);
      const receipt = await preparation.settleOriginal();
      expect(receipt?.original.accepted.operationId).toBe(f.endpoint.id);
      expect(await preparation.observe()).toBe("confirmed");
      await f.settle(f.execution);
      expect(await preparation.observe()).toBe("confirmed");
      const current = await f.ledger.readCurrentRoute(NAME);
      expect(current?.kind).toBe("form-v2@1");
      if (current?.kind !== "form-v2@1") throw new Error("missing full typed selection");
      expect(current.binding.releases).toHaveLength(count);
      expect(await f.ledger.isRouteCurrentBeforeDispatch(current)).toBe(true);
      expect(await f.ledger.isRouteCurrentAfterDispatch(current)).toBe(true);
      await expect(f.ledger.readCurrent(NAME)).rejects.toMatchObject({ code: "unavailable" });
      expect(
        f.db().query("SELECT count(*) AS n FROM shared_app_staging_batch_assertions").get(),
      ).toEqual({ n: 0 });
    } finally {
      f.close();
    }
  }
});

test("typed UPDATE accepts the current tagged original; historical replay stays read-only after a later advance", async () => {
  const f = await formRouteFixture();
  try {
    const originalRow = f.hostRow();
    const original = await f.endpointPreparation(f.execution, originalRow);
    await f.apply([original], [originalRow]);
    await f.settle(f.execution);
    const update = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "typed-endpoint-next",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 1,
      spec: f.execution.spec,
    });
    const input = await f.claim(update.id);
    const row = f.hostRow(input, f.deployment.id, 2);
    const preparation = await f.endpointPreparation(input, row);
    expect(preparation.effects?.original.expected.kind).toBe("form-v2@1");
    await f.apply([preparation], [row]);
    const originalReceipt = await original.settleOriginal();
    expect(originalReceipt?.original.accepted.operationId).toBe(f.endpoint.id);
    expect(await original.observe()).toBe("unknown");
    const replay = await f.receiver().prepareEndpointFormV2(f.execution, [originalRow]);
    expect(replay.kind).toBe("shared");
    if (replay.kind !== "shared") throw new Error("lost historical original");
    expect(replay.preparation.effects).toBeUndefined();
    expect(await replay.preparation.settleOriginal()).toEqual(originalReceipt);
    expect(await replay.preparation.observe()).toBe("unknown");
    await expect(f.apply([replay.preparation], [originalRow])).rejects.toThrow("historical replay");
    expect(await preparation.observe()).toBe("confirmed");
  } finally {
    f.close();
  }
});

test("recorded Endpoint and Deployment originals survive later advances and reopen without native effects", async () => {
  const f = await formRouteFixture();
  try {
    const endpoint = await f.endpointPreparation();
    await f.apply([endpoint], [f.hostRow()]);
    await f.settle(f.execution);
    const first = await f.deploymentUpdate(8);
    const original = await f.receiver().prepareDeployment(first.input, first.rows);
    if (original.kind !== "shared") throw new Error("missing genuine first Deployment atom");
    await f.apply(original.preparations, first.rows);
    await f.settle(first.input);
    const next = await f.deploymentUpdate(2);
    const advanced = await f.receiver().prepareDeployment(next.input, next.rows);
    if (advanced.kind !== "shared") throw new Error("missing genuine later Deployment atom");
    await f.apply(advanced.preparations, next.rows);
    await f.settle(next.input);
    f.reopen();
    const before = {
      assignments: f.db().query("SELECT * FROM shared_app_staging_assignments").all(),
      names: f.db().query("SELECT * FROM shared_app_staging_names").all(),
      bindings: f.db().query(`SELECT * FROM ${BINDINGS}`).all(),
      history: f.db().query(`SELECT * FROM ${HISTORY} ORDER BY next_generation`).all(),
      native: f
        .db()
        .query("SELECT * FROM cloudflare_managed_worker_routes ORDER BY route_kind,route_key")
        .all(),
      batches: f.batches.length,
    };
    for (const [execution, expected] of [
      [f.execution, [endpoint]],
      [first.input, original.preparations],
    ] as const) {
      const recorded = await f.receiver().readRecordedEffects(execution);
      expect(recorded.kind).toBe("shared");
      if (recorded.kind !== "shared") throw new Error("lost whole recorded original");
      expect(Object.isFrozen(recorded.preparations)).toBe(true);
      expect(recorded.preparations).toHaveLength(expected.length);
      for (let index = 0; index < recorded.preparations.length; index++) {
        const item = recorded.preparations[index];
        const prior = expected[index];
        if (!item || !prior) throw new Error("missing whole original preparation");
        expect(item.effects).toBeUndefined();
        expect(await item.settleOriginal()).toEqual(await prior.settleOriginal());
        expect(await item.observe()).toBe("unknown");
      }
      await expect(f.apply(recorded.preparations, next.rows)).rejects.toThrow("historical replay");
    }
    expect(await advanced.preparations[0]?.observe()).toBe("confirmed");
    expect({
      assignments: f.db().query("SELECT * FROM shared_app_staging_assignments").all(),
      names: f.db().query("SELECT * FROM shared_app_staging_names").all(),
      bindings: f.db().query(`SELECT * FROM ${BINDINGS}`).all(),
      history: f.db().query(`SELECT * FROM ${HISTORY} ORDER BY next_generation`).all(),
      native: f
        .db()
        .query("SELECT * FROM cloudflare_managed_worker_routes ORDER BY route_kind,route_key")
        .all(),
      batches: f.batches.length,
    }).toEqual(before);
    expect(
      f.db().query("SELECT count(*) AS n FROM shared_app_staging_batch_assertions").get(),
    ).toEqual({ n: 0 });
  } finally {
    f.close();
  }
});

test("recorded lookup captures execution before await and refuses forged immutable Core ownership even without history", async () => {
  const f = await formRouteFixture();
  try {
    const batches = f.batches.length;
    expect(await f.receiver().readRecordedEffects(f.execution)).toEqual({ kind: "absent" });
    for (const forged of [
      { ...f.execution, name: "a-different-real-resource-name" },
      { ...f.execution, principal: "org:foreign", space: "foreign" },
      { ...f.execution, spec: { worker: { resourceUid: "unaccepted-worker" } } },
      { ...f.execution, generation: f.execution.generation + 1 },
      { ...f.execution, backendKey: crypto.randomUUID() },
      { ...f.execution, form: WORKER_DEPLOYMENT_FORM_URL },
    ])
      expect(await f.receiver().readRecordedEffects(forged)).toEqual({ kind: "refused" });
    const mutable = { ...f.execution, spec: structuredClone(f.execution.spec) };
    const gate = f.holdNextRead();
    const pending = f.receiver().readRecordedEffects(mutable);
    await gate.entered;
    mutable.spec = { worker: { resourceUid: "changed-after-entry" } };
    mutable.name = "changed-after-entry";
    gate.release();
    expect(await pending).toEqual({ kind: "absent" });
    expect(f.batches.length).toBe(batches);
    expect(f.db().query(`SELECT count(*) AS n FROM ${HISTORY}`).get()).toEqual({ n: 0 });
  } finally {
    f.close();
  }
});

test("recorded inventory never treats partial atoms, mixed scalar or foreign history as absent", async () => {
  for (const corruption of [
    "partial-old-new-host",
    "mixed-scalar",
    "foreign-owner",
    "missing-entire-inventory",
  ] as const) {
    const f = await formRouteFixture();
    try {
      const initial = await f.endpointPreparation();
      await f.apply([initial], [f.hostRow()]);
      await f.settle(f.execution);
      const next = await f.deploymentUpdate();
      const prepared = await f.receiver().prepareDeployment(next.input, next.rows);
      if (prepared.kind !== "shared") throw new Error("missing genuine Deployment history source");
      await f.apply(prepared.preparations, next.rows);
      await f.settle(next.input);
      const rows = await f
        .raw()
        .query(`SELECT * FROM ${HISTORY} WHERE source_operation_id=?`, [next.input.operationId]);
      const row = rows[0];
      if (!row || typeof row.form_v2_original_json !== "string")
        throw new Error("missing genuine original bytes");
      if (corruption === "partial-old-new-host") {
        // Deliberate persisted-data corruption, never an authority fixture: the
        // strict ledger codec accepts this whole three-key shape, but one of
        // its two shared-name originals is missing from actual history.
        const original = JSON.parse(row.form_v2_original_json);
        const host = original.nativeBefore.find(
          (entry: { routeKind: string }) => entry.routeKind === "host",
        );
        if (!host?.row) throw new Error("missing genuine predecessor Host row");
        const extra = structuredClone(host);
        extra.routeKey = "host/v2/partial-second.app-staging.takos.jp";
        extra.row.routeKey = extra.routeKey;
        const value = JSON.parse(extra.row.valueJson);
        value.hostname = "partial-second.app-staging.takos.jp";
        extra.row.valueJson = JSON.stringify(value);
        extra.row.operationId = `v2-host:${value.sourceOperationId}:${value.hostname}`;
        for (const field of ["nativeBefore", "nativeAfter"] as const) {
          original[field].push(extra);
          original[field].sort(
            (
              left: { routeKind: string; routeKey: string },
              right: { routeKind: string; routeKey: string },
            ) => {
              const a = `${left.routeKind}\u0000${left.routeKey}`;
              const b = `${right.routeKind}\u0000${right.routeKey}`;
              return a < b ? -1 : a > b ? 1 : 0;
            },
          );
        }
        await f
          .raw()
          .run(`UPDATE ${HISTORY} SET form_v2_original_json=? WHERE source_operation_id=?`, [
            canonicalJson(original),
            next.input.operationId,
          ]);
        expect(
          await f.ledger.forTrustedOwner(OWNER).readFormV2RouteCommand(String(row.command_ref)),
        ).not.toBeNull();
      } else if (corruption === "mixed-scalar") {
        await f
          .raw()
          .run(
            `UPDATE ${HISTORY} SET form_v2_original_json=NULL,prior_script=?,next_script=? WHERE source_operation_id=?`,
            [SCRIPT, SCRIPT, next.input.operationId],
          );
      } else if (corruption === "foreign-owner") {
        await f
          .raw()
          .run(
            `UPDATE ${HISTORY} SET organization_id='foreign-owner' WHERE source_operation_id=?`,
            [next.input.operationId],
          );
      } else {
        await f
          .raw()
          .run(`DELETE FROM ${HISTORY} WHERE source_operation_id=?`, [next.input.operationId]);
      }
      const later = corruption === "missing-entire-inventory" ? await f.deploymentUpdate(2) : null;
      const state = {
        assignments: f.db().query("SELECT * FROM shared_app_staging_assignments").all(),
        native: f
          .db()
          .query("SELECT * FROM cloudflare_managed_worker_routes ORDER BY route_kind,route_key")
          .all(),
        history: f.db().query(`SELECT * FROM ${HISTORY} ORDER BY next_generation`).all(),
        batches: f.batches.length,
      };
      if (corruption === "mixed-scalar") {
        // Valid scalar history is a conflicting route variant. Malformed typed
        // history has the separate unavailable classification in the ledger.
        await expect(f.receiver().readRecordedEffects(next.input)).rejects.toMatchObject({
          code: "conflict",
        });
      } else if (corruption === "missing-entire-inventory") {
        // Zero actual inventory alone is absent, never a mutation grant. The
        // normal preparation independently refuses the surviving active state
        // because its mandatory latest history has been lost.
        expect(await f.receiver().readRecordedEffects(next.input)).toEqual({ kind: "absent" });
        if (!later) throw new Error("missing genuine later accepted Deployment");
        expect(await f.receiver().prepareDeployment(later.input, later.rows)).toEqual({
          kind: "refused",
        });
      } else
        expect(await f.receiver().readRecordedEffects(next.input)).toEqual({ kind: "refused" });
      expect({
        assignments: f.db().query("SELECT * FROM shared_app_staging_assignments").all(),
        native: f
          .db()
          .query("SELECT * FROM cloudflare_managed_worker_routes ORDER BY route_kind,route_key")
          .all(),
        history: f.db().query(`SELECT * FROM ${HISTORY} ORDER BY next_generation`).all(),
        batches: f.batches.length,
      }).toEqual(state);
    } finally {
      f.close();
    }
  }
});

test("Deployment advances the complete2-to8 vector; omitted Worker mutation rolls back all ledger and native rows", async () => {
  const f = await formRouteFixture();
  try {
    const initial = await f.endpointPreparation();
    await f.apply([initial], [f.hostRow()]);
    await f.settle(f.execution);
    const { input, rows } = await f.deploymentUpdate();
    const result = await f.receiver().prepareDeployment(input, rows);
    expect(result.kind).toBe("shared");
    if (result.kind !== "shared") throw new Error("missing complete Deployment preparation");
    expect(result.preparations).toHaveLength(1);
    const preparation = result.preparations[0];
    expect(preparation?.effects?.original.nextBinding?.releases).toEqual(f.releases(8));
    const before = f
      .db()
      .query("SELECT * FROM cloudflare_managed_worker_routes ORDER BY route_kind,route_key")
      .all();
    await expect(f.apply(result.preparations, rows, 1)).rejects.toBeInstanceOf(SqlError);
    expect(
      f
        .db()
        .query("SELECT * FROM cloudflare_managed_worker_routes ORDER BY route_kind,route_key")
        .all(),
    ).toEqual(before);
    expect(f.db().query(`SELECT count(*) AS n FROM ${HISTORY}`).get()).toEqual({ n: 1 });
    expect(f.db().query("SELECT generation FROM shared_app_staging_assignments").get()).toEqual({
      generation: 2,
    });
    f.loseAck();
    await expect(f.apply(result.preparations, rows)).rejects.toMatchObject({ code: "unavailable" });
    f.reopen();
    const receipt = await preparation?.settleOriginal();
    expect(receipt?.original.accepted.operationId).toBe(input.operationId);
    expect(receipt?.original.nativeAfter.map((row) => row.row)).toEqual(rows);
    expect(await preparation?.observe()).toBe("confirmed");
    await f.settle(input);
    expect(await preparation?.observe()).toBe("confirmed");
    const replay = await f.receiver().prepareDeployment(input, rows);
    expect(replay.kind).toBe("shared");
    if (replay.kind === "shared")
      for (const item of replay.preparations) expect(item.effects).toBeUndefined();
    const selected = await f.ledger.readCurrentRoute(NAME);
    if (selected?.kind !== "form-v2@1") throw new Error("missing8-release selection");
    const changed = {
      ...selected,
      binding: {
        ...selected.binding,
        releases: selected.binding.releases.map((release, index) =>
          index === 7 ? { ...release, providerEtag: "changed-unselected-etag" } : release,
        ),
      },
    };
    expect(await f.ledger.isRouteCurrentBeforeDispatch(changed)).toBe(false);
    expect(await f.ledger.isRouteCurrentAfterDispatch(changed)).toBe(false);
  } finally {
    f.close();
  }
});

test("prospective Deployment refuses every changed six-pin field and complete native-row keyset drift", async () => {
  const f = await formRouteFixture();
  try {
    const initial = await f.endpointPreparation();
    await f.apply([initial], [f.hostRow()]);
    await f.settle(f.execution);
    const { input, rows } = await f.deploymentUpdate();
    const retained = f.db().query(`SELECT * FROM ${HISTORY}`).all();
    const host = rows[0];
    const worker = rows[1];
    if (!host || !worker) throw new Error("missing complete Host/Worker candidates");
    const originalValue = JSON.parse(worker.valueJson);
    for (const [field, next] of [
      ["versionUid", "changed-uid"],
      ["versionGeneration", 2],
      ["scriptName", "integration-v2-unrecorded"],
      ["descriptorDigest", `sha256:${"f".repeat(64)}`],
      ["providerEtag", "unconfirmed-etag"],
    ] as const) {
      const value = structuredClone(originalValue);
      value.releases[7][field] = next;
      expect(
        await f
          .receiver()
          .prepareDeployment(input, [host, { ...worker, valueJson: JSON.stringify(value) }]),
      ).toEqual({ kind: "refused" });
    }
    const weights = structuredClone(originalValue);
    weights.releases[0].weight--;
    weights.releases[7].weight++;
    expect(
      await f
        .receiver()
        .prepareDeployment(input, [host, { ...worker, valueJson: JSON.stringify(weights) }]),
    ).toEqual({ kind: "refused" });
    const unsorted = structuredClone(originalValue);
    unsorted.releases.reverse();
    expect(
      await f
        .receiver()
        .prepareDeployment(input, [host, { ...worker, valueJson: JSON.stringify(unsorted) }]),
    ).toEqual({ kind: "refused" });
    for (const declarations of [[worker], [host], [...rows].reverse(), [...rows, worker], []])
      expect(await f.receiver().prepareDeployment(input, declarations)).toEqual({
        kind: "refused",
      });
    expect(f.db().query(`SELECT * FROM ${HISTORY}`).all()).toEqual(retained);
    const valid = await f.receiver().prepareDeployment(input, rows);
    expect(valid.kind).toBe("shared");
    if (valid.kind !== "shared") throw new Error("correct full vector was refused");
    // A post-prepare0074 change is prevented by its real immutable trigger.
    await expect(
      f.sql.run("UPDATE tf_v2_worker_native_effects SET confirmed_receipt='tampered'"),
    ).rejects.toBeInstanceOf(SqlError);
    // A raw-byte change after preparation is fenced in the actual native atom.
    await f.sql.run(
      "UPDATE cloudflare_managed_worker_routes SET value_json=value_json||' ' WHERE route_kind='worker'",
    );
    await expect(f.apply(valid.preparations, rows)).rejects.toBeInstanceOf(SqlError);
    expect(f.db().query(`SELECT * FROM ${HISTORY}`).all()).toEqual(retained);
    expect(
      f.db().query("SELECT count(*) AS n FROM shared_app_staging_batch_assertions").get(),
    ).toEqual({ n: 0 });
  } finally {
    f.close();
  }
});

test("typed DELETE retains accepted3, binding2failed-none and confirmed1 independently; repeated failed DELETE is fenced", async () => {
  const f = await formRouteFixture();
  try {
    const initial = await f.endpointPreparation();
    await f.apply([initial], [f.hostRow()]);
    await f.settle(f.execution);
    const update = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "typed-failed-update-2",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 1,
      spec: f.execution.spec,
    });
    const failed = await f.claim(update.id);
    await f.settle(failed, "failed");
    const acceptedDelete = await f.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "typed-failed-delete-3",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 2,
    });
    const deleted = await f.claim(acceptedDelete.id);
    const row = f.hostRow(deleted, f.deployment.id, 2);
    const preparation = await f.endpointPreparation(deleted, row);
    expect(preparation.effects?.original.accepted.generation).toBe(3);
    expect(preparation.effects?.original.endpointBinding.endpointGeneration).toBe(2);
    expect(preparation.effects?.original.priorBinding?.endpoint.generation).toBe(1);
    await f.settle(deleted, "failed");
    const repeated = await f.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "typed-delete-4",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 3,
    });
    const final = await f.claim(repeated.id);
    const finalRow = f.hostRow(final, f.deployment.id, 2);
    const last = await f.endpointPreparation(final, finalRow);
    expect(last.effects?.original.accepted.generation).toBe(4);
    expect(last.effects?.original.endpointBinding.endpointGeneration).toBe(2);
    expect(last.effects?.original.priorBinding?.endpoint.generation).toBe(1);
    // Preserve the first real whole-batch failure: an earlier terminal effect
    // may not be treated as a generic <= generation permission.
    await f.sql.run("UPDATE tf_v2_operations SET effect='partial' WHERE id=?", [
      deleted.operationId,
    ]);
    await expect(f.apply([last], [finalRow])).rejects.toBeInstanceOf(SqlError);
    expect(f.db().query(`SELECT count(*) AS n FROM ${HISTORY}`).get()).toEqual({ n: 1 });
    expect(
      f
        .db()
        .query(
          "SELECT generation,state FROM cloudflare_managed_worker_routes WHERE route_kind='host'",
        )
        .get(),
    ).toEqual({ generation: 1, state: "active" });
    await f.sql.run("UPDATE tf_v2_operations SET effect='none' WHERE id=?", [deleted.operationId]);
    f.loseAck();
    await expect(f.apply([last], [finalRow])).rejects.toMatchObject({ code: "unavailable" });
    f.reopen();
    expect((await last.settleOriginal())?.original.accepted.operationId).toBe(final.operationId);
    expect(await last.observe()).toBe("retired");
    await f.settle(final);
    expect(await last.observe()).toBe("retired");
    expect(await f.ledger.readCurrentRoute(NAME)).toBeNull();
    expect(
      await f.ledger.forTrustedOwner(OWNER).readOriginalRoute("weighted-original"),
    ).toMatchObject({ kind: "form-v2@1", state: "reserved", binding: null });
    await expect(
      f.ledger.forTrustedOwner(OWNER).readOriginal("weighted-original"),
    ).rejects.toMatchObject({ code: "unavailable" });
  } finally {
    f.close();
  }
});

test("never-live typed DELETE returns no invented original, history or native mutation", async () => {
  const f = await formRouteFixture();
  try {
    await f.settle(f.execution, "failed");
    const operation = await f.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "typed-never-live-delete",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 1,
    });
    const input = await f.claim(operation.id);
    const result = await f.receiver().prepareEndpointFormV2(input, []);
    expect(result.kind).toBe("shared");
    if (result.kind !== "shared") throw new Error("missing genuine read-only removal");
    expect(result.preparation.effects).toBeUndefined();
    expect(await result.preparation.settleOriginal()).toBeNull();
    expect(await result.preparation.observe()).toBe("retired");
    await f.settle(input);
    expect(await result.preparation.settleOriginal()).toBeNull();
    expect(await result.preparation.observe()).toBe("retired");
    expect(f.db().query(`SELECT count(*) AS n FROM ${HISTORY}`).get()).toEqual({ n: 0 });
    expect(
      f
        .db()
        .query("SELECT count(*) AS n FROM cloudflare_managed_worker_routes WHERE route_kind='host'")
        .get(),
    ).toEqual({ n: 0 });
    expect(
      f.db().query("SELECT generation,binding_kind FROM shared_app_staging_assignments").get(),
    ).toEqual({ generation: 1, binding_kind: null });
  } finally {
    f.close();
  }
});

test("typed prospective input is captured before the first await; raw64KiB is exact and overflow is refused before SQL", async () => {
  const f = await formRouteFixture(8);
  try {
    const input = structuredClone(f.execution);
    const candidate = { ...f.hostRow() };
    candidate.valueJson += " ".repeat(
      65_536 - new TextEncoder().encode(candidate.valueJson).byteLength,
    );
    expect(new TextEncoder().encode(candidate.valueJson).byteLength).toBe(65_536);
    const beforeReads = f.readCount();
    expect(
      await f
        .receiver()
        .prepareEndpointFormV2(input, [{ ...candidate, valueJson: `${candidate.valueJson} ` }]),
    ).toEqual({ kind: "refused" });
    expect(f.readCount()).toBe(beforeReads);
    const rows = [candidate];
    const expectedRaw = candidate.valueJson;
    const gate = f.holdNextRead();
    const pending = f.receiver().prepareEndpointFormV2(input, rows);
    await gate.entered;
    input.operationId = crypto.randomUUID();
    input.spec = {};
    rows.length = 0;
    candidate.valueJson = "{}";
    gate.release();
    const result = await pending;
    expect(result.kind).toBe("shared");
    if (result.kind !== "shared") throw new Error("captured exact64KiB input was refused");
    expect(result.preparation.effects?.original.accepted.operationId).toBe(f.endpoint.id);
    expect(result.preparation.effects?.original.nextBinding?.hostRow.valueJson).toBe(expectedRaw);
    const stored = result.preparation.effects?.original.nativeAfter[0]?.row;
    if (!stored) throw new Error("missing captured native row");
    await f.apply([result.preparation], [stored]);
    expect(
      (await result.preparation.settleOriginal())?.original.nextBinding?.hostRow.valueJson,
    ).toBe(expectedRaw);
    const receiver = f.receiver();
    expect(() => receiver.assertSql({ ...f.sql })).toThrow("same atomic Sql");
    receiver.assertSql(f.sql);
    expect(Object.isFrozen(result.preparation)).toBe(true);
    expect(Object.isFrozen(result.preparation.effects?.original.nativeAfter)).toBe(true);
  } finally {
    f.close();
  }
});

test("current compact8-release native producer shape fits the internal UTF8 cap with worst bounded JSON escaping", () => {
  const escaped = "\u0001".repeat(255);
  const uid = "u".repeat(128);
  const releases = Array.from({ length: 8 }, (_, index) => ({
    versionUid: `${index}${uid.slice(1)}`,
    versionGeneration: Number.MAX_SAFE_INTEGER,
    scriptName: escaped,
    weight: 1_250,
    descriptorDigest: `sha256:${"f".repeat(64)}`,
    providerEtag: escaped,
  }));
  const worker = JSON.stringify({
    schema: "takoserver.v2-wfp-worker-route@v1",
    targetKey: escaped,
    workerUid: uid,
    deploymentUid: uid,
    deploymentGeneration: Number.MAX_SAFE_INTEGER,
    sourceOperationId: "00000000-0000-4000-8000-000000000001",
    releases,
    generation: Number.MAX_SAFE_INTEGER,
  });
  const host = JSON.stringify({
    schema: "takoserver.v2-wfp-host-route@v1",
    targetKey: escaped,
    hostname: `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`,
    workerUid: uid,
    deploymentUid: uid,
    deploymentGeneration: Number.MAX_SAFE_INTEGER,
    endpointUid: uid,
    endpointGeneration: Number.MAX_SAFE_INTEGER,
    sourceOperationId: "00000000-0000-4000-8000-000000000001",
    generation: Number.MAX_SAFE_INTEGER,
  });
  expect(new TextEncoder().encode(worker).byteLength).toBeLessThan(32_768);
  expect(new TextEncoder().encode(host).byteLength).toBeLessThan(32_768);
  expect(worker).toContain("\\u0001");
  expect(JSON.parse(worker).releases).toHaveLength(8);
  // This proves only the exact bounded serializer shape, not provider/compiler
  // readback or native qualification, and does not cap the full outer original.
});

test("succeeded Endpoint DELETE without retirement remains refused with present, missing or unmatched native custody", async () => {
  for (const mode of [
    "active-host",
    "absent-host",
    "unmatched-tombstone",
    "absent-history",
    "absent-binding-and-history",
  ] as const) {
    const f = await formRouteFixture();
    try {
      const original = await f.endpointPreparation();
      await f.apply([original], [f.hostRow()]);
      await f.settle(f.execution);
      const deletion = await f.engine.acceptDelete({
        principal: PRINCIPAL,
        key: "controlled-incoherent-core-delete",
        uid: f.endpoint.resourceUid,
        expectedGeneration: 1,
      });
      const deleting = await f.claim(deletion.id);
      expect((await f.store.resource(f.endpoint.resourceUid))?.deleted_at).toBeNull();
      expect(
        f
          .db()
          .query("SELECT count(*) AS n FROM tf_v2_resource_references WHERE referrer_uid=?")
          .get(f.endpoint.resourceUid),
      ).toEqual({ n: 1 });
      // Deliberate persisted incoherence, never a native success: Core DELETE
      // is settled while its mandatory native/ledger retirement atom is omitted.
      await f.settle(deleting);
      expect((await f.store.resource(f.endpoint.resourceUid))?.deleted_at).not.toBeNull();
      expect(
        f
          .db()
          .query("SELECT count(*) AS n FROM tf_v2_resource_references WHERE referrer_uid=?")
          .get(f.endpoint.resourceUid),
      ).toEqual({ n: 0 });
      if (mode !== "active-host" && mode !== "unmatched-tombstone")
        await f.sql.run("DELETE FROM cloudflare_managed_worker_routes WHERE route_kind='host'");
      if (mode === "unmatched-tombstone")
        await f.sql.run(
          `UPDATE cloudflare_managed_worker_routes
        SET generation=2,state='tombstone',operation_id=?,value_json=? WHERE route_kind='host'`,
          [
            `v2-host:${deleting.operationId}:${HOSTNAME}`,
            JSON.stringify({
              schema: "takoserver.managed-worker-route-tombstone@v1",
              generation: 2,
            }),
          ],
        );
      if (mode === "absent-history" || mode === "absent-binding-and-history")
        await f.sql.run(`DELETE FROM ${HISTORY}`);
      if (mode === "absent-binding-and-history") await f.sql.run(`DELETE FROM ${BINDINGS}`);
      const { input, rows } = await f.deploymentUpdate();
      const worker = rows.find((row) => row.routeKind === "worker");
      if (!worker) throw new Error("missing genuine Deployment Worker candidate");
      const tombstone: SharedAppNativeRouteRowPin = {
        ...f.hostRow(),
        generation: 2,
        state: "tombstone",
        operationId: `v2-host:${input.operationId}:${HOSTNAME}`,
        valueJson: JSON.stringify({
          schema: "takoserver.managed-worker-route-tombstone@v1",
          generation: 2,
        }),
      };
      const candidates = mode === "active-host" ? [tombstone, worker] : [worker];
      const before = {
        assignment: f.db().query("SELECT * FROM shared_app_staging_assignments").all(),
        names: f.db().query("SELECT * FROM shared_app_staging_names").all(),
        bindings: f.db().query(`SELECT * FROM ${BINDINGS}`).all(),
        history: f.db().query(`SELECT * FROM ${HISTORY}`).all(),
        native: f
          .db()
          .query("SELECT * FROM cloudflare_managed_worker_routes ORDER BY route_kind,route_key")
          .all(),
        batches: f.batches.length,
      };
      expect(await f.receiver().prepareDeployment(input, candidates)).toEqual({ kind: "refused" });
      expect(f.db().query("SELECT * FROM shared_app_staging_assignments").all()).toEqual(
        before.assignment,
      );
      expect(f.db().query("SELECT * FROM shared_app_staging_names").all()).toEqual(before.names);
      expect(f.db().query(`SELECT * FROM ${BINDINGS}`).all()).toEqual(before.bindings);
      expect(f.db().query(`SELECT * FROM ${HISTORY}`).all()).toEqual(before.history);
      expect(
        f
          .db()
          .query("SELECT * FROM cloudflare_managed_worker_routes ORDER BY route_kind,route_key")
          .all(),
      ).toEqual(before.native);
      expect(f.batches).toHaveLength(before.batches);
      expect(before.assignment).toMatchObject([{ state: "active", binding_kind: "form-v2@1" }]);
      expect(
        f.db().query("SELECT count(*) AS n FROM shared_app_staging_batch_assertions").get(),
      ).toEqual({ n: 0 });
    } finally {
      f.close();
    }
  }
});

test("genuinely retired reserved binding permits ordinary Deployment while missing retirement history still refuses", async () => {
  const f = await formRouteFixture();
  try {
    const initial = await f.endpointPreparation();
    await f.apply([initial], [f.hostRow()]);
    await f.settle(f.execution);
    const deletion = await f.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "genuine-typed-retirement",
      uid: f.endpoint.resourceUid,
      expectedGeneration: 1,
    });
    const deleting = await f.claim(deletion.id);
    const row = f.hostRow(deleting, f.deployment.id, 2);
    const retirement = await f.endpointPreparation(deleting, row);
    await f.apply([retirement], [row]);
    await f.settle(deleting);
    expect(await retirement.observe()).toBe("retired");
    const { input, rows } = await f.deploymentUpdate();
    const worker = rows.find((row) => row.routeKind === "worker");
    if (!worker) throw new Error("missing real Worker update");
    const original = await f.ledger.forTrustedOwner(OWNER).readOriginalRoute("weighted-original");
    expect(original).toMatchObject({ kind: "form-v2@1", state: "reserved", binding: null });
    const before = f
      .db()
      .query("SELECT * FROM cloudflare_managed_worker_routes ORDER BY route_kind,route_key")
      .all();
    const writes = f.batches.length;
    expect(await f.receiver().prepareDeployment(input, [worker])).toEqual({ kind: "ordinary" });
    expect(await f.ledger.forTrustedOwner(OWNER).readOriginalRoute("weighted-original")).toEqual(
      original,
    );
    expect(
      f
        .db()
        .query("SELECT * FROM cloudflare_managed_worker_routes ORDER BY route_kind,route_key")
        .all(),
    ).toEqual(before);
    expect(f.batches).toHaveLength(writes);
    await f.sql.run(`DELETE FROM ${HISTORY} WHERE action='retire'`);
    expect(await f.receiver().prepareDeployment(input, [worker])).toEqual({ kind: "refused" });
    expect(f.batches).toHaveLength(writes);
  } finally {
    f.close();
  }
});

test("unadopted ordinary Core Endpoint remains ordinary without shared reservations or history", async () => {
  const f = await formRouteFixture(2, false);
  try {
    await f.settle(f.execution);
    const { input, rows } = await f.deploymentUpdate();
    const host = rows.find((row) => row.routeKind === "host");
    const worker = rows.find((row) => row.routeKind === "worker");
    if (!host || !worker) throw new Error("missing complete ordinary native candidates");
    const value = JSON.parse(host.valueJson);
    value.hostname = "ordinary.example.invalid";
    const ordinaryHost: SharedAppNativeRouteRowPin = {
      ...host,
      routeKey: "host/v2/ordinary.example.invalid",
      generation: 1,
      operationId: `v2-host:${input.operationId}:ordinary.example.invalid`,
      valueJson: JSON.stringify({ ...value, generation: 1 }),
    };
    expect(await f.receiver().prepareDeployment(input, [ordinaryHost, worker])).toEqual({
      kind: "ordinary",
    });
    expect(f.db().query("SELECT count(*) AS n FROM shared_app_staging_assignments").get()).toEqual({
      n: 0,
    });
    expect(f.db().query(`SELECT count(*) AS n FROM ${BINDINGS}`).get()).toEqual({ n: 0 });
    expect(f.db().query(`SELECT count(*) AS n FROM ${HISTORY}`).get()).toEqual({ n: 0 });
  } finally {
    f.close();
  }
});

test("complete native host inventory refuses a second incumbent instead of selecting the first host", async () => {
  const f = await formRouteFixture();
  try {
    const original = await f.endpointPreparation();
    await f.apply([original], [f.hostRow()]);
    await f.settle(f.execution);
    const extra = f.hostRow();
    const value = JSON.parse(extra.valueJson);
    value.hostname = "another.example.invalid";
    await f.sql.run(
      `INSERT INTO cloudflare_managed_worker_routes
      (provider_id,route_kind,route_key,owner_native_id,generation,operation_id,state,value_json)
      VALUES(?,'host',?,?,1,?,'active',?)`,
      [
        PROVIDER,
        "host/v2/another.example.invalid",
        extra.ownerNativeId,
        `v2-host:${f.deployment.id}:another.example.invalid`,
        JSON.stringify(value),
      ],
    );
    const { input, rows } = await f.deploymentUpdate();
    expect(await f.receiver().prepareDeployment(input, rows)).toEqual({ kind: "refused" });
    expect(f.db().query(`SELECT count(*) AS n FROM ${HISTORY}`).get()).toEqual({ n: 1 });
    expect(
      f
        .db()
        .query(
          "SELECT count(*) AS n FROM cloudflare_managed_worker_routes WHERE route_kind='host' AND state='active'",
        )
        .get(),
    ).toEqual({ n: 2 });
  } finally {
    f.close();
  }
});
