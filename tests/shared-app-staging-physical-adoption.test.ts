import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { createCatalog, createResourceDeploymentStore } from "../src/index.ts";
import type { Sql } from "../src/ports.ts";
import { createSharedAppLedger } from "../src/shared-app-ledger.ts";
import {
  createSharedAppStagingAdoption,
  SHARED_APP_STAGING_PHYSICAL_DDL,
  SharedAppStagingAdoptionError,
} from "../src/shared-app-staging-adoption.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformStore } from "../src/takoform/store.ts";
import { createWorkerEndpointOriginReservations } from "../src/worker-endpoint-origin-reservations.ts";
import { migrateSqliteDatabase } from "./helpers/migrated-database.ts";

const NOW = Date.parse("2026-10-23T00:00:00Z");
const DIGEST = `sha256:${"a".repeat(64)}`;

function fixture() {
  const db = migrateSqliteDatabase();
  for (const statement of SHARED_APP_STAGING_PHYSICAL_DDL) db.exec(statement);
  const sql = createSqliteSql(db);
  const adoption = createSharedAppStagingAdoption({ sql, clock: () => new Date(NOW) });
  const legacy = (name = "held-app", reservationId = "original-reservation") => {
    db.query(`INSERT INTO worker_endpoint_origin_reservations (
      organization_id,reservation_id,reservation_format,requested_subdomain,canonical_public_origin,
      provider_pack_ref,provider_installation_ref,offering_id,offering_digest,
      requested_ttl_seconds,expires_at,state,revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'prepared',1,?,?)`).run(
      "org-one",
      reservationId,
      "takoserver.worker-endpoint-origin-reservation.v2",
      name,
      `https://${name}.app-staging.takos.jp`,
      "provider-one",
      "installation-one",
      "offering-one",
      DIGEST,
      3600,
      NOW + 3_600_000,
      NOW - 3_600_000,
      NOW - 3_600_000,
    );
  };
  const legacyV1 = (origin: string, reservationId = "legacy-v1") => {
    db.query(`INSERT INTO worker_endpoint_origin_reservations (
      organization_id,reservation_id,reservation_format,legacy_space,legacy_worker_name,
      legacy_endpoint_name,canonical_public_origin,provider_pack_ref,provider_installation_ref,
      offering_id,offering_digest,requested_ttl_seconds,expires_at,state,revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',1,?,?)`).run(
      "org-one",
      reservationId,
      "takoserver.worker-endpoint-origin-reservation.v1",
      "legacy-space",
      "legacy-worker",
      "legacy-endpoint",
      origin,
      "provider-one",
      "installation-one",
      "offering-one",
      DIGEST,
      3600,
      NOW + 3_600_000,
      NOW - 3_600_000,
      NOW - 3_600_000,
    );
  };
  return { db, sql, adoption, legacy, legacyV1 };
}

test("retained v1 origin aliases block a new name head and v2 adoption", async () => {
  for (const origin of [
    "http://held-app.app-staging.takos.jp",
    "https://held-app.app-staging.takos.jp:8443",
    "http://HELD-APP.APP-STAGING.TAKOS.JP.:28988",
  ]) {
    const f = fixture();
    try {
      f.legacyV1(origin);
      const ledger = createSharedAppLedger({ environment: "staging", primary: () => f.sql });
      await expect(
        ledger.forTrustedOwner({ organizationId: "org-one", product: "takoserver" }).reserve({
          reservationId: "new-shared-ref",
          name: "held-app",
        }),
      ).rejects.toBeDefined();
      f.legacy();
      await expect(
        f.adoption.adopt({ organizationId: "org-one", reservationId: "original-reservation" }),
      ).rejects.toBeInstanceOf(SharedAppStagingAdoptionError);
      expect(f.db.query("SELECT count(*) AS n FROM shared_app_staging_names").get()).toEqual({
        n: 0,
      });
      expect(f.db.query("SELECT count(*) AS n FROM shared_app_staging_adoptions").get()).toEqual({
        n: 0,
      });
    } finally {
      f.db.close();
    }
  }
});

