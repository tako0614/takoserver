import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { type Sql, SqlError, type SqlParam, type SqlStatement } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { type AcceptRecord, createV2Store } from "../src/takoform-v2/store.ts";
import type { V2AdmissionPredicate, V2Form } from "../src/takoform-v2/types.ts";

const FORM = "https://forms.example.test/Acceptance/1.0.0/";
const TARGET = "00000000-0000-4000-8000-000000000001";
const AT = "2026-10-15T00:00:00.000Z";
// Captured from unmodified 84da0fd345b74fc2253dd37f5b25e3f0dcb6cb85 Store + SQLite.
// Store SHA256: f5a8ca15d7a47acb159b51741046ccd62fe6382358d2395c659810c6471c140a.
// Hashes cover complete SQL strings and typed parameter bytes, with no normalization.

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parameter(param: SqlParam) {
  if (param === null) return ["null"];
  if (typeof param === "string") return ["string", param];
  if (typeof param === "number") return ["number", Object.is(param, -0) ? "-0" : String(param)];
  return ["ArrayBuffer", Buffer.from(param).toString("hex")];
}

function statementBytes(statements: readonly SqlStatement[]): string {
  return JSON.stringify(
    statements.map((statement) => ({
      sql: statement.sql,
      params: statement.params === undefined ? ["absent"] : statement.params.map(parameter),
    })),
  );
}

function record(label: string): AcceptRecord {
  return {
    id: `operation-${label}`,
    resourceUid: `resource-${label}`,
    principal: "owner",
    key: `replay-${label}`,
    fingerprint: `fingerprint-${label}`,
    action: "create",
    generation: 1,
    at: AT,
    retainUntil: "2026-10-16T00:00:00.000Z",
    backendId: "acceptance-fixture",
    targetKey: "sqlite-fixture",
    specJson: '{"value":"original"}',
  };
}

function fixture() {
  const db = new Database(":memory:");
  migrateSqlite(db);
  db.query(`INSERT INTO tf_v2_resources
    (uid,principal,form_url,space,name,backend_id,target_key,active_name,generation,
     observed_generation,observed_at,phase,spec_json,observed_json,output_json,
     last_operation,busy_operation)
    VALUES (?,?,?,?,?,?,?,?,1,1,?,'idle','{}','{"ready":true}','{}',?,NULL)`).run(
    TARGET,
    "owner",
    FORM,
    "space",
    "target",
    "acceptance-fixture",
    "sqlite-fixture",
    "target",
    AT,
    "seed-operation",
  );
  const raw = createSqliteSql(db);
  const batches: string[] = [];
  const sql: Sql = {
    query: raw.query,
    run: raw.run,
    async batch(statements) {
      batches.push(statementBytes(statements));
      return raw.batch(statements);
    },
  };
  return { db, sql, batches, store: createV2Store(sql) };
}

function privateRecord(base: AcceptRecord, configured = false): AcceptRecord {
  return {
    ...base,
    privateInputs: {
      namesJson: '["password"]',
      comparisonKeyId: "comparison-key",
      comparisonTag: "comparison-tag",
      transferKeyId: "transfer-key",
      transferNonce: "transfer-nonce",
      transferCiphertext: "transfer-ciphertext",
      transferExpiresAtMs: Date.parse(AT) + 60_000,
    },
    ...(configured
      ? {
          configuredPrivateInputs: {
            keyId: "configured-key",
            nonce: "configured-nonce",
            ciphertext: "configured-ciphertext",
          },
        }
      : {}),
  };
}

function binaryAdmission(): V2AdmissionPredicate {
  return {
    sql: "? = ? AND ? IS NULL AND ? = ?",
    params: [
      1,
      1,
      null,
      new Uint8Array([0, 127, 255]).buffer,
      new Uint8Array([0, 127, 255]).buffer,
    ],
  };
}

const REFERENCES = JSON.stringify([{ resourceUid: TARGET, formUrl: FORM, readiness: "ready" }]);
const CASES: readonly {
  name: string;
  private?: boolean;
  configured?: boolean;
  references?: string;
  output?: string;
  admission?: () => V2AdmissionPredicate;
  outcome?: "dependency_conflict" | "resource_busy";
}[] = [
  { name: "plain" },
  { name: "output", output: '{"hostname":"owned.example.invalid","message":"雪"}' },
  { name: "admission", admission: () => ({ sql: "1 = 1", params: [] }) },
  { name: "binary-admission", admission: binaryAdmission },
  { name: "refused", admission: () => ({ sql: "0", params: [] }), outcome: "dependency_conflict" },
  {
    name: "busy",
    admission: () => ({ sql: "0", params: [], conflictCode: "resource_busy" }),
    outcome: "resource_busy",
  },
  { name: "references-empty", references: "[]" },
  { name: "references-target", references: REFERENCES },
  { name: "private", private: true },
  { name: "configured", private: true, configured: true },
  {
    name: "all",
    private: true,
    configured: true,
    references: REFERENCES,
    admission: binaryAdmission,
    output: '{"url":"https://owned.example.invalid/"}',
  },
];

