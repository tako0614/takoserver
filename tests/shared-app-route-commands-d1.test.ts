import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import type { Sql, SqlStatement } from "../src/ports.ts";
import {
  createSharedAppLedger,
  type SharedAppAssignment,
  type SharedAppRouteEffects,
  type TrustedSharedAppRouteGuards,
  type TrustedSharedAppRouteInput,
} from "../src/shared-app-ledger.ts";
import { createD1Sql } from "../src/sql-d1.ts";

const OWNER = { organizationId: "org-server", product: "takoserver" as const };
const HOSTNAME = "route-update.app-staging.takos.jp";
const START = Date.parse("2026-10-15T00:00:00Z");

async function harness(routeSchema = true) {
  const id = `route-commands-${crypto.randomUUID()}`;
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: id,
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
          env: { DB: { type: "d1", id } },
          triggers: [],
        },
      },
    ],
  });
  const database = await runtime.getD1Database("DB");
  const sql = createD1Sql(database);
  // UNALLOCATED TEST-ONLY fixture. No migration file, registry or live schema is changed.
  for (const realm of ["staging", "production"]) {
    const prefix = `shared_app_${realm}`;
    await sql.run(`CREATE TABLE ${prefix}_assignments (
      incarnation TEXT PRIMARY KEY, name TEXT NOT NULL, organization_id TEXT NOT NULL,
      product TEXT NOT NULL, reservation_id TEXT NOT NULL, generation INTEGER NOT NULL,
      state TEXT NOT NULL, script TEXT, released_at INTEGER, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, UNIQUE(organization_id,reservation_id),
      CHECK(generation BETWEEN 1 AND 9007199254740990), CHECK(updated_at >= created_at),
      CHECK(state IN ('reserved','active','released')), CHECK((state='released')=(released_at IS NOT NULL)),
      CHECK(state<>'reserved' OR script IS NULL), CHECK(state<>'active' OR script IS NOT NULL))`);
    await sql.run(`CREATE TABLE ${prefix}_names (
      normalized_name TEXT PRIMARY KEY, incarnation TEXT NOT NULL REFERENCES ${prefix}_assignments(incarnation),
      generation INTEGER NOT NULL, state TEXT NOT NULL, released_at INTEGER, updated_at INTEGER NOT NULL,
      CHECK(generation BETWEEN 1 AND 9007199254740990), CHECK((state='released')=(released_at IS NOT NULL)))`);
    if (!routeSchema) continue;
    await sql.run(`CREATE TABLE ${prefix}_route_commands (
      organization_id TEXT NOT NULL, product TEXT NOT NULL, reservation_id TEXT NOT NULL,
      name TEXT NOT NULL, incarnation TEXT NOT NULL REFERENCES ${prefix}_assignments(incarnation),
      action TEXT NOT NULL CHECK(action IN ('activate','advance','retire')), command_ref TEXT NOT NULL,
      prior_generation INTEGER NOT NULL, prior_state TEXT NOT NULL, prior_script TEXT, next_script TEXT,
      endpoint_uid TEXT NOT NULL, endpoint_generation INTEGER NOT NULL, worker_uid TEXT NOT NULL,
      deployment_uid TEXT NOT NULL, deployment_generation INTEGER NOT NULL, source_operation_id TEXT NOT NULL,
      provider_id TEXT NOT NULL, target_key TEXT NOT NULL, next_generation INTEGER NOT NULL,
      next_state TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(organization_id,command_ref), UNIQUE(incarnation,next_generation),
      CHECK(next_generation=prior_generation+1), CHECK(next_generation BETWEEN 2 AND 9007199254740990),
      CHECK((action='activate' AND prior_state='reserved' AND prior_script IS NULL)
        OR (action<>'activate' AND prior_state='active' AND prior_script IS NOT NULL)),
      CHECK((action='retire' AND next_state='reserved' AND next_script IS NULL)
        OR (action<>'retire' AND next_state='active' AND next_script IS NOT NULL)))`);
    await sql.run(`CREATE TABLE ${prefix}_batch_assertions (
      witness TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1),
      apply_effects INTEGER NOT NULL CHECK(apply_effects IN (0,1)))`);
  }
  // Realistic owner-side accepted graph and host projection, intentionally not the actual runtime mount.
  await sql.run(`CREATE TABLE fixture_accepted (
    endpoint_uid TEXT PRIMARY KEY, organization_id TEXT NOT NULL, endpoint_generation INTEGER NOT NULL,
    worker_uid TEXT NOT NULL, deployment_uid TEXT NOT NULL, deployment_generation INTEGER NOT NULL,
    source_operation_id TEXT NOT NULL, provider_id TEXT NOT NULL, target_key TEXT NOT NULL, script TEXT)`);
  await sql.run(`CREATE TABLE fixture_routes (
    hostname TEXT PRIMARY KEY, organization_id TEXT NOT NULL, incarnation TEXT NOT NULL,
    generation INTEGER NOT NULL, script TEXT NOT NULL, command_ref TEXT NOT NULL,
    endpoint_uid TEXT NOT NULL, endpoint_generation INTEGER NOT NULL, worker_uid TEXT NOT NULL,
    deployment_uid TEXT NOT NULL, deployment_generation INTEGER NOT NULL, source_operation_id TEXT NOT NULL,
    provider_id TEXT NOT NULL, target_key TEXT NOT NULL)`);
  let blocked = false;
  let reads = 0;
  let now = START;
  const primary = (): Sql => ({
    ...sql,
    async query(query, params) {
      reads++;
      if (blocked) throw new Error("injected primary read transport loss");
      return sql.query(query, params);
    },
  });
  const ledger = createSharedAppLedger({
    environment: "staging",
    primary,
    clock: () => new Date(now),
  });
  return {
    sql,
    ledger,
    close: () => runtime.dispose(),
    block: (value: boolean) => {
      blocked = value;
    },
    reads: () => reads,
    setNow: (value: number) => {
      now = value;
    },
  };
}

