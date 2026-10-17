import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { RpAuthorityRecord } from "../src/credential-authority-class.ts";
import { canonicalJson } from "../src/json.ts";
import type { Row, Sql, SqlStatement, SqlWrite } from "../src/ports.ts";
import { sharedAuthFinancialConsentLeafStatements } from "../src/shared-auth-financial-consent-schema-plan.ts";
import {
  createSharedAuthFinancialConsentOriginalReader,
  requireSharedAuthFinancialConsentCommandCapturePostimage,
  type SharedAuthFinancialConsentCaptureData,
  type SharedAuthFinancialConsentGuardedStatementData,
  type SharedAuthFinancialConsentOriginalCommand,
  SharedAuthFinancialConsentOriginalReadError,
  type SharedAuthFinancialConsentPendingData,
  sharedAuthFinancialConsentCommandCaptureStatement,
} from "../src/shared-auth-financial-consent-store.ts";
import { createSharedFinancialActionIdentity } from "../src/shared-financial-action.ts";
import type { SharedPrincipalBinding } from "../src/shared-principal-authority.ts";
import { syntheticV4Original } from "./consent-v4-fixture.ts";

const P = "shared_auth_financial_consent_pending";
const C = "shared_auth_financial_consent_commands";
const O = "shared_auth_financial_consent_originals";
const roots = [
  "principals",
  "auth_principal_incarnations",
  "shared_principal_bindings",
  "credential_authority_classes",
  "shared_auth_sessions",
  "unrelated_kept",
];
const opened = new Set<Database>();
afterEach(() => {
  for (const db of opened) db.close();
  opened.clear();
});
type Bind = string | number | Uint8Array | null;
// These arrays are constructed by this fixture, never shared backing storage.
type OwnedFixtureCommand = SharedAuthFinancialConsentOriginalCommand & {
  readonly commandBytes: Uint8Array<ArrayBuffer>;
  readonly originalBytes: Uint8Array<ArrayBuffer>;
};
const bytes = (value: string) => new TextEncoder().encode(value);
const digest = (value: string) => `sha256:${value.repeat(64)}` as const;
async function custodyHash(value: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(value)));
  return `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
function insert(db: Database, table: string, value: object): void {
  const names = Object.keys(value);
  db.query(
    `INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
  ).run(...(Object.values(value) as Bind[]));
}
function binds(statement: SqlStatement): Bind[] {
  return (statement.params ?? []).map((value) =>
    value instanceof ArrayBuffer ? new Uint8Array(value) : value,
  );
}
function write(db: Database, statement: SqlStatement): SqlWrite {
  const rows = db.query(statement.sql).all(...binds(statement)) as Row[];
  const count = db.query("SELECT changes() AS n").get() as { n: number };
  return { rows, changes: count.n };
}
const rows = (db: Database, table: string) =>
  db.query(`SELECT * FROM ${table} ORDER BY rowid`).all();
function snapshot(db: Database) {
  return {
    root: roots.map((table) => rows(db, table)),
    pending: rows(db, P),
    commands: rows(db, C),
    originals: rows(db, O),
    schema: db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
  };
}

/** Reduced SYNTHETIC anchors for the fixed Root mechanical expressions, not
 * full103, registered source, a genuine Root factory/human/Clock/current
 * admission, coherent Financial R1 reader or native D1. Date.now below only
 * makes this future local fixture coexist with Root's fixed SQL execution
 * clock. It is not an injectable production authority or Clock qualification.
 */
