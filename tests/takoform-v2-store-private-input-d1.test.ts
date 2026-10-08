import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import type { Sql } from "../src/ports.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";

const createdAt = "2026-10-08T00:00:00.000Z";
const retainUntil = "2026-10-09T00:00:00.000Z";
const token = "private-input-lease-token";

function migration(name: string): string {
  const found = MIGRATIONS.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found.sql;
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
    if (statement) statements.push(statement);
    rest = rest.slice(boundary + 1).trim();
  }
  return statements;
}

async function seed(sql: Sql, id: string, withTransfer: boolean): Promise<void> {
  await sql.run(
    `INSERT INTO tf_v2_resources
     (uid,principal,form_url,space,name,backend_id,target_key,active_name,
      generation,phase,spec_json,last_operation,busy_operation)
     VALUES (?,'org:one','https://forms.example.test/SecretFixture/1.0.0/',
       'prod',?,'backend-one','target-one',?,1,'pending','{}',?,?)`,
    [`resource-${id}`, id, id, id, id],
  );
  await sql.run(
    `INSERT INTO tf_v2_operations
     (id,resource_uid,principal,replay_key,request_fingerprint,action,
      generation,status,effect,created_at,updated_at,retain_until,backend_id,
      target_key,backend_key,accepted_spec_json,private_inputs_present)
     VALUES (?,?,'org:one',?,'fingerprint','create',1,'queued','none',
       ?,?,?,'backend-one','target-one',?,'{}',?)`,
    [
      id,
      `resource-${id}`,
      `replay-${id}`,
      createdAt,
      createdAt,
      retainUntil,
      id,
      withTransfer ? 1 : 0,
    ],
  );
  if (withTransfer) {
    await sql.run(
      `INSERT INTO tf_v2_private_inputs
       (operation_id,names_json,comparison_key_id,comparison_tag,transfer_key_id,
        transfer_nonce,transfer_ciphertext,transfer_expires_at_ms)
       VALUES (?,'["password"]','comparison-key','comparison-tag','transfer-key',
         'nonce','sealed-ciphertext',2000000000000)`,
      [id],
    );
  }
}

async function exercise(sql: Sql): Promise<void> {
  const store = createV2Store(sql);
  await seed(sql, "send", true);
  expect(await store.claim("send", token, 0, 1_000)).toBe(true);
  expect(await store.markDispatch("send", "wrong-token", createdAt)).toBe(false);
  expect((await store.privateInputs("send"))?.transfer_ciphertext).toBe("sealed-ciphertext");
  expect(await store.markDispatch("send", token, createdAt)).toBe(true);
  expect(await store.markDispatch("send", token, createdAt)).toBe(false);
  expect(await store.operation("send")).toMatchObject({
    status: "reconciling",
    effect: "unknown",
    dispatch_possible: 1,
  });
  expect(await store.privateInputs("send")).toMatchObject({
    transfer_key_id: null,
    transfer_nonce: null,
    transfer_ciphertext: null,
    transfer_expires_at_ms: null,
  });
  expect(
    await store.settle({
      id: "send",
      token,
      status: "succeeded",
      effect: "complete",
      at: createdAt,
      retainUntil,
      observedJson: '{"ready":true}',
      outputJson: "{}",
    }),
  ).toBe(true);
  expect(
    await store.settle({
      id: "send",
      token,
      status: "succeeded",
      effect: "complete",
      at: createdAt,
      retainUntil,
    }),
  ).toBe(false);
  expect(await store.resource("resource-send")).toMatchObject({
    phase: "idle",
    observed_generation: 1,
    busy_operation: null,
  });

  await seed(sql, "wait", true);
  expect(await store.claim("wait", token, 0, 1_000)).toBe(true);
  expect(
    await store.waitForInputs("wait", "wrong-token", createdAt, '["password"]', "expired"),
  ).toBe(false);
  expect(await store.waitForInputs("wait", token, createdAt, '["password"]', "expired")).toBe(true);
  expect(await store.waitForInputs("wait", token, createdAt, '["password"]', "expired")).toBe(
    false,
  );
  expect(await store.operation("wait")).toMatchObject({
    status: "waiting_input",
    dispatch_possible: 0,
    lease_token: null,
  });
  expect((await store.privateInputs("wait"))?.transfer_ciphertext).toBeNull();

  await seed(sql, "unverifiable", true);
  expect(await store.claim("unverifiable", token, 0, 1_000)).toBe(true);
  expect(await store.failUnverifiable("unverifiable", "wrong-token", createdAt, retainUntil)).toBe(
    false,
  );
  expect(await store.failUnverifiable("unverifiable", token, createdAt, retainUntil)).toBe(true);
  expect(await store.operation("unverifiable")).toMatchObject({
    status: "failed",
    effect: "none",
    error_code: "private_inputs_unverifiable",
  });

  await seed(sql, "no-transfer", false);
  expect(await store.claim("no-transfer", token, 0, 1_000)).toBe(true);
  expect(await store.markDispatch("no-transfer", token, createdAt)).toBe(true);
  expect(await store.privateInputs("no-transfer")).toBeNull();
}

test("Bun SQLite private-input store transitions retain exact claim semantics", async () => {
  const database = new Database(":memory:");
  try {
    database.exec(migration("0070_takoform_v2.sql"));
    database.exec(migration("0081_v2_private_inputs.sql"));
    await exercise(createSqliteSql(database));
  } finally {
    database.close();
  }
});

test("native D1 private-input store transitions report their top-level operation", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "v2-private-input-store-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "v2-private-input-store-d1-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    for (const name of ["0070_takoform_v2.sql", "0081_v2_private_inputs.sql"]) {
      for (const statement of splitMigration(migration(name)))
        await database.prepare(statement).run();
    }
    await exercise(createD1Sql(database));
  } finally {
    await runtime.dispose();
  }
});