test("held name fences old v1 insert and update aliases without trapping another Host", async () => {
  const f = fixture();
  try {
    f.legacyV1("http://held-app.app-staging.takos.jp.evil.test", "other-host");
    f.legacy();
    await f.adoption.adopt({ organizationId: "org-one", reservationId: "original-reservation" });
    for (const [index, origin] of [
      "http://held-app.app-staging.takos.jp",
      "https://held-app.app-staging.takos.jp:8443",
      "http://HELD-APP.APP-STAGING.TAKOS.JP.:28988",
    ].entries()) {
      expect(() => f.legacyV1(origin, `blocked-${index}`)).toThrow();
      expect(() =>
        f.db
          .query(
            "UPDATE worker_endpoint_origin_reservations SET canonical_public_origin=? WHERE reservation_id='other-host'",
          )
          .run(origin),
      ).toThrow();
    }
    f.db
      .query(
        "UPDATE worker_endpoint_origin_reservations SET state='released',released_at=? WHERE reservation_id='other-host'",
      )
      .run(NOW);
    expect(
      f.db
        .query(
          "SELECT canonical_public_origin,state FROM worker_endpoint_origin_reservations WHERE reservation_id='other-host'",
        )
        .get(),
    ).toEqual({
      canonical_public_origin: "http://held-app.app-staging.takos.jp.evil.test",
      state: "released",
    });
    f.db
      .query("DELETE FROM worker_endpoint_origin_reservations WHERE reservation_id='other-host'")
      .run();
  } finally {
    f.db.close();
  }
});

test("an untouched 0035 original becomes one guarded shared hold without rewriting metadata", async () => {
  const f = fixture();
  try {
    f.legacy();
    const before = f.db.query("SELECT * FROM worker_endpoint_origin_reservations").get();
    const receipt = await f.adoption.adopt({
      organizationId: "org-one",
      reservationId: "original-reservation",
    });
    expect(receipt.name).toBe("held-app");
    expect(receipt.generation).toBe(1);
    expect(f.db.query("SELECT * FROM worker_endpoint_origin_reservations").get()).toEqual(before);
    expect(
      f.db.query("SELECT normalized_name,state,generation FROM shared_app_staging_names").get(),
    ).toEqual({ normalized_name: "held-app", state: "reserved", generation: 1 });
    expect(f.db.query("SELECT count(*) AS n FROM shared_app_staging_adoptions").get()).toEqual({
      n: 1,
    });
  } finally {
    f.db.close();
  }
});

test("physical triggers stop installed scalar and reservation writers on an adopted name", async () => {
  const f = fixture();
  try {
    f.legacy();
    const pin = await f.adoption.adopt({
      organizationId: "org-one",
      reservationId: "original-reservation",
    });
    const before = {
      legacy: f.db.query("SELECT * FROM worker_endpoint_origin_reservations").get(),
      assignment: f.db.query("SELECT * FROM shared_app_staging_assignments").get(),
      name: f.db.query("SELECT * FROM shared_app_staging_names").get(),
    };
    const scalar = createSharedAppLedger({ environment: "staging", primary: () => f.sql });
    const oldOwner = scalar.forTrustedOwner({ organizationId: "org-one", product: "takoserver" });
    const scalarPin = { ...pin, environment: "staging" as const, product: "takoserver" as const };
    await expect(oldOwner.activate(scalarPin, "old-script")).rejects.toBeDefined();
    await expect(oldOwner.release(scalarPin)).rejects.toBeDefined();
    const clock = () => new Date(NOW);
    const legacy = createWorkerEndpointOriginReservations({
      sql: f.sql,
      clock,
      catalog: createCatalog([]),
      providers: [],
      resources: createTakoformStore(f.sql, clock),
      deployments: createResourceDeploymentStore(f.sql, clock),
    });
    await expect(legacy.release("org-one", "original-reservation")).rejects.toBeDefined();
    expect(f.db.query("SELECT * FROM worker_endpoint_origin_reservations").get()).toEqual(
      before.legacy,
    );
    expect(f.db.query("SELECT * FROM shared_app_staging_assignments").get()).toEqual(
      before.assignment,
    );
    expect(f.db.query("SELECT * FROM shared_app_staging_names").get()).toEqual(before.name);
    expect(() =>
      f.db.query("UPDATE worker_endpoint_origin_reservations SET revision=revision+1").run(),
    ).toThrow();
    expect(() => f.db.query("DELETE FROM worker_endpoint_origin_reservations").run()).toThrow();
  } finally {
    f.db.close();
  }
});