async function fixture(options: { wrongBindingUnique?: boolean; seedPending?: boolean } = {}) {
  const db = new Database(":memory:");
  opened.add(db);
  db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE principals(id TEXT PRIMARY KEY NOT NULL,provider TEXT NOT NULL,provider_subject TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE auth_principal_incarnations (
 principal_id TEXT NOT NULL,principal_incarnation TEXT NOT NULL,state TEXT NOT NULL,identity_kind TEXT NOT NULL,
 identity_subject TEXT NOT NULL,principal_created_at TEXT NOT NULL,origin_kind TEXT NOT NULL,
 identity_authority_body TEXT,identity_authority_digest TEXT,PRIMARY KEY(principal_id,principal_incarnation));
CREATE TABLE shared_principal_bindings (
 binding_ref TEXT PRIMARY KEY NOT NULL,principal_id TEXT NOT NULL,principal_incarnation TEXT NOT NULL,state TEXT NOT NULL,
 issuer TEXT NOT NULL,subject TEXT NOT NULL,controller_incarnation TEXT NOT NULL,target_ref TEXT NOT NULL,
 evidence_ref TEXT NOT NULL,evidence_digest TEXT NOT NULL,binding_kind TEXT NOT NULL,
 ${options.wrongBindingUnique ? "" : "UNIQUE(binding_ref,principal_id,principal_incarnation),"}
 FOREIGN KEY(principal_id,principal_incarnation) REFERENCES auth_principal_incarnations(principal_id,principal_incarnation) ON DELETE RESTRICT);
CREATE TABLE credential_authority_classes (
 authority_ref TEXT PRIMARY KEY NOT NULL,credential_incarnation TEXT NOT NULL UNIQUE,principal_id TEXT NOT NULL,
 principal_incarnation TEXT NOT NULL,principal_binding_ref TEXT NOT NULL,target_ref TEXT NOT NULL,backend TEXT NOT NULL,
 class TEXT NOT NULL,organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,workspace_ref TEXT NOT NULL,state TEXT NOT NULL,
 issuance_ref TEXT NOT NULL,issuance_digest TEXT NOT NULL,rp_registration_ref TEXT NOT NULL,rp_registration_digest TEXT NOT NULL,
 session_digest TEXT NOT NULL,session_created_at INTEGER NOT NULL,session_enrolled_version INTEGER NOT NULL,
 issuer TEXT NOT NULL,client_id TEXT NOT NULL,subject TEXT NOT NULL,issuer_session_id TEXT NOT NULL,auth_time INTEGER NOT NULL,account_id TEXT NOT NULL);
CREATE TABLE shared_auth_sessions (
 digest TEXT PRIMARY KEY NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,
 account_id TEXT NOT NULL,principal_id TEXT NOT NULL,workspace_id TEXT NOT NULL,absolute_expires_at INTEGER NOT NULL,
 last_used_at INTEGER NOT NULL,grant_checked_at INTEGER NOT NULL);
CREATE TABLE unrelated_kept(id TEXT PRIMARY KEY NOT NULL,value BLOB NOT NULL);
INSERT INTO unrelated_kept VALUES('keep',X'000102ff');`);
  const at = Date.now() - 2_000;
  const created = new Date(at - 10_000).toISOString();
  const human: SharedPrincipalBinding = {
    ref: "human_binding",
    issuer: "https://auth.example.test",
    subject: "account_original",
    controllerIncarnation: "controller_incarnation",
    principalId: "principal",
    principalIncarnation: "principal_incarnation",
    targetRef: "auth_target",
    kind: "fresh-shared",
    evidence: { ref: "human_evidence", digest: digest("c") },
    previousRef: null,
    enrolledAt: created,
    state: "active",
    terminal: null,
  };
  const credential: RpAuthorityRecord = {
    state: "active",
    terminal: null,
    class: "official-shared-rp-session",
    backend: "shared-rp-session",
    organizationId: "retained_org_A",
    origin: {
      ref: "authority",
      incarnation: "credential_incarnation",
      targetRef: "auth_target",
      principalId: "principal",
      principalIncarnation: "principal_incarnation",
      issuanceRef: "issuance_original",
      issuanceDigest: digest("d"),
      issuedAt: created,
    },
    rp: {
      principalBindingRef: human.ref,
      registrationRef: "rp_registration",
      registrationDigest: digest("e"),
      sessionDigest: digest("f"),
      sessionCreatedAt: at - 5_000,
      enrolledSessionVersion: 3,
      issuer: human.issuer,
      clientId: "actual_pinned_client",
      subject: human.subject,
      issuerSessionId: "issuer_session",
      authTime: at - 8_000,
      accountId: human.subject,
      workspaceId: "row_workspace_A",
      workspaceRef: "row_ref_A",
    },
  };
  const currentSession = { version: 7, absoluteExpiresAt: at + 600_000, lastUsedAt: at - 100 };
  insert(db, "principals", {
    id: human.principalId,
    provider: "shared-account",
    provider_subject: human.subject,
    created_at: created,
  });
  insert(db, "auth_principal_incarnations", {
    principal_id: human.principalId,
    principal_incarnation: human.principalIncarnation,
    state: "active",
    identity_kind: "shared-account",
    identity_subject: human.subject,
    principal_created_at: created,
    origin_kind: human.kind,
    identity_authority_body: null,
    identity_authority_digest: null,
  });
  insert(db, "shared_principal_bindings", {
    binding_ref: human.ref,
    principal_id: human.principalId,
    principal_incarnation: human.principalIncarnation,
    state: "active",
    issuer: human.issuer,
    subject: human.subject,
    controller_incarnation: human.controllerIncarnation,
    target_ref: human.targetRef,
    evidence_ref: human.evidence.ref,
    evidence_digest: human.evidence.digest,
    binding_kind: human.kind,
  });
  const r = credential.rp;
  insert(db, "credential_authority_classes", {
    authority_ref: credential.origin.ref,
    credential_incarnation: credential.origin.incarnation,
    principal_id: human.principalId,
    principal_incarnation: human.principalIncarnation,
    principal_binding_ref: human.ref,
    target_ref: human.targetRef,
    backend: credential.backend,
    class: credential.class,
    organization_id: credential.organizationId,
    workspace_id: r.workspaceId,
    workspace_ref: r.workspaceRef,
    state: "active",
    issuance_ref: credential.origin.issuanceRef,
    issuance_digest: credential.origin.issuanceDigest,
    rp_registration_ref: r.registrationRef,
    rp_registration_digest: r.registrationDigest,
    session_digest: r.sessionDigest,
    session_created_at: r.sessionCreatedAt,
    session_enrolled_version: r.enrolledSessionVersion,
    issuer: r.issuer,
    client_id: r.clientId,
    subject: r.subject,
    issuer_session_id: r.issuerSessionId,
    auth_time: r.authTime,
    account_id: r.accountId,
  });
  insert(db, "shared_auth_sessions", {
    digest: r.sessionDigest,
    created_at: r.sessionCreatedAt,
    status: "active",
    version: currentSession.version,
    account_id: r.accountId,
    principal_id: human.principalId,
    workspace_id: r.workspaceId,
    absolute_expires_at: currentSession.absoluteExpiresAt,
    last_used_at: currentSession.lastUsedAt,
    grant_checked_at: at - 200,
  });
  for (const statement of sharedAuthFinancialConsentLeafStatements()) db.exec(statement.sql);
  const action = bytes(
    '{"amountMinor":1000,"kind":"topup","organizationId":"org_action","reference":"original"}',
  );
  const terms = bytes("Original R1 terms — exact UTF8\nKeep original selection unchanged.");
  const actionIdentity = await createSharedFinancialActionIdentity(
    JSON.parse(new TextDecoder().decode(action)),
  );
  const challenge = bytes(
    canonicalJson({
      v: 1,
      challengeRef: "challenge_original",
      registrationRef: "financial_challenge_registration",
      clientId: "takoserver-console-staging-v1",
      workspaceId: "selected_workspace_B",
      organizationId: "org_action",
      workspaceRef: "selected_ref_B",
      requestFingerprint: actionIdentity.requestFingerprint,
      createdAt: at,
      expiresAt: at + 240_000,
    }),
  );
  const pending: SharedAuthFinancialConsentPendingData = {
    transaction_ref: `rpfc_${"a".repeat(43)}`,
    registration_ref: "rp_consent_registration",
    incarnation: "consent_incarnation",
    challenge_ref: "challenge_original",
    action_ref: "original",
    action_kind: "topup",
    organization_id: "org_action",
    workspace_id: "selected_workspace_B",
    workspace_ref: "selected_ref_B",
    request_fingerprint: actionIdentity.requestFingerprint,
    principal_id: human.principalId,
    principal_incarnation: human.principalIncarnation,
    principal_binding_ref: human.ref,
    authority_ref: credential.origin.ref,
    credential_incarnation: credential.origin.incarnation,
    credential_target_ref: human.targetRef,
    credential_organization_id: credential.organizationId,
    credential_workspace_id: r.workspaceId,
    credential_workspace_ref: r.workspaceRef,
    action_original_bytes: action,
    action_custody_sha256: await custodyHash(action),
    terms_original_bytes: terms,
    terms_digest_original: await custodyHash(terms),
    terms_custody_sha256: await custodyHash(terms),
    disclosure_ref: "disclosure_original",
    challenge_original_bytes: challenge,
    challenge_custody_sha256: await custodyHash(challenge),
    created_at: at,
    expires_at: at + 240_000,
  };
  const commandBytes = bytes('{"synthetic":"exact predispatch full command bytes"}');
  const identity = await syntheticV4Original(
    pending,
    credential,
    currentSession.version,
    "opaque consent Ω 01",
  );
  const originalBytes = bytes(identity.canonicalOriginalJson);
  const command: OwnedFixtureCommand = {
    key: {
      registrationRef: pending.registration_ref,
      incarnation: pending.incarnation,
      transactionRef: pending.transaction_ref,
      commandRef: "command_original",
      consentRef: identity.original.consentRef,
      receiptRef: "receipt_original",
    },
    selectedScope: {
      organizationId: pending.organization_id,
      workspaceId: pending.workspace_id,
      workspaceRef: pending.workspace_ref,
    },
    family: "rp-explicit-action-consent",
    commandBytes,
    commandCustodySHA256: await custodyHash(commandBytes),
    originalBytes,
    originalDigest: identity.consentDigest,
    originalCustodySHA256: await custodyHash(originalBytes),
    capturedAt: at + 100,
  };
  const input: SharedAuthFinancialConsentGuardedStatementData & {
    readonly command: OwnedFixtureCommand;
  } = { pending, command, credential, human, currentSession, recordedAt: at + 200 };
  // Test-only insertion of a synthetic retained pending. This is NOT a product
  // pending producer or evidence of genuine Financial selection/human consent.
  if (options.seedPending !== false && !options.wrongBindingUnique) insert(db, P, pending);
  const sql: Pick<Sql, "query"> = {
    async query(statement, params = []) {
      return db
        .query(statement)
        .all(...params.map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p))) as Row[];
    },
  };
  return { db, input, sql };
}

// All new cases are SOURCE ONLY. A later dedicated parent allocation must run
// them. Reduced SQLite anchors/ordinary SqlWrite shapes never qualify genuine
// Root/native write origin, human consent, NEW/consume or firstdispatch.
const captureInput = (
  input: SharedAuthFinancialConsentGuardedStatementData,
): SharedAuthFinancialConsentCaptureData => ({ pending: input.pending, command: input.command });
const commandColumns = [
  "command_ref",
  "transaction_ref",
  "registration_ref",
  "incarnation",
  "organization_id",
  "workspace_id",
  "workspace_ref",
  "family",
  "consent_ref",
  "receipt_ref",
  "command_bytes",
  "command_custody_sha256",
  "original_bytes",
  "original_digest",
  "original_custody_sha256",
  "captured_at",
] as const;
function copyCommand(command: SharedAuthFinancialConsentOriginalCommand) {
  return {
    ...command,
    key: { ...command.key },
    selectedScope: { ...command.selectedScope },
    commandBytes: new Uint8Array(command.commandBytes),
    originalBytes: new Uint8Array(command.originalBytes),
  };
}
function copyRow(row: Row): Row {
  const result: Row = {};
  for (const name of Object.keys(row)) {
    const value = row[name];
    result[name] =
      value instanceof Uint8Array
        ? new Uint8Array(value)
        : value instanceof ArrayBuffer
          ? value.slice(0)
          : value;
  }
  return result;
}
function copyWrite(result: SqlWrite) {
  return { changes: result.changes, rows: result.rows.map(copyRow) };
}
async function actualCapture(f: Awaited<ReturnType<typeof fixture>>) {
  const result = write(
    f.db,
    await sharedAuthFinancialConsentCommandCaptureStatement(captureInput(f.input)),
  );
  expect(result.changes).toBe(1);
  expect(result.rows).toHaveLength(1);
  expect(Object.keys(result.rows[0]!).sort()).toEqual([...commandColumns].sort());
  return result;
}
async function rejected(
  result: unknown,
  command: unknown,
  code: "invalid_request" | "unavailable" = "unavailable",
) {
  // Deliberate malformed DATA casts only; no genuine constructor/origin stub.
  await expect(
    requireSharedAuthFinancialConsentCommandCapturePostimage(
      result as SqlWrite,
      command as SharedAuthFinancialConsentOriginalCommand,
    ),
  ).rejects.toMatchObject({ code });
}

describe("private command-capture16 postimage DATA validator: source cases", () => {
  test("actual capture45 affected1 RETURNING16 yields only detached command DATA without any SQL effect", async () => {
    const f = await fixture();
    const write = await actualCapture(f);
    const before = snapshot(f.db);
    const data = await requireSharedAuthFinancialConsentCommandCapturePostimage(
      write,
      f.input.command,
    );
    expect(data.state).toBe("command-capture-postimage-data");
    expect(data.command).toEqual(f.input.command);
    expect(Object.keys(data).sort()).toEqual(["command", "state"]);
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data.command)).toBe(true);
    expect(Object.isFrozen(data.command.key)).toBe(true);
    expect(Object.isFrozen(data.command.selectedScope)).toBe(true);
    expect(data.command).not.toBe(f.input.command);
    expect(data.command.commandBytes).not.toBe(f.input.command.commandBytes);
    expect(data.command.originalBytes).not.toBe(write.rows[0]!.original_bytes);
    expect(snapshot(f.db)).toEqual(before);
    expect(rows(f.db, O)).toHaveLength(0); // Command capture is not an original/receipt consume.
  });

  test("actual second capture has affected0 and cannot turn command-only custody into permission or a new receipt", async () => {
    const f = await fixture();
    await actualCapture(f);
    const before = snapshot(f.db);
    // Independent synthetic negative contender, not a recovery/resend adapter.
    const zero = write(
      f.db,
      await sharedAuthFinancialConsentCommandCaptureStatement(captureInput(f.input)),
    );
    expect(zero.changes).toBe(0);
    expect(zero.rows).toHaveLength(0);
    await rejected(zero, f.input.command);
    expect(snapshot(f.db)).toEqual(before);
    await expect(
      createSharedAuthFinancialConsentOriginalReader(f.sql).readOriginal(f.input.command),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(rows(f.db, C)).toHaveLength(1);
    expect(rows(f.db, O)).toHaveLength(0);
    expect(snapshot(f.db)).toEqual(before);
  });

  test("affected0 affected2 missing unknown fractional or nonnumeric ACK never passes even with a matching row", async () => {
    const f = await fixture();
    const result = await actualCapture(f);
    const before = snapshot(f.db);
    for (const changes of [
      0,
      2,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      null,
      "1",
      true,
    ]) {
      await rejected({ changes, rows: [copyRow(result.rows[0]!)] }, f.input.command);
    }
    for (const unknown of [
      undefined,
      null,
      {},
      Promise.resolve(result),
      { changes: 1 },
      { rows: result.rows },
    ])
      await rejected(unknown, f.input.command);
    expect(snapshot(f.db)).toEqual(before);
  });

  test("every one of the original16 columns is exact and no changed valid field borrows the acknowledged original", async () => {
    const f = await fixture();
    const result = await actualCapture(f);
    expect(commandColumns).toHaveLength(16);
    const before = snapshot(f.db);
    for (const name of commandColumns) {
      const changed = copyWrite(result);
      const row = changed.rows[0]!;
      if (name.endsWith("_bytes")) {
        const value = new Uint8Array([1, 2, 3]);
        row[name] = value;
      } else if (name === "captured_at") row[name] = f.input.command.capturedAt + 1;
      else row[name] = `${String(row[name])}_changed`;
      await rejected(changed, f.input.command);
      const missing = copyWrite(result);
      delete missing.rows[0]![name];
      await rejected(missing, f.input.command);
    }
    expect(snapshot(f.db)).toEqual(before);
  });

  test("all fullcommand refs selectedscope family bytes digests and capture time stay bound to the same expected command", async () => {
    const f = await fixture();
    const result = await actualCapture(f);
    for (const name of [
      "registrationRef",
      "incarnation",
      "transactionRef",
      "commandRef",
      "consentRef",
      "receiptRef",
    ] as const) {
      const changed = copyCommand(f.input.command);
      changed.key[name] =
        name === "transactionRef" ? `rpfc_${"b".repeat(43)}` : `${changed.key[name]}_other`;
      await rejected(result, changed);
    }
    for (const name of ["organizationId", "workspaceId", "workspaceRef"] as const) {
      const changed = copyCommand(f.input.command);
      changed.selectedScope[name] += "_other";
      await rejected(result, changed);
    }
    await rejected(
      result,
      { ...copyCommand(f.input.command), family: "other-family" },
      "invalid_request",
    );
    const changed = copyCommand(f.input.command);
    changed.commandBytes = bytes("different correctly hashed command");
    changed.commandCustodySHA256 = await custodyHash(changed.commandBytes);
    await rejected(result, changed);
    const original = copyCommand(f.input.command);
    original.originalBytes = bytes("different correctly hashed original");
    original.originalCustodySHA256 = await custodyHash(original.originalBytes);
    await rejected(result, original);
    await rejected(result, {
      ...copyCommand(f.input.command),
      originalDigest: "different opaque original digest",
    });
    await rejected(result, {
      ...copyCommand(f.input.command),
      capturedAt: f.input.command.capturedAt + 1,
    });
  });

  test("equal supplied row and command hashes are still checked against actual original bytes and never rehashed into a new recipe", async () => {
    const f = await fixture();
    const result = await actualCapture(f);
    const before = snapshot(f.db);
    for (const field of ["command", "original"] as const) {
      const changed = copyWrite(result);
      const command = copyCommand(f.input.command);
      if (field === "command") {
        command.commandCustodySHA256 = digest("0");
        changed.rows[0]!.command_custody_sha256 = digest("0");
      } else {
        command.originalCustodySHA256 = digest("0");
        changed.rows[0]!.original_custody_sha256 = digest("0");
      }
      await rejected(changed, command);
    }
    expect(snapshot(f.db)).toEqual(before);
  });

  test("write row and expected accessors are rejected without invoking getters and borrowed Proxy errors keep their input boundary", async () => {
    const f = await fixture();
    const result = await actualCapture(f);
    let getters = 0;
    for (const name of ["changes", "rows"] as const) {
      const value = copyWrite(result);
      Object.defineProperty(value, name, {
        enumerable: true,
        get() {
          getters++;
          throw new Error("getter forbidden");
        },
      });
      await rejected(value, f.input.command);
    }
    for (const name of commandColumns) {
      const value = copyWrite(result);
      Object.defineProperty(value.rows[0]!, name, {
        enumerable: true,
        get() {
          getters++;
          throw new Error("row getter forbidden");
        },
      });
      await rejected(value, f.input.command);
    }
    const expected = copyCommand(f.input.command);
    Object.defineProperty(expected, "commandBytes", {
      enumerable: true,
      get() {
        getters++;
        throw new Error("expected getter forbidden");
      },
    });
    await rejected(result, expected, "invalid_request");
    const badResult = new Proxy(copyWrite(result), {
      ownKeys() {
        throw new SharedAuthFinancialConsentOriginalReadError("invalid_request");
      },
    });
    await rejected(badResult, f.input.command);
    const badInput = new Proxy(copyCommand(f.input.command), {
      ownKeys() {
        throw new SharedAuthFinancialConsentOriginalReadError("custody_conflict");
      },
    });
    await rejected(result, badInput, "invalid_request");
    expect(getters).toBe(0);
  });

  test("result arrays must be dense exactone own data and rows reject extra symbols prototypes and duplicate results", async () => {
    const f = await fixture();
    const result = await actualCapture(f);
    let getters = 0;
    const sparse = new Array<Row>(1);
    const indexed = [copyRow(result.rows[0]!)];
    Object.defineProperty(indexed, "0", {
      enumerable: true,
      get() {
        getters++;
        throw new Error("index getter forbidden");
      },
    });
    const extraArray = [copyRow(result.rows[0]!)];
    Object.defineProperty(extraArray, Symbol("extra"), { value: 1 });
    for (const invalid of [
      [],
      sparse,
      indexed,
      extraArray,
      [copyRow(result.rows[0]!), copyRow(result.rows[0]!)],
      { 0: result.rows[0], length: 1 },
    ]) {
      await rejected({ changes: 1, rows: invalid }, f.input.command);
    }
    const extraRow = copyWrite(result);
    Object.defineProperty(extraRow.rows[0]!, Symbol("extra"), { value: 1 });
    await rejected(extraRow, f.input.command);
    await rejected({ ...copyWrite(result), meta: {} }, f.input.command);
    const foreignRow = copyWrite(result);
    Object.setPrototypeOf(foreignRow.rows[0]!, { inherited: true });
    await rejected(foreignRow, f.input.command);
    expect(getters).toBe(0);
  });

  test("malformed empty oversized nonbyte shared or proxied BLOBs fail closed without invoking Proxy get traps", async () => {
    const f = await fixture();
    const result = await actualCapture(f);
    let gets = 0;
    const proxy = new Proxy(new Uint8Array(f.input.command.commandBytes), {
      get() {
        gets++;
        throw new Error("Proxy getter forbidden");
      },
    });
    const malformed: unknown[] = [
      null,
      "bytes",
      new Uint8Array(),
      new DataView(new ArrayBuffer(1)),
      new Uint16Array([1]),
      new SharedArrayBuffer(1),
      new Uint8Array(new SharedArrayBuffer(1)),
      proxy,
    ];
    for (const invalid of malformed) {
      const returned = copyWrite(result);
      returned.rows[0]!.command_bytes = invalid;
      await rejected(returned, f.input.command);
      await rejected(
        result,
        { ...copyCommand(f.input.command), commandBytes: invalid },
        "invalid_request",
      );
    }
    const huge = copyWrite(result);
    huge.rows[0]!.command_bytes = new Uint8Array(65537);
    await rejected(huge, f.input.command);
    const hugeOriginal = copyWrite(result);
    hugeOriginal.rows[0]!.original_bytes = new Uint8Array(16385);
    await rejected(hugeOriginal, f.input.command);
    for (const capturedAt of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      await rejected(result, { ...copyCommand(f.input.command), capturedAt }, "invalid_request");
    expect(gets).toBe(0);
  });

  test("native BLOB copies bypass shadow buffer offset length and constructor getters on both arguments", async () => {
    const f = await fixture();
    const result = copyWrite(await actualCapture(f));
    const command = copyCommand(f.input.command);
    let getters = 0;
    const values = [
      command.commandBytes,
      command.originalBytes,
      result.rows[0]!.command_bytes,
      result.rows[0]!.original_bytes,
    ];
    for (const value of values) {
      if (!(value instanceof Uint8Array))
        throw new Error("synthetic SQLite fixture did not return Uint8Array BLOB");
      for (const name of ["buffer", "byteOffset", "byteLength", "constructor"])
        Object.defineProperty(value, name, {
          get() {
            getters++;
            throw new Error("BLOB getter forbidden");
          },
        });
    }
    const data = await requireSharedAuthFinancialConsentCommandCapturePostimage(result, command);
    expect(data.command).toEqual(f.input.command);
    expect(getters).toBe(0);
  });

  test("cross-column BLOB alias corruption is rejected and standard ArrayBuffer postimages detach without changing bytes", async () => {
    const f = await fixture();
    const original = await actualCapture(f);
    const corrupted = copyWrite(original);
    corrupted.rows[0]!.command_bytes = corrupted.rows[0]!.original_bytes;
    await rejected(corrupted, f.input.command);
    const buffers = copyWrite(original);
    buffers.rows[0]!.command_bytes = new Uint8Array(f.input.command.commandBytes).buffer;
    buffers.rows[0]!.original_bytes = new Uint8Array(f.input.command.originalBytes).buffer;
    expect(
      (await requireSharedAuthFinancialConsentCommandCapturePostimage(buffers, f.input.command))
        .command,
    ).toEqual(f.input.command);
  });

  test("expected command and supplied postimage are fully detached before the first hash await", async () => {
    const f = await fixture();
    const actual = await actualCapture(f);
    const result = copyWrite(actual);
    const expected = copyCommand(f.input.command);
    const originalExpected = copyCommand(expected);
    const before = snapshot(f.db);
    const pending = requireSharedAuthFinancialConsentCommandCapturePostimage(result, expected);
    expected.commandBytes.fill(0);
    expected.originalBytes.fill(0);
    expected.key.commandRef = "mutated_after_call";
    expected.selectedScope.workspaceId = "mutated_after_call";
    expected.originalDigest = "mutated_after_call";
    expected.capturedAt = 0;
    for (const value of [result.rows[0]!.command_bytes, result.rows[0]!.original_bytes])
      if (value instanceof Uint8Array) value.fill(0);
    result.rows[0]!.command_ref = "mutated_after_call";
    result.rows[0]!.captured_at = 0;
    result.changes = 0;
    result.rows.length = 0;
    expect((await pending).command).toEqual(originalExpected);
    expect(snapshot(f.db)).toEqual(before);
  });

  test("returned mutable BLOB DATA cannot mutate inputs result or stored custody and confers no extra phase method", async () => {
    const f = await fixture();
    const result = await actualCapture(f);
    const before = snapshot(f.db);
    const expected = copyCommand(f.input.command);
    const data = await requireSharedAuthFinancialConsentCommandCapturePostimage(result, expected);
    data.command.commandBytes.fill(0);
    data.command.originalBytes.fill(0);
    expect(expected.commandBytes).toEqual(f.input.command.commandBytes);
    expect(expected.originalBytes).toEqual(f.input.command.originalBytes);
    expect(result.rows[0]!.command_bytes).toEqual(f.input.command.commandBytes);
    expect(snapshot(f.db)).toEqual(before);
    expect(Reflect.set(data.command.key, "commandRef", "replace")).toBe(false);
    expect(Object.keys(data).sort()).toEqual(["command", "state"]);
    expect(rows(f.db, O)).toHaveLength(0);
  });

  test("a caller-constructed matching SqlWrite proves DATA equality only and accepts no origin ready executor or callback", async () => {
    const f = await fixture();
    const actual = await actualCapture(f);
    const before = snapshot(f.db);
    // This is expressly an unqualified DTO, not a forged successful native graph.
    const dto: SqlWrite = copyWrite(actual);
    const data = await requireSharedAuthFinancialConsentCommandCapturePostimage(
      dto,
      f.input.command,
    );
    expect(Object.keys(data).sort()).toEqual(["command", "state"]);
    expect(data.state).toBe("command-capture-postimage-data");
    let calls = 0;
    const extra = {
      ...copyCommand(f.input.command),
      query() {
        calls++;
        throw new Error("not invoked");
      },
    };
    await rejected(actual, extra, "invalid_request");
    await rejected(
      { ...copyWrite(actual), origin: "claimed-native", ready: true },
      f.input.command,
    );
    expect(calls).toBe(0);
    expect(snapshot(f.db)).toEqual(before);
  });

  test("committed capture with unknown ACK remains command-only same-original GET and never dispatches or repairs", async () => {
    const f = await fixture();
    await actualCapture(f);
    const before = snapshot(f.db);
    await rejected(undefined, f.input.command);
    await expect(
      createSharedAuthFinancialConsentOriginalReader(f.sql).readOriginal(f.input.command),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(snapshot(f.db)).toEqual(before);
    expect(rows(f.db, C)).toHaveLength(1);
    expect(rows(f.db, O)).toHaveLength(0);
  });
});
