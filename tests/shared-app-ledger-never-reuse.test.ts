/**
 * Actual shared-name ledger over a fresh portable SQLite fixture.
 * These UNALLOCATED tables are test-owned, not an adopted migration or writer cutover.
 * Accepted graph/route rows below are owner-like fixtures, not actual Core publication.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type Sql, SqlError, type SqlStatement } from "../src/ports.ts";
import {
  createSharedAppLedger,
  type SharedAppAssignment,
  type SharedAppRouteEffects,
  type TrustedSharedAppRouteGuards,
  type TrustedSharedAppRouteInput,
} from "../src/shared-app-ledger.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

const START = Date.parse("2026-10-15T00:00:00Z");
// Test boundary only: the authority no longer has a cooldown or elapsed-time eligibility.
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1_000;
const FAR_FUTURE = START + 100 * 365 * 24 * 60 * 60 * 1_000;
const OWNER = { organizationId: "org-original", product: "takoserver" as const };
const HOSTNAME = "held-name.app-staging.takos.jp";

function fixture(routeSchema = true) {
  const db = new Database(":memory:");
  const raw = createSqliteSql(db);
  for (const realm of ["staging", "production"]) {
    const prefix = `shared_app_${realm}`;
    db.exec(`CREATE TABLE ${prefix}_assignments (
      incarnation TEXT PRIMARY KEY
        CHECK(length(incarnation)=32 AND incarnation NOT GLOB '*[^0-9a-f]*'),
      name TEXT NOT NULL
        CHECK(length(name) BETWEEN 3 AND 32 AND name NOT GLOB '*[^a-z0-9-]*'),
      organization_id TEXT NOT NULL,
      product TEXT NOT NULL CHECK(product IN ('takoserver','takosumi-hosted')),
      reservation_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740990),
      state TEXT NOT NULL CHECK(state IN ('reserved','active','released')),
      script TEXT, released_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(organization_id,reservation_id), CHECK(updated_at>=created_at),
      CHECK((state='released')=(released_at IS NOT NULL)),
      CHECK(released_at IS NULL OR released_at>=created_at),
      CHECK(state<>'reserved' OR script IS NULL), CHECK(state<>'active' OR script IS NOT NULL))`);
    db.exec(`CREATE TABLE ${prefix}_names (
      normalized_name TEXT PRIMARY KEY
        CHECK(length(normalized_name) BETWEEN 3 AND 32
          AND normalized_name NOT GLOB '*[^a-z0-9-]*'),
      incarnation TEXT NOT NULL REFERENCES ${prefix}_assignments(incarnation),
      generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740990),
      state TEXT NOT NULL CHECK(state IN ('reserved','active','released')),
      released_at INTEGER, updated_at INTEGER NOT NULL,
      CHECK((state='released')=(released_at IS NOT NULL)))`);
    if (!routeSchema) continue;
    db.exec(`CREATE TABLE ${prefix}_route_commands (
      organization_id TEXT NOT NULL, product TEXT NOT NULL, reservation_id TEXT NOT NULL,
      name TEXT NOT NULL, incarnation TEXT NOT NULL REFERENCES ${prefix}_assignments(incarnation),
      action TEXT NOT NULL CHECK(action IN ('activate','advance','retire')),
      command_ref TEXT NOT NULL,
      prior_generation INTEGER NOT NULL, prior_state TEXT NOT NULL, prior_script TEXT,
      next_script TEXT, endpoint_uid TEXT NOT NULL, endpoint_generation INTEGER NOT NULL,
      worker_uid TEXT NOT NULL, deployment_uid TEXT NOT NULL,
      deployment_generation INTEGER NOT NULL, source_operation_id TEXT NOT NULL,
      provider_id TEXT NOT NULL, target_key TEXT NOT NULL,
      next_generation INTEGER NOT NULL, next_state TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(organization_id,command_ref), UNIQUE(incarnation,next_generation),
      CHECK(next_generation=prior_generation+1),
      CHECK(next_generation BETWEEN 2 AND 9007199254740990),
      CHECK((action='activate' AND prior_state='reserved' AND prior_script IS NULL)
        OR (action<>'activate' AND prior_state='active' AND prior_script IS NOT NULL)),
      CHECK((action='retire' AND next_state='reserved' AND next_script IS NULL)
        OR (action<>'retire' AND next_state='active' AND next_script IS NOT NULL)))`);
    db.exec(`CREATE TABLE ${prefix}_batch_assertions (
      witness TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1),
      apply_effects INTEGER NOT NULL CHECK(apply_effects IN (0,1)))`);
  }
  db.exec(`CREATE TABLE fixture_accepted (
    endpoint_uid TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
    endpoint_generation INTEGER NOT NULL, worker_uid TEXT NOT NULL,
    deployment_uid TEXT NOT NULL, deployment_generation INTEGER NOT NULL,
    source_operation_id TEXT NOT NULL, provider_id TEXT NOT NULL, target_key TEXT NOT NULL,
    script TEXT)`);
  db.exec(`CREATE TABLE fixture_routes (
    hostname TEXT PRIMARY KEY, organization_id TEXT NOT NULL, incarnation TEXT NOT NULL,
    generation INTEGER NOT NULL, script TEXT NOT NULL, command_ref TEXT NOT NULL,
    endpoint_uid TEXT NOT NULL, endpoint_generation INTEGER NOT NULL, worker_uid TEXT NOT NULL,
    deployment_uid TEXT NOT NULL, deployment_generation INTEGER NOT NULL,
    source_operation_id TEXT NOT NULL, provider_id TEXT NOT NULL, target_key TEXT NOT NULL)`);
  let now = START;
  let blocked = false;
  let loseAck = false;
  let batches = 0;
  let lastBatchError: unknown;
  const sql: Sql = {
    async query(query, params) {
      if (blocked) throw new SqlError("unavailable", "fixture primary read unavailable");
      return raw.query(query, params);
    },
    run: raw.run,
    async batch(statements) {
      batches++;
      let result: Awaited<ReturnType<Sql["batch"]>>;
      try {
        result = await raw.batch(statements);
      } catch (error) {
        lastBatchError = error;
        throw error;
      }
      if (loseAck) {
        loseAck = false;
        blocked = true;
        throw new SqlError("unavailable", "fixture committed ACK lost");
      }
      return result;
    },
  };
  const ledger = createSharedAppLedger({
    environment: "staging",
    primary: () => sql,
    clock: () => new Date(now),
  });
  return {
    db,
    sql,
    ledger,
    setNow(value: number) {
      now = value;
    },
    loseAck() {
      loseAck = true;
    },
    restoreReads() {
      blocked = false;
    },
    batches: () => batches,
    lastBatchError: () => lastBatchError,
    snapshot() {
      return {
        names: db.query("SELECT * FROM shared_app_staging_names ORDER BY normalized_name").all(),
        assignments: db
          .query("SELECT * FROM shared_app_staging_assignments ORDER BY incarnation")
          .all(),
        ...(routeSchema
          ? {
              history: db
                .query(`SELECT * FROM shared_app_staging_route_commands
                ORDER BY organization_id,command_ref`)
                .all(),
              assertions: db.query("SELECT * FROM shared_app_staging_batch_assertions").all(),
            }
          : {}),
        routes: db.query("SELECT * FROM fixture_routes ORDER BY hostname").all(),
      };
    },
    close: () => db.close(),
  };
}

type Fixture = ReturnType<typeof fixture>;

function command(
  expected: SharedAppAssignment,
  revision: number,
  script: string | null,
): TrustedSharedAppRouteInput {
  return {
    expected,
    commandRef: `owner-route-command-${revision}`,
    accepted: {
      principal: `org:${OWNER.organizationId}`,
      space: OWNER.organizationId,
      endpointUid: "fixture-endpoint",
      endpointGeneration: 7,
      workerUid: "fixture-worker",
      deploymentUid: "fixture-deployment",
      deploymentGeneration: revision,
      sourceOperationId: `fixture-source-operation-${revision}`,
      providerId: "fixture-provider",
      targetKey: "fixture-target",
      script,
    },
  };
}

async function acceptFixture(f: Fixture, input: TrustedSharedAppRouteInput): Promise<void> {
  const a = input.accepted;
  await f.sql.run(
    `INSERT INTO fixture_accepted VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(endpoint_uid) DO UPDATE SET organization_id=excluded.organization_id,
      endpoint_generation=excluded.endpoint_generation, worker_uid=excluded.worker_uid,
      deployment_uid=excluded.deployment_uid, deployment_generation=excluded.deployment_generation,
      source_operation_id=excluded.source_operation_id, provider_id=excluded.provider_id,
      target_key=excluded.target_key, script=excluded.script`,
    [
      a.endpointUid,
      OWNER.organizationId,
      a.endpointGeneration,
      a.workerUid,
      a.deploymentUid,
      a.deploymentGeneration,
      a.sourceOperationId,
      a.providerId,
      a.targetKey,
      a.script,
    ],
  );
}

function guards(input: TrustedSharedAppRouteInput): TrustedSharedAppRouteGuards {
  const a = input.accepted;
  const old = input.expected;
  const previous =
    old.state === "reserved"
      ? { sql: "NOT EXISTS (SELECT 1 FROM fixture_routes WHERE hostname=?)", params: [HOSTNAME] }
      : {
          sql: `EXISTS (SELECT 1 FROM fixture_routes WHERE hostname=? AND organization_id=?
          AND incarnation=? AND generation=? AND script=?)`,
          params: [HOSTNAME, old.organizationId, old.incarnation, old.generation, old.script],
        };
  return {
    admission: {
      sql: `EXISTS (SELECT 1 FROM fixture_accepted WHERE endpoint_uid=? AND organization_id=?
        AND endpoint_generation=? AND worker_uid=? AND deployment_uid=? AND deployment_generation=?
        AND source_operation_id=? AND provider_id=? AND target_key=? AND script IS ?)
        AND (${previous.sql})`,
      params: [
        a.endpointUid,
        old.organizationId,
        a.endpointGeneration,
        a.workerUid,
        a.deploymentUid,
        a.deploymentGeneration,
        a.sourceOperationId,
        a.providerId,
        a.targetKey,
        a.script,
        ...previous.params,
      ],
    },
    publication:
      a.script === null
        ? { sql: "NOT EXISTS (SELECT 1 FROM fixture_routes WHERE hostname=?)", params: [HOSTNAME] }
        : {
            sql: `EXISTS (SELECT 1 FROM fixture_routes WHERE hostname=? AND organization_id=?
            AND incarnation=? AND generation=? AND script=? AND command_ref=? AND endpoint_uid=?
            AND endpoint_generation=? AND worker_uid=? AND deployment_uid=?
            AND deployment_generation=? AND source_operation_id=? AND provider_id=? AND target_key=?)`,
            params: [
              HOSTNAME,
              old.organizationId,
              old.incarnation,
              old.generation + 1,
              a.script,
              input.commandRef,
              a.endpointUid,
              a.endpointGeneration,
              a.workerUid,
              a.deploymentUid,
              a.deploymentGeneration,
              a.sourceOperationId,
              a.providerId,
              a.targetKey,
            ],
          },
  };
}

function routeMutation(plan: SharedAppRouteEffects, refuse = false): SqlStatement {
  const c = plan.original;
  const extra = refuse ? "0" : "1";
  if (c.action === "retire") {
    return {
      sql: `DELETE FROM fixture_routes WHERE hostname=? AND incarnation=? AND generation=?
        AND (${plan.publicationGuard.sql}) AND ${extra}`,
      params: [
        HOSTNAME,
        c.incarnation,
        c.expectedGeneration,
        ...(plan.publicationGuard.params ?? []),
      ],
    };
  }
  return {
    sql: `INSERT INTO fixture_routes SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE (${plan.publicationGuard.sql}) AND ${extra}
      ON CONFLICT(hostname) DO UPDATE SET organization_id=excluded.organization_id,
        incarnation=excluded.incarnation, generation=excluded.generation, script=excluded.script,
        command_ref=excluded.command_ref, endpoint_uid=excluded.endpoint_uid,
        endpoint_generation=excluded.endpoint_generation, worker_uid=excluded.worker_uid,
        deployment_uid=excluded.deployment_uid, deployment_generation=excluded.deployment_generation,
        source_operation_id=excluded.source_operation_id, provider_id=excluded.provider_id,
        target_key=excluded.target_key WHERE (${plan.publicationGuard.sql}) AND ${extra}`,
    params: [
      HOSTNAME,
      c.organizationId,
      c.incarnation,
      c.expectedGeneration + 1,
      c.acceptedScript,
      c.commandRef,
      c.endpointUid,
      c.endpointGeneration,
      c.workerUid,
      c.deploymentUid,
      c.deploymentGeneration,
      c.sourceOperationId,
      c.providerId,
      c.targetKey,
      ...(plan.publicationGuard.params ?? []),
      ...(plan.publicationGuard.params ?? []),
    ],
  };
}

function batch(plan: SharedAppRouteEffects, refuse = false): readonly SqlStatement[] {
  return [...plan.before, routeMutation(plan, refuse), ...plan.after];
}

test("released names are permanent across elapsed time, Organizations and products", async () => {
  const f = fixture();
  try {
    const owner = f.ledger.forTrustedOwner(OWNER);
    const reserved = await owner.reserve({ reservationId: "original", name: "held-name" });
    const released = await owner.release(reserved);
    const original = f.snapshot();
    const writers = [
      OWNER,
      { organizationId: OWNER.organizationId, product: "takosumi-hosted" as const },
      { organizationId: "org-other", product: "takoserver" as const },
      { organizationId: "org-other", product: "takosumi-hosted" as const },
    ];
    for (const [timeIndex, now] of [
      START + THIRTY_DAYS - 1,
      START + THIRTY_DAYS,
      FAR_FUTURE,
    ].entries()) {
      f.setNow(now);
      for (const [ownerIndex, writer] of writers.entries()) {
        await expect(
          f.ledger.forTrustedOwner(writer).reserve({
            reservationId: `replacement-${timeIndex}-${ownerIndex}`,
            name: "held-name",
          }),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(f.snapshot()).toEqual(original);
      }
      await expect(
        owner.reserve({ reservationId: "original", name: "held-name" }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await owner.release(reserved)).toEqual(released);
      expect(await owner.readOriginal("original")).toEqual(released);
      expect(await f.ledger.readCurrent("held-name")).toBeNull();
      expect(f.snapshot()).toEqual(original);
    }
    expect(original.assignments).toHaveLength(1);
    expect(original.names).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("same exact reserved and active reservation replays keep their original incarnation", async () => {
  const f = fixture();
  try {
    const owner = f.ledger.forTrustedOwner(OWNER);
    const request = { reservationId: "retained-original", name: "held-name" };
    const reserved = await owner.reserve(request);
    f.setNow(FAR_FUTURE);
    expect(await owner.reserve(request)).toEqual(reserved);
    const active = await owner.activate(reserved, "fixture-script");
    expect(await owner.reserve(request)).toEqual(active);
    expect(active.incarnation).toBe(reserved.incarnation);
    expect(f.snapshot().assignments).toHaveLength(1);
    expect(await f.ledger.readCurrent("held-name")).toMatchObject({
      incarnation: reserved.incarnation,
      script: "fixture-script",
    });
    await expect(
      owner.reserve({ reservationId: "another-command", name: "held-name" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await owner.readOriginal(request.reservationId)).toEqual(active);
  } finally {
    f.close();
  }
});

test("historical assignment blocks a new claim even if its current head is missing", async () => {
  for (const state of ["reserved", "released"] as const) {
    const f = fixture();
    try {
      const owner = f.ledger.forTrustedOwner(OWNER);
      const reserved = await owner.reserve({ reservationId: "original", name: "held-name" });
      if (state === "released") await owner.release(reserved);
      // Incomplete/corrupt-head rehearsal only, not an authorized production deletion.
      f.db.query("DELETE FROM shared_app_staging_names WHERE normalized_name=?").run("held-name");
      const original = f.snapshot();
      f.setNow(FAR_FUTURE);
      await expect(
        f.ledger
          .forTrustedOwner({
            organizationId: "org-other",
            product: "takosumi-hosted",
          })
          .reserve({ reservationId: "replacement", name: "held-name" }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(f.snapshot()).toEqual(original);
      expect(f.snapshot().names).toEqual([]);
      expect(f.snapshot().assignments).toHaveLength(1);
    } finally {
      f.close();
    }
  }
});

test("a late name-head constraint rolls back the preceding assignment insert", async () => {
  const f = fixture();
  try {
    const owner = f.ledger.forTrustedOwner(OWNER);
    // Fixture-only failure of the head INSERT after the guarded assignment
    // exists. This is not a production writer or fallback.
    f.db.exec(`CREATE TRIGGER fixture_late_head_collision
      BEFORE INSERT ON shared_app_staging_names
      WHEN EXISTS (SELECT 1 FROM shared_app_staging_assignments
        WHERE incarnation=NEW.incarnation AND name=NEW.normalized_name
          AND organization_id='org-original' AND product='takoserver'
          AND reservation_id='late-collision')
      BEGIN
        SELECT RAISE(ABORT,'fixture_late_name_head_constraint');
      END`);
    const original = f.snapshot();
    const input = { reservationId: "late-collision", name: "held-name" };
    await expect(owner.reserve(input)).rejects.toMatchObject({
      code: "indeterminate",
      original: { reservationId: input.reservationId, name: input.name, action: "reserve" },
    });
    expect(f.lastBatchError()).toMatchObject({
      code: "constraint",
      message: "fixture_late_name_head_constraint",
    });
    expect(f.snapshot()).toEqual(original);
    expect(f.batches()).toBe(1);
    expect(await owner.readOriginal(input.reservationId)).toBeNull();
  } finally {
    f.close();
  }
});

test("prepared same-tenant route updates retain incarnation before permanent release", async () => {
  const f = fixture();
  try {
    const owner = f.ledger.forTrustedOwner(OWNER);
    const reserved = await owner.reserve({ reservationId: "tenant-original", name: "held-name" });
    let current = reserved;
    const plans: SharedAppRouteEffects[] = [];
    for (const step of [
      { action: "activate", script: "script-one" },
      { action: "advance", script: "script-two" },
      { action: "retire", script: null },
      { action: "activate", script: "script-three" },
      { action: "retire", script: null },
    ] as const) {
      const input = command(current, plans.length + 1, step.script);
      await acceptFixture(f, input);
      const plan =
        step.action === "activate"
          ? owner.prepareActivate(input, guards(input))
          : step.action === "advance"
            ? owner.prepareAdvance(input, guards(input))
            : owner.prepareRetire(input, guards(input));
      await f.sql.batch(batch(plan));
      current = (await owner.settleRoute(plan.original, "acknowledged")).assignment;
      plans.push(plan);
      expect(current.incarnation).toBe(reserved.incarnation);
      expect(current.generation).toBe(plans.length + 1);
      expect(current.state).toBe(step.script === null ? "reserved" : "active");
      expect(current.releasedAt).toBeNull();
    }
    const historical = f.db
      .query(`SELECT endpoint_generation FROM shared_app_staging_route_commands
      ORDER BY next_generation`)
      .all();
    expect(historical).toEqual(Array.from({ length: 5 }, () => ({ endpoint_generation: 7 })));
    const released = await owner.release(current);
    expect(released.incarnation).toBe(reserved.incarnation);
    expect(released.state).toBe("released");
    const original = f.snapshot();
    const beforeRetire = plans[3];
    if (!beforeRetire) throw new Error("missing prior active command");
    const prior = (await owner.settleRoute(beforeRetire.original, "unknown")).assignment;
    const staleInput = command(prior, 6, "late-script");
    await acceptFixture(f, staleInput);
    const stale = owner.prepareAdvance(staleInput, guards(staleInput));
    await expect(f.sql.batch(batch(stale))).rejects.toMatchObject({ code: "constraint" });
    expect(f.snapshot()).toEqual(original);
    expect(await owner.readRouteCommand(stale.original.commandRef)).toBeNull();
    expect(await f.ledger.readCurrent("held-name")).toBeNull();
    expect(await f.ledger.isCurrentAfterDispatch({ ...prior, script: "script-three" })).toBe(false);
    f.setNow(FAR_FUTURE);
    await expect(
      owner.reserve({ reservationId: "new-tenant", name: "held-name" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await owner.readOriginal("tenant-original")).toEqual(released);
    expect(f.snapshot()).toEqual(original);
    // Exact historical readback describes the old result, never present serving authority.
    const first = plans[0];
    if (!first) throw new Error("missing original route command");
    expect((await owner.settleRoute(first.original, "unknown")).assignment.incarnation).toBe(
      reserved.incarnation,
    );
    expect(await f.ledger.readCurrent("held-name")).toBeNull();
  } finally {
    f.close();
  }
});

test("a zero-row owner route mutation rolls back prepared history and head changes", async () => {
  const f = fixture();
  try {
    const owner = f.ledger.forTrustedOwner(OWNER);
    const reserved = await owner.reserve({ reservationId: "original", name: "held-name" });
    const input = command(reserved, 1, "script-one");
    await acceptFixture(f, input);
    const plan = owner.prepareActivate(input, guards(input));
    const original = f.snapshot();
    await expect(f.sql.batch(batch(plan, true))).rejects.toMatchObject({ code: "constraint" });
    expect(f.snapshot()).toEqual(original);
    expect(await owner.readRouteCommand(input.commandRef)).toBeNull();
    expect(await owner.readOriginal("original")).toEqual(reserved);
  } finally {
    f.close();
  }
});

test("unknown committed reserve ACK replays its one original assignment without another write", async () => {
  const f = fixture();
  try {
    const owner = f.ledger.forTrustedOwner(OWNER);
    const input = { reservationId: "unknown-original", name: "held-name" };
    f.loseAck();
    await expect(owner.reserve(input)).rejects.toMatchObject({
      code: "indeterminate",
      original: { reservationId: input.reservationId, name: input.name, action: "reserve" },
    });
    const original = f.snapshot();
    const batches = f.batches();
    f.restoreReads();
    const replay = await owner.reserve(input);
    expect(f.batches()).toBe(batches);
    expect(f.snapshot()).toEqual(original);
    expect(original.assignments).toHaveLength(1);
    expect(await owner.readOriginal(input.reservationId)).toEqual(replay);
    await owner.release(replay);
    const tombstone = f.snapshot();
    f.setNow(FAR_FUTURE);
    await expect(
      owner.reserve({ reservationId: "replacement", name: input.name }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(f.snapshot()).toEqual(tombstone);
  } finally {
    f.close();
  }
});

test("missing prepared schema never falls back to a standalone legacy activation", async () => {
  const f = fixture(false);
  try {
    const owner = f.ledger.forTrustedOwner(OWNER);
    const reserved = await owner.reserve({ reservationId: "original", name: "held-name" });
    const input = command(reserved, 1, "script-one");
    await acceptFixture(f, input);
    const plan = owner.prepareActivate(input, guards(input));
    const original = f.snapshot();
    await expect(f.sql.batch(batch(plan))).rejects.toMatchObject({ code: "unavailable" });
    expect(f.snapshot()).toEqual(original);
    expect(await f.ledger.readCurrent("held-name")).toBeNull();
    await expect(owner.settleRoute(plan.original, "unknown")).rejects.toMatchObject({
      code: "indeterminate",
      original: plan.original,
    });
    const released = await owner.release(reserved);
    f.setNow(FAR_FUTURE);
    await expect(
      owner.reserve({ reservationId: "replacement", name: "held-name" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await owner.readOriginal("original")).toEqual(released);
  } finally {
    f.close();
  }
});