const EXPECTED: Readonly<Record<string, string>> = {
  plain: "fa0626f5a35f76982e2939c902dfcfb1b530f42f0d3e66d6ab4e29a2cf171226",
  output: "0fe7c9a393126b83ee8e05cd44486928ee74360914b8411e003d4ebe27f86584",
  admission: "71cdea2328bfe9df7758334c4750955725f6d99f1cae4401eb3a59be66da62ca",
  "binary-admission": "cc4b8e04b5089874ce6035835caf4e8bc8653af9a2b522ee07c888cf8514e53f",
  refused: "e6e112910be5a84e9fbd6f9f2961163043931c0e111d1bfdaee297da3e1b2cd3",
  busy: "68ff4abc78c4b475ad13f2f41a9b4aba9db76110294b561896f54ca668d75be5",
  "references-empty": "748b5b434cdc6a4871d5bfc4b85d42a4318fe7e119925d998adff9add9251aff",
  "references-target": "c4deb2c40709fdbe057dd44e485e5f51ea111d9090d8d8458cdf2303ecfca2a4",
  private: "54ac48dd9f4ea312c5c80998e639dbec7c536f1e52572c3afd1b6d6a2ee82ae5",
  configured: "efbfee775f1b14279908908d12b58b054e6873c6fec5ffc3652f6c939e26bba5",
  all: "17683e4ffe1ed23fb678cd7d056a827c913f5f9dda4669093b50e77bc3230035",
};

test("preserves exact owning Store CREATE statements and typed parameter bytes", async () => {
  const captured: Record<string, { bytes: string; sha256: string; outcome: string }> = {};
  for (const scenario of CASES) {
    const f = fixture();
    try {
      const input = scenario.private
        ? privateRecord(record(scenario.name), scenario.configured)
        : record(scenario.name);
      const outcome = await f.store.insertCreate(
        input,
        { form: FORM, space: "space", name: scenario.name },
        scenario.references ?? null,
        scenario.output ?? "{}",
        scenario.admission?.(),
      );
      expect(outcome).toBe(scenario.outcome ?? "accepted");
      expect(f.batches).toHaveLength(1);
      const bytes = f.batches[0] ?? "";
      captured[scenario.name] = { bytes, sha256: digest(bytes), outcome };
      const count = f.db
        .query("SELECT count(*) AS n FROM tf_v2_operations WHERE id = ?")
        .get(input.id) as { n: number };
      expect(count.n).toBe(scenario.outcome ? 0 : 1);
    } finally {
      f.db.close();
    }
  }
  expect(Object.keys(captured)).toEqual(Object.keys(EXPECTED));
  for (const [name, value] of Object.entries(captured)) {
    const expected = EXPECTED[name];
    if (expected === undefined) throw new Error(`Missing CREATE baseline: ${name}`);
    expect(value.sha256).toBe(expected);
  }
});

function heldFixture() {
  const f = fixture();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sql: Sql = {
    query: f.sql.query,
    run: f.sql.run,
    async batch(statements) {
      enter();
      await released;
      return f.sql.batch(statements);
    },
  };
  return { ...f, entered, release, store: createV2Store(sql) };
}

test("owns admission ArrayBuffer bytes before its first awaited Sql.batch", async () => {
  const f = heldFixture();
  const admission = binaryAdmission();
  try {
    const pending = f.store.insertCreate(
      record("buffer-owned"),
      { form: FORM, space: "space", name: "buffer-owned" },
      null,
      "{}",
      admission,
    );
    await f.entered;
    new Uint8Array(admission.params[3] as ArrayBuffer)[0] = 99;
    f.release();
    expect(await pending).toBe("accepted");
    expect(
      f.db.query("SELECT uid FROM tf_v2_resources WHERE uid = ?").get("resource-buffer-owned"),
    ).toEqual({ uid: "resource-buffer-owned" });
    expect(
      f.db.query("SELECT id FROM tf_v2_operations WHERE id = ?").get("operation-buffer-owned"),
    ).toEqual({ id: "operation-buffer-owned" });
  } finally {
    f.release();
    f.db.close();
  }
});