test("permanent name history rejects a second old writer and retains unadopted drain", async () => {
  const f = fixture();
  try {
    f.legacy("held-app", "original-reservation");
    f.legacy("other-app", "other-reservation");
    const untouched = f.db
      .query(
        "SELECT * FROM worker_endpoint_origin_reservations WHERE reservation_id='other-reservation'",
      )
      .get();
    await f.adoption.adopt({ organizationId: "org-one", reservationId: "original-reservation" });
    expect(() => f.legacy("held-app", "new-reservation")).toThrow();
    f.db
      .query(
        "UPDATE worker_endpoint_origin_reservations SET state='released',released_at=? WHERE reservation_id='other-reservation'",
      )
      .run(NOW);
    expect(
      f.db
        .query(
          "SELECT state,released_at FROM worker_endpoint_origin_reservations WHERE reservation_id='other-reservation'",
        )
        .get(),
    ).toEqual({ state: "released", released_at: NOW });
    expect(untouched).toBeDefined();
  } finally {
    f.db.close();
  }
});

test("foreign, invalid, expired, released and ambiguous originals do not make a name head", async () => {
  for (const kind of ["foreign", "invalid", "expired", "released", "ambiguous"] as const) {
    const f = fixture();
    try {
      f.legacy(kind === "invalid" ? "xn--invalid" : "held-app");
      if (kind === "expired")
        f.db.query("UPDATE worker_endpoint_origin_reservations SET expires_at=?").run(NOW - 1);
      if (kind === "released")
        f.db
          .query("UPDATE worker_endpoint_origin_reservations SET state='released',released_at=?")
          .run(NOW);
      if (kind === "ambiguous") {
        f.legacy("other-app", "prior-reservation");
        f.db
          .query(
            "UPDATE worker_endpoint_origin_reservations SET state='released',released_at=?,requested_subdomain='held-app',canonical_public_origin='https://held-app.app-staging.takos.jp' WHERE reservation_id='prior-reservation'",
          )
          .run(NOW);
      }
      const before = f.db
        .query("SELECT * FROM worker_endpoint_origin_reservations ORDER BY reservation_id")
        .all();
      await expect(
        f.adoption.adopt({
          organizationId: "org-one",
          reservationId: kind === "foreign" ? "other-reservation" : "original-reservation",
        }),
      ).rejects.toBeInstanceOf(SharedAppStagingAdoptionError);
      expect(
        f.db
          .query("SELECT * FROM worker_endpoint_origin_reservations ORDER BY reservation_id")
          .all(),
      ).toEqual(before);
      expect(f.db.query("SELECT count(*) AS n FROM shared_app_staging_names").get()).toEqual({
        n: 0,
      });
      expect(f.db.query("SELECT count(*) AS n FROM shared_app_staging_adoptions").get()).toEqual({
        n: 0,
      });
    } finally {
      f.db.close();
    }
  }
});

test("lost commit acknowledgment settles only the original and a hidden read remains indeterminate", async () => {
  for (const hideRead of [false, true]) {
    const f = fixture();
    try {
      f.legacy();
      let afterBatch = false;
      const transport: Sql = {
        query: async (query, params) => {
          if (hideRead && afterBatch) throw new Error("read unavailable");
          return await f.sql.query(query, params);
        },
        run: f.sql.run,
        batch: async (statements) => {
          await f.sql.batch(statements);
          afterBatch = true;
          throw new Error("ack lost");
        },
      };
      const adoption = createSharedAppStagingAdoption({
        sql: transport,
        clock: () => new Date(NOW),
      });
      if (hideRead) {
        await expect(
          adoption.adopt({ organizationId: "org-one", reservationId: "original-reservation" }),
        ).rejects.toMatchObject({ code: "indeterminate", original: { name: "held-app" } });
      } else {
        const receipt = await adoption.adopt({
          organizationId: "org-one",
          reservationId: "original-reservation",
        });
        expect(receipt.name).toBe("held-app");
      }
      expect(f.db.query("SELECT count(*) AS n FROM shared_app_staging_adoptions").get()).toEqual({
        n: 1,
      });
      await expect(
        f.adoption.adopt({ organizationId: "org-one", reservationId: "original-reservation" }),
      ).rejects.toBeInstanceOf(SharedAppStagingAdoptionError);
      expect(f.db.query("SELECT count(*) AS n FROM shared_app_staging_adoptions").get()).toEqual({
        n: 1,
      });
    } finally {
      f.db.close();
    }
  }
});

