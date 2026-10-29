import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { root0107Recipe } from "../scripts/deploy/root0107-recipe.ts";
import type { Sql } from "../src/ports.ts";
import { createSharedAppLedger } from "../src/shared-app-ledger.ts";
import { SHARED_APP_STAGING_PHYSICAL_DDL } from "../src/shared-app-staging-adoption.ts";
import {
  createSharedAppStagingOriginHistory,
  SHARED_APP_STAGING_ORIGIN_HISTORY_DDL,
  SharedAppStagingOriginHistoryError,
} from "../src/shared-app-staging-origin-history.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { migrateSqliteDatabase } from "./helpers/migrated-database.ts";

const original = (name: string, state: string) => ({
  name,
  predecessor: "prior-host-storage",
  originalKey: `origin/${name}`,
  ownerRef: "original-native-owner",
  originalState: state,
  originalJson: JSON.stringify({ state, owner: "original-native-owner", generation: 9 }),
});

function fixture() {
  const db = migrateSqliteDatabase();
  for (const statement of [
    ...SHARED_APP_STAGING_PHYSICAL_DDL,
    ...SHARED_APP_STAGING_ORIGIN_HISTORY_DDL,
  ])
    db.exec(statement);
  const sql = createSqliteSql(db);
  return { db, sql, history: createSharedAppStagingOriginHistory({ sql }) };
}

async function insertLegacy(sql: Sql, origin: string, reservation = "legacy-original") {
  return sql.run(
    `INSERT INTO worker_endpoint_origin_reservations (
      organization_id,reservation_id,reservation_format,legacy_space,legacy_worker_name,
      legacy_endpoint_name,canonical_public_origin,provider_pack_ref,provider_installation_ref,
      offering_id,offering_digest,requested_ttl_seconds,expires_at,state,revision,created_at,updated_at)
      VALUES (?,?,?,'space','worker','endpoint',?,'provider','installation','offering',?,3600,3600000,'prepared',1,0,0)`,
    [
      "prior-org",
      reservation,
      "takoserver.worker-endpoint-origin-reservation.v1",
      origin,
      `sha256:${"a".repeat(64)}`,
    ],
  );
}

test("history preserves exact originals and cannot rewrite active ownership or delete tombstones", async () => {
  const f = fixture();
  try {
    const retained = original("prior-app", "active");
    await f.history.retain(retained);
    await f.history.retain(retained);
    for (const change of [
      { ownerRef: "new-owner" },
      { predecessor: "other-storage" },
      { originalKey: "other-original" },
      { originalState: "tombstone", originalJson: JSON.stringify({ state: "tombstone" }) },
      { originalJson: '{ "state":"active","owner":"original-native-owner","generation":9 }' },
      { name: "other-name" },
    ]) {
      await expect(f.history.retain({ ...retained, ...change })).rejects.toMatchObject({
        code: "conflict",
      });
    }
    expect(() =>
      f.db.query("UPDATE shared_app_staging_origin_history SET original_state='tombstone'").run(),
    ).toThrow();
    expect(() => f.db.query("DELETE FROM shared_app_staging_origin_history").run()).toThrow();
    expect(
      f.db
        .query("SELECT original_state,original_json FROM shared_app_staging_origin_history")
        .get(),
    ).toEqual({
      original_state: "active",
      original_json: retained.originalJson,
    });
    await f.history.retain(original("root", "tombstone"));
    await f.history.retain(original("a".repeat(63), "tombstone"));
    expect(f.db.query("SELECT count(*) AS n FROM shared_app_staging_origin_history").get()).toEqual(
      { n: 3 },
    );
  } finally {
    f.db.close();
  }
});

test("history refuses malformed or relabelled metadata before any SQL and never retries unknown writes", async () => {
  let reads = 0;
  let writes = 0;
  const sql: Sql = {
    async query() {
      reads += 1;
      return [];
    },
    async run() {
      writes += 1;
      throw new Error("fixture lost acknowledgement");
    },
    async batch() {
      throw new Error("unexpected batch");
    },
  };
  const history = createSharedAppStagingOriginHistory({ sql });
  const retained = original("prior-app", "active");
  for (const value of [
    { ...retained, originalState: "tombstone" },
    { ...retained, name: "PRIOR-APP" },
    { ...retained, name: "prior.app" },
    { ...retained, originalJson: "[]" },
    { ...retained, originalJson: "{}" },
    { ...retained, originalJson: "not-json" },
    { ...retained, originalJson: JSON.stringify({ state: "active", text: "x".repeat(65_536) }) },
    { ...retained, product: "takoserver" },
  ])
    await expect(history.retain(value)).rejects.toBeInstanceOf(TypeError);
  expect(reads).toBe(0);
  expect(writes).toBe(0);
  await expect(history.retain(retained)).rejects.toBeInstanceOf(SharedAppStagingOriginHistoryError);
  expect(reads).toBe(1);
  expect(writes).toBe(1);
});