test("owns admission refusal classification before its first awaited Sql.batch", async () => {
  const f = heldFixture();
  const admission = {
    sql: "0",
    params: [] as SqlParam[],
    conflictCode: "resource_busy" as "resource_busy" | "dependency_conflict",
  };
  try {
    const pending = f.store.insertCreate(
      record("classification-owned"),
      { form: FORM, space: "space", name: "classification-owned" },
      null,
      "{}",
      admission,
    );
    await f.entered;
    admission.conflictCode = "dependency_conflict";
    f.release();
    expect(await pending).toBe("resource_busy");
    expect(
      f.db
        .query("SELECT id FROM tf_v2_operations WHERE replay_key = ?")
        .all("replay-classification-owned"),
    ).toEqual([]);
  } finally {
    f.release();
    f.db.close();
  }
});

test("preserves record Resource and custody across an awaited batch", async () => {
  const f = heldFixture();
  const prepared = privateRecord(record("aliases"), true);
  if (!prepared.privateInputs || !prepared.configuredPrivateInputs) {
    throw new Error("incomplete custody fixture");
  }
  const privateInputs = { ...prepared.privateInputs };
  const configuredPrivateInputs = { ...prepared.configuredPrivateInputs };
  const input = { ...prepared, privateInputs, configuredPrivateInputs };
  const resource = { form: FORM, space: "space", name: "aliases" };
  try {
    const pending = f.store.insertCreate(
      input,
      resource,
      REFERENCES,
      '{"hostname":"original.example.invalid"}',
    );
    await f.entered;
    input.id = "changed-operation";
    input.resourceUid = "changed-resource";
    input.principal = "changed-owner";
    input.key = "changed-replay";
    input.fingerprint = "changed-fingerprint";
    input.specJson = '{"value":"changed"}';
    input.backendId = "changed-backend";
    input.targetKey = "changed-target";
    input.generation = 9;
    resource.form = "https://forms.example.test/Changed/1.0.0/";
    resource.space = "changed-space";
    resource.name = "changed-name";
    privateInputs.namesJson = '["changed"]';
    privateInputs.comparisonTag = "changed-tag";
    privateInputs.transferCiphertext = "changed-transfer";
    configuredPrivateInputs.ciphertext = "changed-configured";
    f.release();
    expect(await pending).toBe("accepted");
    expect(
      f.db
        .query(`SELECT uid,principal,form_url,space,name,generation,
      spec_json,output_json,last_operation FROM tf_v2_resources WHERE uid = ?`)
        .get("resource-aliases"),
    ).toEqual({
      uid: "resource-aliases",
      principal: "owner",
      form_url: FORM,
      space: "space",
      name: "aliases",
      generation: 1,
      spec_json: '{"value":"original"}',
      output_json: '{"hostname":"original.example.invalid"}',
      last_operation: "operation-aliases",
    });
    expect(
      f.db
        .query(`SELECT names_json,comparison_tag,transfer_ciphertext
      FROM tf_v2_private_inputs WHERE operation_id = ?`)
        .get("operation-aliases"),
    ).toEqual({
      names_json: '["password"]',
      comparison_tag: "comparison-tag",
      transfer_ciphertext: "transfer-ciphertext",
    });
    expect(
      f.db
        .query(`SELECT ciphertext FROM tf_v2_configured_private_inputs
      WHERE resource_uid = ?`)
        .get("resource-aliases"),
    ).toEqual({
      ciphertext: "configured-ciphertext",
    });
    expect(
      f.db
        .query(`SELECT target_uid FROM tf_v2_operation_references
      WHERE operation_id = ?`)
        .all("operation-aliases"),
    ).toEqual([{ target_uid: TARGET }]);
  } finally {
    f.release();
    f.db.close();
  }
});