test("accepted or native history refuses adoption and rolls back every partial insert", async () => {
  for (const history of ["resource", "native"] as const) {
    const f = fixture();
    try {
      f.legacy();
      if (history === "resource") {
        f.db
          .query(`INSERT INTO tf_v2_resources
          (uid,principal,form_url,space,name,backend_id,target_key,active_name,generation,
            phase,spec_json,last_operation)
          VALUES ('endpoint-uid','org:org-one','https://forms.test/Endpoint/1.0.0/',
            'org-one','held-app','backend','target','held-app',1,'pending','{}','operation-uid')`)
          .run();
      } else {
        f.db
          .query(`INSERT INTO cloudflare_managed_worker_routes
          (provider_id,route_kind,route_key,owner_native_id,generation,operation_id,state,value_json)
          VALUES ('provider','host','host/v2/held-app.app-staging.takos.jp',
            'native',1,'operation-uid','tombstone','{}')`)
          .run();
      }
      const before = f.db.query("SELECT * FROM worker_endpoint_origin_reservations").get();
      await expect(
        f.adoption.adopt({ organizationId: "org-one", reservationId: "original-reservation" }),
      ).rejects.toBeInstanceOf(SharedAppStagingAdoptionError);
      expect(f.db.query("SELECT * FROM worker_endpoint_origin_reservations").get()).toEqual(before);
      for (const table of ["assignments", "names", "adoptions", "batch_assertions"]) {
        expect(f.db.query(`SELECT count(*) AS n FROM shared_app_staging_${table}`).get()).toEqual({
          n: 0,
        });
      }
    } finally {
      f.db.close();
    }
  }
});

test("a current old reservation blocks a new global claim before adoption", async () => {
  const f = fixture();
  try {
    f.legacy();
    const ledger = createSharedAppLedger({ environment: "staging", primary: () => f.sql });
    await expect(
      ledger.forTrustedOwner({ organizationId: "org-one", product: "takoserver" }).reserve({
        reservationId: "different-ref",
        name: "held-app",
      }),
    ).rejects.toBeDefined();
    expect(f.db.query("SELECT count(*) AS n FROM shared_app_staging_assignments").get()).toEqual({
      n: 0,
    });
    expect(f.db.query("SELECT count(*) AS n FROM shared_app_staging_names").get()).toEqual({
      n: 0,
    });
  } finally {
    f.db.close();
  }
});

test("an installed lazy expiry writer cannot mutate the adopted original", async () => {
  const f = fixture();
  try {
    f.legacy();
    await f.adoption.adopt({ organizationId: "org-one", reservationId: "original-reservation" });
    const before = f.db.query("SELECT * FROM worker_endpoint_origin_reservations").get();
    const clock = () => new Date(NOW + 7_200_000);
    const old = createWorkerEndpointOriginReservations({
      sql: f.sql,
      clock,
      catalog: createCatalog([]),
      providers: [],
      resources: createTakoformStore(f.sql, clock),
      deployments: createResourceDeploymentStore(f.sql, clock),
    });
    await expect(old.read("org-one", "original-reservation")).rejects.toBeDefined();
    expect(f.db.query("SELECT * FROM worker_endpoint_origin_reservations").get()).toEqual(before);
  } finally {
    f.db.close();
  }
});

test("a changed 0035 original or omitted head phase rolls the entire adoption batch back", async () => {
  for (const fault of ["stale-original", "missing-head"] as const) {
    const f = fixture();
    try {
      f.legacy();
      const transport: Sql = {
        query: f.sql.query,
        run: f.sql.run,
        batch: async (statements) => {
          if (fault === "stale-original") {
            await f.sql.run(
              "UPDATE worker_endpoint_origin_reservations SET updated_at=updated_at+1 WHERE reservation_id=?",
              ["original-reservation"],
            );
            return await f.sql.batch(statements);
          }
          return await f.sql.batch(
            statements.map((statement, index) => (index === 2 ? { sql: "SELECT 1" } : statement)),
          );
        },
      };
      await expect(
        createSharedAppStagingAdoption({ sql: transport, clock: () => new Date(NOW) }).adopt({
          organizationId: "org-one",
          reservationId: "original-reservation",
        }),
      ).rejects.toBeInstanceOf(SharedAppStagingAdoptionError);
      for (const table of ["assignments", "names", "adoptions", "batch_assertions"]) {
        expect(f.db.query(`SELECT count(*) AS n FROM shared_app_staging_${table}`).get()).toEqual({
          n: 0,
        });
      }
    } finally {
      f.db.close();
    }
  }
});