test("retained history blocks old v1 origin aliases but leaves unrelated names available", async () => {
  const f = fixture();
  try {
    await f.history.retain(original("prior-app", "tombstone"));
    const unrelated = "http://prior-app.app-staging.takos.jp.evil.test";
    await insertLegacy(f.sql, unrelated, "unrelated");
    for (const [index, origin] of [
      "http://prior-app.app-staging.takos.jp",
      "https://PRIOR-APP.APP-STAGING.TAKOS.JP.:8443",
      "https://prior-app.app-staging.takos.jp:0",
    ].entries()) {
      await expect(insertLegacy(f.sql, origin, `blocked-${index}`)).rejects.toBeDefined();
      await expect(
        f.sql.run(
          "UPDATE worker_endpoint_origin_reservations SET canonical_public_origin=? WHERE reservation_id='unrelated'",
          [origin],
        ),
      ).rejects.toBeDefined();
    }
    const ledger = createSharedAppLedger({ environment: "staging", primary: () => f.sql });
    await ledger.forTrustedOwner({ organizationId: "new-org", product: "takoserver" }).reserve({
      reservationId: "free-reservation",
      name: "free-app",
    });
    expect(await ledger.readCurrent("prior-app")).toBeNull();
    expect(
      f.db.query("SELECT canonical_public_origin FROM worker_endpoint_origin_reservations").get(),
    ).toEqual({ canonical_public_origin: unrelated });
  } finally {
    f.db.close();
  }
});