function input(
  expected: SharedAppAssignment,
  revision: number,
  script: string | null,
  commandRef = `v2-host-route-${revision}`,
): TrustedSharedAppRouteInput {
  return {
    commandRef,
    expected,
    accepted: {
      principal: `org:${OWNER.organizationId}`,
      space: OWNER.organizationId,
      endpointUid: "endpoint-actual",
      endpointGeneration: 1,
      workerUid: "worker-actual",
      deploymentUid: "deployment-actual",
      deploymentGeneration: revision,
      sourceOperationId: `accepted-deployment-operation-${revision}`,
      providerId: "provider-actual",
      targetKey: "target-actual",
      script,
    },
  };
}

async function accept(sql: Sql, command: TrustedSharedAppRouteInput) {
  const a = command.accepted;
  await sql.run(
    `INSERT INTO fixture_accepted VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(endpoint_uid) DO UPDATE SET organization_id=excluded.organization_id,
    endpoint_generation=excluded.endpoint_generation, worker_uid=excluded.worker_uid,
    deployment_uid=excluded.deployment_uid, deployment_generation=excluded.deployment_generation,
    source_operation_id=excluded.source_operation_id, provider_id=excluded.provider_id,
    target_key=excluded.target_key, script=excluded.script`,
    [
      a.endpointUid,
      command.expected.organizationId,
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

function guards(command: TrustedSharedAppRouteInput): TrustedSharedAppRouteGuards {
  const a = command.accepted;
  const previousRoute =
    command.expected.state === "reserved"
      ? { sql: "NOT EXISTS (SELECT 1 FROM fixture_routes WHERE hostname=?)", params: [HOSTNAME] }
      : {
          sql: `EXISTS (SELECT 1 FROM fixture_routes WHERE hostname=? AND organization_id=?
        AND incarnation=? AND generation=? AND script=?)`,
          params: [
            HOSTNAME,
            command.expected.organizationId,
            command.expected.incarnation,
            command.expected.generation,
            command.expected.script,
          ],
        };
  return {
    admission: {
      sql: `EXISTS (SELECT 1 FROM fixture_accepted WHERE endpoint_uid=? AND organization_id=?
      AND endpoint_generation=? AND worker_uid=? AND deployment_uid=? AND deployment_generation=?
      AND source_operation_id=? AND provider_id=? AND target_key=? AND script IS ?)
      AND (${previousRoute.sql})`,
      params: [
        a.endpointUid,
        command.expected.organizationId,
        a.endpointGeneration,
        a.workerUid,
        a.deploymentUid,
        a.deploymentGeneration,
        a.sourceOperationId,
        a.providerId,
        a.targetKey,
        a.script,
        ...previousRoute.params,
      ],
    },
    publication:
      a.script === null
        ? { sql: "NOT EXISTS (SELECT 1 FROM fixture_routes WHERE hostname=?)", params: [HOSTNAME] }
        : {
            sql: `EXISTS (SELECT 1 FROM fixture_routes WHERE hostname=? AND organization_id=?
          AND incarnation=? AND generation=? AND script=? AND command_ref=?
          AND endpoint_uid=? AND endpoint_generation=? AND worker_uid=? AND deployment_uid=?
          AND deployment_generation=? AND source_operation_id=? AND provider_id=? AND target_key=?)`,
            params: [
              HOSTNAME,
              command.expected.organizationId,
              command.expected.incarnation,
              command.expected.generation + 1,
              a.script,
              command.commandRef,
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
  if (c.action === "retire")
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
  return {
    sql: `INSERT INTO fixture_routes SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE (${plan.publicationGuard.sql}) AND ${extra}
      ON CONFLICT(hostname) DO UPDATE SET organization_id=excluded.organization_id,
      incarnation=excluded.incarnation, generation=excluded.generation, script=excluded.script,
      command_ref=excluded.command_ref, endpoint_uid=excluded.endpoint_uid,
      endpoint_generation=excluded.endpoint_generation, worker_uid=excluded.worker_uid,
      deployment_uid=excluded.deployment_uid, deployment_generation=excluded.deployment_generation,
      source_operation_id=excluded.source_operation_id, provider_id=excluded.provider_id,target_key=excluded.target_key
      WHERE (${plan.publicationGuard.sql}) AND ${extra}`,
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

async function start(h: Awaited<ReturnType<typeof harness>>) {
  const owner = h.ledger.forTrustedOwner(OWNER);
  const reservation = await owner.reserve({
    reservationId: "reservation-actual",
    name: "route-update",
  });
  const command = input(reservation, 1, "immutable-script-one");
  await accept(h.sql, command);
  const plan = owner.prepareActivate(command, guards(command));
  await h.sql.batch(batch(plan));
  const active = (await owner.settleRoute(plan.original, "acknowledged")).assignment;
  return { owner, reservation, active, plan };
}

test("native OLD schema supports legacy APIs but new prepared commands fail without a silent fallback", async () => {
  const h = await harness(false);
  try {
    const owner = h.ledger.forTrustedOwner(OWNER);
    const held = await owner.reserve({ reservationId: "old-schema", name: "route-update" });
    const command = input(held, 1, "immutable-script-one");
    await accept(h.sql, command);
    const plan = owner.prepareActivate(command, guards(command));
    expect(
      await h.sql.query(
        "SELECT name FROM sqlite_master WHERE name IN ('shared_app_staging_route_commands','shared_app_staging_batch_assertions')",
      ),
    ).toEqual([]);
    await expect(h.sql.batch(batch(plan))).rejects.toMatchObject({ code: "unavailable" });
    expect(await owner.readOriginal(held.reservationId)).toEqual(held);
    await expect(owner.settleRoute(plan.original, "unknown")).rejects.toMatchObject({
      code: "indeterminate",
      original: plan.original,
    });
    const active = await owner.activate(held, "legacy-script");
    expect((await h.ledger.readCurrent("route-update"))?.script).toBe("legacy-script");
    const released = await owner.release(active);
    expect(released.state).toBe("released");
    expect(await h.ledger.readCurrent("route-update")).toBeNull();
  } finally {
    await h.close();
  }
});

test("native D1 activate/advance/retire/republish keep tenant incarnation and monotonic immutable route history", async () => {
  const h = await harness();
  try {
    const { owner, reservation, active, plan } = await start(h);
    const successor = input(active, 2, "immutable-script-two");
    await accept(h.sql, successor);
    const advance = owner.prepareAdvance(successor, guards(successor));
    await h.sql.batch(batch(advance));
    const updated = (await owner.settleRoute(advance.original, "acknowledged")).assignment;
    expect(updated).toMatchObject({
      incarnation: reservation.incarnation,
      generation: 3,
      script: "immutable-script-two",
    });
    expect(
      await h.ledger.isCurrentBeforeDispatch({ ...active, script: "immutable-script-one" }),
    ).toBe(false);
    expect(
      await h.ledger.isCurrentAfterDispatch({ ...updated, script: "immutable-script-two" }),
    ).toBe(true);
    const retiredCommand = input(updated, 3, null);
    await accept(h.sql, retiredCommand);
    const retire = owner.prepareRetire(retiredCommand, guards(retiredCommand));
    await h.sql.batch(batch(retire));
    const held = (await owner.settleRoute(retire.original, "acknowledged")).assignment;
    expect(held).toMatchObject({
      incarnation: reservation.incarnation,
      generation: 4,
      state: "reserved",
      script: null,
      releasedAt: null,
    });
    expect(await h.ledger.readCurrent("route-update")).toBeNull();
    const republishCommand = input(held, 4, "immutable-script-four");
    await accept(h.sql, republishCommand);
    const republish = owner.prepareActivate(republishCommand, guards(republishCommand));
    await h.sql.batch(batch(republish));
    const republished = (await owner.settleRoute(republish.original, "acknowledged")).assignment;
    expect(republished).toMatchObject({
      incarnation: reservation.incarnation,
      generation: 5,
      state: "active",
    });
    expect((await owner.readRouteCommand(plan.original.commandRef))?.assignment).toEqual(active);
    expect(
      await h.sql.query(
        "SELECT prior_generation,next_generation FROM shared_app_staging_route_commands ORDER BY next_generation",
      ),
    ).toEqual([
      { prior_generation: 1, next_generation: 2 },
      { prior_generation: 2, next_generation: 3 },
      { prior_generation: 3, next_generation: 4 },
      { prior_generation: 4, next_generation: 5 },
    ]);
    expect(await h.sql.query("SELECT * FROM shared_app_staging_batch_assertions")).toEqual([]);
    expect(await h.sql.query("SELECT * FROM shared_app_production_route_commands")).toEqual([]);
  } finally {
    await h.close();
  }
});

test("native D1 zero-row owner route guard fails a constraint and rolls back ledger/history/witness writes", async () => {
  const h = await harness();
  try {
    const { owner, active } = await start(h);
    const command = input(active, 2, "immutable-script-two");
    await accept(h.sql, command);
    const plan = owner.prepareAdvance(command, guards(command));
    const before = await h.sql.query("SELECT * FROM shared_app_staging_route_commands");
    await expect(h.sql.batch(batch(plan, true))).rejects.toMatchObject({ code: "constraint" });
    expect(await owner.readOriginal(active.reservationId)).toEqual(active);
    expect(await h.sql.query("SELECT * FROM shared_app_staging_route_commands")).toEqual(before);
    expect(await h.sql.query("SELECT * FROM shared_app_staging_batch_assertions")).toEqual([]);
    expect(await h.sql.query("SELECT generation,script FROM fixture_routes")).toEqual([
      { generation: 2, script: "immutable-script-one" },
    ]);
    await expect(h.sql.batch([...plan.before, ...plan.after])).rejects.toMatchObject({
      code: "constraint",
    });
    expect(await owner.readOriginal(active.reservationId)).toEqual(active);
    await expect(h.sql.batch([routeMutation(plan), ...plan.after])).rejects.toMatchObject({
      code: "constraint",
    });
    expect(await owner.readOriginal(active.reservationId)).toEqual(active);
    await h.sql.batch(batch(plan));
    expect((await owner.settleRoute(plan.original, "acknowledged")).assignment.generation).toBe(3);
  } finally {
    await h.close();
  }
});

test("native D1 historical exact replay never rewinds a newer route, and changed original pins conflict", async () => {
  const h = await harness();
  try {
    const { owner, active, plan: first } = await start(h);
    const command = input(active, 2, "immutable-script-two");
    await accept(h.sql, command);
    const second = owner.prepareAdvance(command, guards(command));
    await h.sql.batch(batch(second));
    const history = await h.sql.query(
      "SELECT * FROM shared_app_staging_route_commands ORDER BY next_generation",
    );
    const routes = await h.sql.query("SELECT * FROM fixture_routes");
    // Both replayed plans have stale admission predicates now; exact history still settles with no route mutation.
    await h.sql.batch(batch(first));
    await h.sql.batch(batch(second));
    expect(await h.sql.query("SELECT * FROM fixture_routes")).toEqual(routes);
    expect(
      await h.sql.query("SELECT * FROM shared_app_staging_route_commands ORDER BY next_generation"),
    ).toEqual(history);
    expect((await owner.settleRoute(first.original, "acknowledged")).assignment).toEqual(active);
    const current = await owner.readOriginal(active.reservationId);
    if (!current) throw new Error("missing current fixture assignment");
    const changed = input(current, 3, "immutable-script-three", second.original.commandRef);
    await accept(h.sql, changed);
    const conflict = owner.prepareAdvance(changed, guards(changed));
    await expect(h.sql.batch(batch(conflict))).rejects.toMatchObject({ code: "constraint" });
    await expect(owner.settleRoute(conflict.original, "unknown")).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      await h.sql.query("SELECT * FROM shared_app_staging_route_commands ORDER BY next_generation"),
    ).toEqual(history);
    expect(await h.sql.query("SELECT * FROM fixture_routes")).toEqual(routes);
  } finally {
    await h.close();
  }
});

test("native D1 prepared caller strings cannot replace the actual accepted graph", async () => {
  const h = await harness();
  try {
    const { owner, active } = await start(h);
    const accepted = input(active, 2, "immutable-script-two");
    await accept(h.sql, accepted);
    const forged = input(active, 2, "unaccepted-script");
    const plan = owner.prepareAdvance(forged, guards(forged));
    await expect(h.sql.batch(batch(plan))).rejects.toMatchObject({ code: "constraint" });
    expect(await owner.readOriginal(active.reservationId)).toEqual(active);
    expect(await owner.readRouteCommand(plan.original.commandRef)).toBeNull();
    expect(() =>
      owner.prepareAdvance(
        { ...accepted, accepted: { ...accepted.accepted, principal: "org:foreign" } },
        guards(accepted),
      ),
    ).toThrow(expect.objectContaining({ code: "conflict" }));
  } finally {
    await h.close();
  }
});

test("native D1 owner collision guard refuses a foreign host projection without partial ledger history", async () => {
  const h = await harness();
  try {
    const { owner, active } = await start(h);
    const command = input(active, 2, "immutable-script-two");
    await accept(h.sql, command);
    const plan = owner.prepareAdvance(command, guards(command));
    await h.sql.run("UPDATE fixture_routes SET organization_id=?,incarnation=? WHERE hostname=?", [
      "foreign-org",
      "b".repeat(32),
      HOSTNAME,
    ]);
    await expect(h.sql.batch(batch(plan))).rejects.toMatchObject({ code: "constraint" });
    expect(await owner.readOriginal(active.reservationId)).toEqual(active);
    expect(await owner.readRouteCommand(plan.original.commandRef)).toBeNull();
    expect(await h.sql.query("SELECT organization_id FROM fixture_routes")).toEqual([
      { organization_id: "foreign-org" },
    ]);
    expect(await h.sql.query("SELECT * FROM shared_app_staging_batch_assertions")).toEqual([]);
  } finally {
    await h.close();
  }
});

test("native D1 snapshots trusted input/guards before await and lost ACK retains exact original command", async () => {
  const h = await harness();
  try {
    const { owner, active } = await start(h);
    const command = input(active, 2, "immutable-script-two");
    await accept(h.sql, command);
    const mutable = JSON.parse(JSON.stringify(command)) as TrustedSharedAppRouteInput;
    const mutableGuards = JSON.parse(
      JSON.stringify(guards(command)),
    ) as TrustedSharedAppRouteGuards;
    const reads = h.reads();
    const plan = owner.prepareAdvance(mutable, mutableGuards);
    expect(h.reads()).toBe(reads);
    (mutable.accepted as { script: string }).script = "changed-after-capture";
    (mutable.expected as { generation: number }).generation = 400;
    (mutableGuards.admission.params as (string | number | null)[])[0] = "foreign-endpoint";
    expect(Object.isFrozen(plan.before[0]?.params)).toBe(true);
    const loseAck = async () => {
      await h.sql.batch(batch(plan));
      h.block(true);
      throw new Error("lost ACK after native commit");
    };
    await expect(loseAck()).rejects.toThrow("lost ACK");
    await expect(owner.settleRoute(plan.original, "unknown")).rejects.toMatchObject({
      code: "indeterminate",
      original: plan.original,
    });
    h.block(false);
    const settled = await owner.settleRoute(plan.original, "unknown");
    expect(settled.original).toEqual(plan.original);
    expect(settled.assignment).toMatchObject({
      generation: 3,
      script: "immutable-script-two",
      incarnation: active.incarnation,
    });
    const successor = input(settled.assignment, 3, "immutable-script-three");
    await accept(h.sql, successor);
    const next = owner.prepareAdvance(successor, guards(successor));
    await h.sql.batch(batch(next));
    expect((await owner.settleRoute(plan.original, "unknown")).assignment.generation).toBe(3);
    expect((await h.ledger.readCurrent("route-update"))?.generation).toBe(4);
    expect(await h.sql.query("SELECT COUNT(*) n FROM shared_app_staging_route_commands")).toEqual([
      { n: 3 },
    ]);
  } finally {
    await h.close();
  }
});

test("native D1 unknown missing ACK never mints a new reference or writes a recovery command", async () => {
  const h = await harness();
  try {
    const { owner, active } = await start(h);
    const command = input(active, 2, "immutable-script-two");
    const plan = owner.prepareAdvance(command, guards(command));
    await expect(owner.settleRoute(plan.original, "unknown")).rejects.toMatchObject({
      code: "indeterminate",
      original: plan.original,
    });
    await expect(owner.settleRoute(plan.original, "acknowledged")).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await owner.readOriginal(active.reservationId)).toEqual(active);
    expect(await h.sql.query("SELECT COUNT(*) n FROM shared_app_staging_route_commands")).toEqual([
      { n: 1 },
    ]);
  } finally {
    await h.close();
  }
});

test("native D1 concurrent out-of-order accepted old/new publications only commit the current accepted original", async () => {
  for (const reverse of [false, true]) {
    const h = await harness();
    try {
      const { owner, active } = await start(h);
      const old = input(active, 2, "immutable-script-old");
      await accept(h.sql, old);
      const stale = owner.prepareAdvance(old, guards(old));
      const current = input(active, 3, "immutable-script-current");
      await accept(h.sql, current);
      const fresh = owner.prepareAdvance(current, guards(current));
      const plans = reverse ? [fresh, stale] : [stale, fresh];
      const results = await Promise.allSettled(plans.map((plan) => h.sql.batch(batch(plan))));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results[reverse ? 0 : 1]?.status).toBe("fulfilled");
      expect((await h.ledger.readCurrent("route-update"))?.script).toBe("immutable-script-current");
      expect(await owner.readRouteCommand(stale.original.commandRef)).toBeNull();
      expect((await owner.readRouteCommand(fresh.original.commandRef))?.assignment.generation).toBe(
        3,
      );
      expect(await h.sql.query("SELECT generation,script FROM fixture_routes")).toEqual([
        { generation: 3, script: "immutable-script-current" },
      ]);
    } finally {
      await h.close();
    }
  }
});

test("native D1 concurrent release and normal update CAS fence an old route projection", async () => {
  const h = await harness();
  try {
    const { owner, active } = await start(h);
    const command = input(active, 2, "immutable-script-two");
    await accept(h.sql, command);
    const plan = owner.prepareAdvance(command, guards(command));
    const results = await Promise.allSettled([owner.release(active), h.sql.batch(batch(plan))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const final = await owner.readOriginal(active.reservationId);
    if (!final) throw new Error("missing final fixture assignment");
    expect(final.generation).toBe(3);
    expect(final.incarnation).toBe(active.incarnation);
    if (final.state === "active") {
      expect((await h.ledger.readCurrent("route-update"))?.script).toBe("immutable-script-two");
      expect((await owner.readRouteCommand(plan.original.commandRef))?.assignment).toEqual(final);
    } else {
      expect(final.state).toBe("released");
      expect(await h.ledger.readCurrent("route-update")).toBeNull();
      expect(await owner.readRouteCommand(plan.original.commandRef)).toBeNull();
      // A legacy projection may remain, but neither gateway fence may authorize it.
      expect(
        await h.ledger.isCurrentBeforeDispatch({ ...active, script: "immutable-script-one" }),
      ).toBe(false);
    }
    expect((await owner.readRouteCommand("v2-host-route-1"))?.assignment).toEqual(active);
  } finally {
    await h.close();
  }
});

test("native D1 original history survives explicit cooldown release/reassignment and refuses foreign recovery", async () => {
  const h = await harness();
  try {
    const { owner, active, plan } = await start(h);
    const retireCommand = input(active, 2, null);
    await accept(h.sql, retireCommand);
    const retire = owner.prepareRetire(retireCommand, guards(retireCommand));
    await h.sql.batch(batch(retire));
    const held = (await owner.settleRoute(retire.original, "acknowledged")).assignment;
    await owner.release(held);
    h.setNow(START + 31 * 24 * 60 * 60 * 1000);
    const foreign = h.ledger.forTrustedOwner({
      organizationId: "org-hosted",
      product: "takosumi-hosted",
    });
    const reassigned = await foreign.reserve({
      reservationId: "foreign-original",
      name: "route-update",
    });
    expect(reassigned.incarnation).not.toBe(active.incarnation);
    expect(reassigned.generation).toBe(5);
    expect((await owner.settleRoute(plan.original, "unknown")).assignment).toEqual(active);
    expect(await foreign.readRouteCommand(plan.original.commandRef)).toBeNull();
    await expect(foreign.settleRoute(plan.original, "unknown")).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      h.ledger
        .forTrustedOwner({ ...OWNER, product: "takosumi-hosted" })
        .readRouteCommand(plan.original.commandRef),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      await h.ledger.isCurrentAfterDispatch({ ...active, script: "immutable-script-one" }),
    ).toBe(false);
  } finally {
    await h.close();
  }
});