test("staging physical statements and guarded atom execute under native D1 batch semantics", async () => {
  const id = `shared-physical-${crypto.randomUUID()}`;
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
          env: { STATE_DB: { type: "d1", id } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    const sql = createD1Sql(database);
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
    await sql.run("CREATE TABLE tf_v2_resources (uid TEXT,principal TEXT,space TEXT,name TEXT)");
    await sql.run("CREATE TABLE tf_v2_operations (id TEXT)");
    await sql.run(
      "CREATE TABLE cloudflare_managed_worker_routes (route_kind TEXT,route_key TEXT,value_json TEXT)",
    );
    for (const statement of SHARED_APP_STAGING_PHYSICAL_DDL) await sql.run(statement);
    await sql.run(
      `INSERT INTO worker_endpoint_origin_reservations
      (organization_id,reservation_id,reservation_format,requested_subdomain,canonical_public_origin,
        provider_pack_ref,provider_installation_ref,offering_id,offering_digest,
        requested_ttl_seconds,expires_at,state,revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'prepared',1,?,?)`,
      [
        "org-one",
        "original-reservation",
        "takoserver.worker-endpoint-origin-reservation.v2",
        "held-app",
        "https://held-app.app-staging.takos.jp",
        "provider-one",
        "installation-one",
        "offering-one",
        DIGEST,
        3600,
        NOW + 3_600_000,
        NOW - 3_600_000,
        NOW - 3_600_000,
      ],
    );
    const receipt = await createSharedAppStagingAdoption({ sql, clock: () => new Date(NOW) }).adopt(
      { organizationId: "org-one", reservationId: "original-reservation" },
    );
    expect(receipt.name).toBe("held-app");
    expect(await sql.query("SELECT normalized_name,state FROM shared_app_staging_names")).toEqual([
      { normalized_name: "held-app", state: "reserved" },
    ]);
    await expect(
      sql.run("UPDATE worker_endpoint_origin_reservations SET revision=2"),
    ).rejects.toBeDefined();
  } finally {
    await runtime.dispose();
  }
});

test("partial native drain never qualifies an untouched legacy original for adoption", async () => {
  for (const routeVersion of ["v1", "v2"] as const) {
    for (const state of ["active", "tombstone"] as const) {
      const f = fixture();
      try {
        f.legacy();
        f.db
          .query(`INSERT INTO cloudflare_managed_worker_routes
          (provider_id,route_kind,route_key,owner_native_id,generation,operation_id,state,value_json)
          VALUES ('provider','host',?,'native',1,'operation-uid',?,'{}')`)
          .run(`host/${routeVersion}/held-app.app-staging.takos.jp`, state);
        const before = {
          original: f.db.query("SELECT * FROM worker_endpoint_origin_reservations").get(),
          native: f.db.query("SELECT * FROM cloudflare_managed_worker_routes").all(),
        };
        await expect(
          f.adoption.adopt({
            organizationId: "org-one",
            reservationId: "original-reservation",
          }),
        ).rejects.toBeInstanceOf(SharedAppStagingAdoptionError);
        expect(f.db.query("SELECT * FROM worker_endpoint_origin_reservations").get()).toEqual(
          before.original,
        );
        expect(f.db.query("SELECT * FROM cloudflare_managed_worker_routes").all()).toEqual(
          before.native,
        );
        for (const table of ["assignments", "names", "adoptions", "batch_assertions"]) {
          expect(f.db.query(`SELECT count(*) AS n FROM shared_app_staging_${table}`).get()).toEqual(
            { n: 0 },
          );
        }
      } finally {
        f.db.close();
      }
    }
  }
});
