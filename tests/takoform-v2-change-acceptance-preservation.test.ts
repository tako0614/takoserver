import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql, SqlParam, SqlStatement } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { type AcceptRecord, createV2Store } from "../src/takoform-v2/store.ts";
import type { V2AdmissionPredicate } from "../src/takoform-v2/types.ts";

const FORM = "https://forms.example.test/ChangeBytes/1.0.0/";
const AT = "2026-10-15T00:00:00.000Z";
const CONFIGURED = { keyId: "configured-key", nonce: "nonce", ciphertext: "ciphertext" };
const PRIVATE = {
  namesJson: '["password"]',
  comparisonKeyId: "comparison-key",
  comparisonTag: "tag",
  transferKeyId: "transfer-key",
  transferNonce: "transfer-nonce",
  transferCiphertext: "transfer-ciphertext",
  transferExpiresAtMs: Date.parse(AT) + 60_000,
};

function typedParameter(param: SqlParam) {
  if (param === null) return ["null"];
  if (typeof param === "string") return ["string", param];
  if (typeof param === "number") return ["number", Object.is(param, -0) ? "-0" : String(param)];
  return ["ArrayBuffer", Buffer.from(param).toString("hex")];
}

function statementBytes(statements: readonly SqlStatement[]): string {
  return JSON.stringify(
    statements.map((statement) => ({
      sql: statement.sql,
      params: statement.params === undefined ? ["absent"] : statement.params.map(typedParameter),
    })),
  );
}

function record(label: string, action: "create" | "update" | "delete"): AcceptRecord {
  return {
    id: `operation-${label}`,
    resourceUid: "owned-resource",
    principal: "owner",
    key: `replay-${label}`,
    fingerprint: `fingerprint-${label}`,
    action,
    generation: action === "create" ? 1 : 2,
    at: AT,
    retainUntil: "2026-10-16T00:00:00.000Z",
    backendId: "change-fixture",
    targetKey: "same-sqlite",
    specJson: '{"value":"new"}',
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

const CASES: readonly {
  readonly name: string;
  readonly action?: "delete";
  readonly private?: boolean;
  readonly configured?: boolean;
  readonly references?: string;
  readonly serialize?: boolean;
  readonly admission?: () => V2AdmissionPredicate;
  readonly outcome?: "dependency_conflict" | "resource_busy";
}[] = [
  { name: "update-plain" },
  { name: "update-binary", admission: binaryAdmission },
  {
    name: "update-refused",
    admission: () => ({ sql: "0", params: [] }),
    outcome: "dependency_conflict",
  },
  {
    name: "update-busy",
    admission: () => ({ sql: "0", params: [], conflictCode: "resource_busy" }),
    outcome: "resource_busy",
  },
  { name: "update-references", references: "[]" },
  { name: "update-private", private: true },
  { name: "update-configured", private: true, configured: true },
  { name: "update-serialized", serialize: true },
  {
    name: "update-all",
    private: true,
    configured: true,
    references: "[]",
    serialize: true,
    admission: binaryAdmission,
  },
  { name: "delete-plain", action: "delete" },
  { name: "delete-admission", action: "delete", admission: binaryAdmission },
];

async function captureChanges() {
  const captured: Record<string, { bytes: string; sha256: string; outcome: string }> = {};
  for (const scenario of CASES) {
    const db = new Database(":memory:");
    migrateSqlite(db);
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
    const store = createV2Store(sql);
    try {
      await store.insertCreate(
        {
          ...record("seed", "create"),
          privateInputs: PRIVATE,
          configuredPrivateInputs: CONFIGURED,
        },
        { form: FORM, space: "space", name: "owned-name" },
      );
      await raw.run("UPDATE tf_v2_resources SET busy_operation = NULL, phase = 'idle'");
      batches.length = 0;
      const input: AcceptRecord = {
        ...record(scenario.name, scenario.action ?? "update"),
        ...(scenario.private ? { privateInputs: PRIVATE } : {}),
        ...(scenario.configured ? { expectedConfiguredPrivateInputs: CONFIGURED } : {}),
      };
      const outcome = await store.insertChange(
        input,
        scenario.references ?? null,
        scenario.serialize ?? false,
        scenario.admission?.(),
      );
      if (batches.length !== 1 || outcome !== (scenario.outcome ?? "accepted"))
        throw new Error(`invalid real Store golden fixture: ${scenario.name}/${outcome}`);
      const bytes = batches[0] ?? "";
      captured[scenario.name] = {
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        outcome,
      };
    } finally {
      db.close();
    }
  }
  return captured;
}

// Captured by executing genuine447a2375cf346a03665ee8496a4cfc67a9254b5f Store.
// Source SHA256 dc2f345a8ad93165f155e76eb180cdbfe9526be45c9679cfd16cf1abd55bafe4.
// Whole SQL strings + typed parameter bytes, without normalization; not Engine-retained proof.
const EXPECTED: Readonly<Record<string, string>> = {
  "update-plain": "783be8ec6bfd6467575ec7106d37a628afb581878dd88891b31742a56b0cf9ff",
  "update-binary": "41f4fb1485d4e07b32cb98b8ea611f13fba37a6353e675c0dd884cbf66d191c1",
  "update-refused": "9e036926774c141db374fe30f3b4740c9af48293fe174e4df15a71b4e1ce4216",
  "update-busy": "60baec0a08d8ece2f95fbf80b8b014e3280486b0730b9ca29133dbb52362441e",
  "update-references": "c773fd23341170bb65d1838476714f84db7ce7eb3a2465445ae8fccba7f21405",
  "update-private": "065da49ba8953dd05cbbd1cc668bebb4a327befc8ae383a5c441e691e54ca987",
  "update-configured": "1ff0be6ea681dc1f9229332851d7fc9c872ed63ab37c29ca3d7c6456193ee835",
  "update-serialized": "954e0a260cc14e286dfbd1d0d401d6403c4fff77bbc3579e71c1806b38ee5c0e",
  "update-all": "c202a4f6c8465212758f82d2d4270d414ac16a9a9eecd548a5998a404f16559a",
  "delete-plain": "d4b0878b11d21b59524f4a965bfbac7e078b05119f20cd392e0a820775085199",
  "delete-admission": "84c1073fac7b963f4e651dbe4fdd14579e4652cef1c387e42910c991d7cc8377",
};

test("preserves complete default UPDATE and DELETE Store SQL and typed parameter bytes", async () => {
  const captured = await captureChanges();
  expect(Object.keys(captured)).toEqual(Object.keys(EXPECTED));
  for (const [name, value] of Object.entries(captured)) {
    const expected = EXPECTED[name];
    if (!expected) throw new Error(`missing actual447 change baseline: ${name}`);
    expect(value.sha256).toBe(expected);
  }
});