test("existing replay UNIQUE rolls back the preceding fresh Resource", async () => {
  const f = fixture();
  try {
    const first = record("unique-first");
    expect(
      await f.store.insertCreate(first, { form: FORM, space: "space", name: "unique-first" }),
    ).toBe("accepted");
    const second = privateRecord({ ...record("unique-second"), key: first.key }, true);
    await expect(
      f.store.insertCreate(
        second,
        { form: FORM, space: "space", name: "unique-second" },
        REFERENCES,
      ),
    ).rejects.toBeInstanceOf(SqlError);
    expect(
      f.db.query("SELECT uid FROM tf_v2_resources WHERE uid = ?").all(second.resourceUid),
    ).toEqual([]);
    expect(
      f.db
        .query(`SELECT id FROM tf_v2_operations
      WHERE principal = ? AND replay_key = ?`)
        .all("owner", first.key),
    ).toEqual([{ id: first.id }]);
    expect(f.db.query("SELECT operation_id FROM tf_v2_private_inputs").all()).toEqual([]);
    expect(f.db.query("SELECT resource_uid FROM tf_v2_configured_private_inputs").all()).toEqual(
      [],
    );
    expect(f.db.query("SELECT operation_id FROM tf_v2_operation_reference_sets").all()).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("real 0073 reference trigger rolls back acceptance and custody without new DDL", async () => {
  const f = fixture();
  const input = privateRecord(record("bad-reference"), true);
  const references = JSON.stringify([
    { resourceUid: "missing-target", formUrl: FORM, readiness: "ready" },
  ]);
  try {
    await expect(
      f.store.insertCreate(
        input,
        { form: FORM, space: "space", name: "bad-reference" },
        references,
      ),
    ).rejects.toThrow("tf_v2_reference_target_unavailable");
    expect(
      f.db.query("SELECT uid FROM tf_v2_resources WHERE uid = ?").all(input.resourceUid),
    ).toEqual([]);
    expect(
      f.db
        .query(`SELECT id FROM tf_v2_operations
      WHERE principal = ? AND replay_key = ?`)
        .all("owner", input.key),
    ).toEqual([]);
    for (const table of [
      "tf_v2_private_inputs",
      "tf_v2_configured_private_inputs",
      "tf_v2_operation_reference_sets",
      "tf_v2_operation_references",
      "tf_v2_resource_references",
    ]) {
      expect(f.db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  } finally {
    f.db.close();
  }
});

test("core keeps its constructed Sql for lost-ACK readback and retained replay", async () => {
  const f = fixture();
  let loseAck = true;
  let batches = 0;
  let reads = 0;
  let assignments = 0;
  const sql: Sql = {
    async query(query, params) {
      reads++;
      return f.sql.query(query, params);
    },
    run: f.sql.run,
    async batch(statements) {
      batches++;
      const result = await f.sql.batch(statements);
      if (loseAck) {
        loseAck = false;
        throw new SqlError("unavailable", "fixture committed ACK lost");
      }
      return result;
    },
  };
  const form: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    initialOutput() {
      assignments++;
      return { hostname: "same-assignment.example.invalid" };
    },
    backend: {
      id: "engine-fixture",
      targetKey: "same-sql",
      async execute() {
        return { kind: "unknown" };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    },
  };
  const options = {
    sql,
    now: () => new Date(AT),
    replayWindowSeconds: 3600,
    authorize: async (principal: string, space: string) =>
      principal === "owner" && space === "space",
  };
  const request = {
    principal: "owner",
    key: "lost-ack-preservation-key-0001",
    input: {
      form: FORM,
      space: "space",
      name: "engine-owned",
      spec: { value: "original" },
    },
  };
  try {
    const engineOptions = { ...options, forms: { [FORM]: form } };
    const engine = createTakoformV2Engine(engineOptions);
    let foreignCalls = 0;
    const foreignCall = async (): Promise<never> => {
      foreignCalls++;
      throw new Error("changed construction Sql must not be used");
    };
    engineOptions.sql = { query: foreignCall, run: foreignCall, batch: foreignCall };
    const accepted = await engine.acceptCreate(request);
    expect(accepted.status).toBe("queued");
    expect(reads).toBeGreaterThan(0);
    expect(batches).toBe(1);
    expect(assignments).toBe(1);
    expect((await engine.acceptCreate(request)).id).toBe(accepted.id);
    const retained = createTakoformV2Engine({
      ...options,
      forms: {},
      retainedForms: { [FORM]: form },
    });
    expect((await retained.acceptCreate(request)).resourceUid).toBe(accepted.resourceUid);
    await expect(
      retained.acceptCreate({
        ...request,
        key: "new-retained-preservation-key",
        input: { ...request.input, name: "unsupported" },
      }),
    ).rejects.toMatchObject({ code: "unsupported_form" });
    expect(batches).toBe(1);
    expect(assignments).toBe(1);
    expect(foreignCalls).toBe(0);
    expect(
      f.db
        .query(`SELECT id,resource_uid FROM tf_v2_operations
      WHERE replay_key = ?`)
        .get(request.key),
    ).toEqual({
      id: accepted.id,
      resource_uid: accepted.resourceUid,
    });
    expect(
      (await retained.getResource({ principal: "owner", uid: accepted.resourceUid })).output,
    ).toEqual({ hostname: "same-assignment.example.invalid" });
  } finally {
    f.db.close();
  }
});