test("retention cannot quarantine an already selected destination assignment or legacy origin", async () => {
  const f = fixture();
  try {
    const ledger = createSharedAppLedger({ environment: "staging", primary: () => f.sql });
    await ledger
      .forTrustedOwner({ organizationId: "new-org", product: "takoserver" })
      .reserve({ reservationId: "selected", name: "new-app" });
    await expect(f.history.retain(original("new-app", "tombstone"))).rejects.toMatchObject({
      code: "conflict",
    });
    await insertLegacy(f.sql, "http://PRIOR-APP.APP-STAGING.TAKOS.JP.:443");
    await expect(f.history.retain(original("prior-app", "active"))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(f.db.query("SELECT count(*) AS n FROM shared_app_staging_origin_history").get()).toEqual(
      { n: 0 },
    );
  } finally {
    f.db.close();
  }
});

test("Root0107's original 18-statement recipe remains byte-pinned", () => {
  expect(SHARED_APP_STAGING_PHYSICAL_DDL).toHaveLength(18);
  expect(root0107Recipe().digest).toBe(
    "sha256:274fd5f006e2bc83a38deb3c48af853e5e329d0cf1b412c22a0e695e2b70ddb4",
  );
});

test("concurrent retention reads back the same original without rewriting or retrying", async () => {
  const f = fixture();
  try {
    const retained = original("prior-app", "active");
    const competing = createSharedAppStagingOriginHistory({
      sql: f.sql,
      clock: () => new Date(20),
    });
    let writes = 0;
    const sql: Sql = {
      query: (query, params) => f.sql.query(query, params),
      batch: (statements) => f.sql.batch(statements),
      async run(query, params) {
        writes += 1;
        await competing.retain(retained);
        return f.sql.run(query, params);
      },
    };
    const history = createSharedAppStagingOriginHistory({ sql, clock: () => new Date(10) });
    await history.retain(retained);
    expect(writes).toBe(1);
    expect(
      f.db
        .query("SELECT retained_at,owner_ref,original_state FROM shared_app_staging_origin_history")
        .get(),
    ).toEqual({ retained_at: 20, owner_ref: "original-native-owner", original_state: "active" });
  } finally {
    f.db.close();
  }
});

test("SQL REPLACE cannot overwrite or rename retained predecessor ownership", async () => {
  const f = fixture();
  try {
    await f.history.retain(original("prior-app", "active"));
    for (const selection of [
      "name,predecessor,original_key,'replacement-owner',original_state,original_json,retained_at",
      "'renamed-app',predecessor,original_key,owner_ref,original_state,original_json,retained_at",
    ]) {
      expect(() =>
        f.db.exec(`INSERT OR REPLACE INTO shared_app_staging_origin_history
        (name,predecessor,original_key,owner_ref,original_state,original_json,retained_at)
        SELECT ${selection} FROM shared_app_staging_origin_history WHERE name='prior-app'`),
      ).toThrow();
    }
    expect(
      f.db
        .query("SELECT name,owner_ref,original_state FROM shared_app_staging_origin_history")
        .get(),
    ).toEqual({ name: "prior-app", owner_ref: "original-native-owner", original_state: "active" });
  } finally {
    f.db.close();
  }
});

test("additive history fences execute with native D1 and roll back a conflicting destination batch", async () => {
  const id = `origin-history-${crypto.randomUUID()}`;
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
                contents: "export default {fetch(){return new Response('ok')}}",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const sql = createD1Sql(await runtime.getD1Database("STATE_DB"));
    await sql.run(`CREATE TABLE worker_endpoint_origin_reservations (
      organization_id TEXT NOT NULL,reservation_id TEXT NOT NULL,reservation_format TEXT NOT NULL,
      legacy_space TEXT,legacy_worker_name TEXT,legacy_endpoint_name TEXT,requested_subdomain TEXT,
      canonical_public_origin TEXT NOT NULL,provider_pack_ref TEXT NOT NULL,
      provider_installation_ref TEXT NOT NULL,offering_id TEXT NOT NULL,offering_digest TEXT NOT NULL,
      requested_ttl_seconds INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL,
      revision INTEGER NOT NULL,bound_space TEXT,bound_worker_name TEXT,worker_resource_uid TEXT,
      worker_resource_revision TEXT,bound_endpoint_name TEXT,endpoint_resource_uid TEXT,
      endpoint_resource_revision TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      released_at INTEGER,PRIMARY KEY(organization_id,reservation_id))`);
    await sql.run("CREATE TABLE tf_v2_resources (uid TEXT PRIMARY KEY)");
    await sql.run("CREATE TABLE tf_v2_operations (id TEXT PRIMARY KEY)");
    for (const statement of [
      ...SHARED_APP_STAGING_PHYSICAL_DDL,
      ...SHARED_APP_STAGING_ORIGIN_HISTORY_DDL,
    ])
      await sql.run(statement);
    const history = createSharedAppStagingOriginHistory({ sql });
    await history.retain(original("prior-app", "active"));
    await expect(
      sql.run(`INSERT OR REPLACE INTO shared_app_staging_origin_history
        (name,predecessor,original_key,owner_ref,original_state,original_json,retained_at)
        SELECT name,predecessor,original_key,'replacement-owner',original_state,original_json,retained_at
        FROM shared_app_staging_origin_history WHERE name='prior-app'`),
    ).rejects.toMatchObject({ code: "constraint" });
    const ledger = createSharedAppLedger({ environment: "staging", primary: () => sql });
    await expect(
      ledger
        .forTrustedOwner({ organizationId: "new-org", product: "takosumi-hosted" })
        .reserve({ name: "prior-app", reservationId: "new-reservation" }),
    ).rejects.toBeDefined();
    await expect(
      insertLegacy(sql, "http://PRIOR-APP.APP-STAGING.TAKOS.JP.:443"),
    ).rejects.toBeDefined();
    expect(await sql.query("SELECT count(*) AS n FROM shared_app_staging_assignments")).toEqual([
      { n: 0 },
    ]);
    expect(await sql.query("SELECT count(*) AS n FROM shared_app_staging_names")).toEqual([
      { n: 0 },
    ]);
    expect(
      await sql.query("SELECT original_state,owner_ref FROM shared_app_staging_origin_history"),
    ).toEqual([{ original_state: "active", owner_ref: "original-native-owner" }]);
    await ledger
      .forTrustedOwner({ organizationId: "new-org", product: "takoserver" })
      .reserve({ name: "free-app", reservationId: "free-reservation" });
    await expect(history.retain(original("free-app", "tombstone"))).rejects.toMatchObject({
      code: "conflict",
    });
  } finally {
    await runtime.dispose();
  }
}, 60_000);

for (const state of ["active", "tombstone"]) {
  test(`retained ${state} predecessor origin cannot be reassigned in a fresh destination`, async () => {
    const f = fixture();
    try {
      await f.history.retain(original("prior-app", state));
      const ledger = createSharedAppLedger({ environment: "staging", primary: () => f.sql });
      await expect(
        ledger.forTrustedOwner({ organizationId: "new-org", product: "takosumi-hosted" }).reserve({
          reservationId: "new-reservation",
          name: "prior-app",
        }),
      ).rejects.toBeDefined();
      expect(f.db.query("SELECT count(*) AS n FROM shared_app_staging_assignments").get()).toEqual({
        n: 0,
      });
      expect(f.db.query("SELECT count(*) AS n FROM shared_app_staging_names").get()).toEqual({
        n: 0,
      });
      expect(
        f.db
          .query(
            "SELECT owner_ref,original_state,original_json FROM shared_app_staging_origin_history",
          )
          .get(),
      ).toEqual({
        owner_ref: "original-native-owner",
        original_state: state,
        original_json: original("prior-app", state).originalJson,
      });
    } finally {
      f.db.close();
    }
  });
}
