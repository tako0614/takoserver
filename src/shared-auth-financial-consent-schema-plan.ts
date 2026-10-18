import type { Row, Sql, SqlStatement, SqlWrite } from "./ports.ts";

/** Unnumbered, unregistered RP candidate leaf. No migration/apply or authority grant.
 * Root alone owns full Auth103/RP schema composition and qualified currentness.
 * These tables retain DATA/history. They cannot qualify a human, Clock or source.
 */
export const SHARED_AUTH_FINANCIAL_CONSENT_LEAF_PREFIX = "shared_auth_financial_consent_";
const PENDING = `${SHARED_AUTH_FINANCIAL_CONSENT_LEAF_PREFIX}pending`;
const COMMANDS = `${SHARED_AUTH_FINANCIAL_CONSENT_LEAF_PREFIX}commands`;
const ORIGINALS = `${SHARED_AUTH_FINANCIAL_CONSENT_LEAF_PREFIX}originals`;
export const SHARED_AUTH_FINANCIAL_CONSENT_ISSUERS = `${SHARED_AUTH_FINANCIAL_CONSENT_LEAF_PREFIX}issuer_registrations`;
const MAX_INTEGER = 9_007_199_254_740_991;
const FAMILY = "rp-explicit-action-consent";

export class ConsentLeafCandidateError extends Error {
  constructor(readonly code: "schema_conflict" | "custody_conflict" | "unavailable") {
    super(code);
    this.name = "ConsentLeafCandidateError";
  }
}

const unavailable = (): never => {
  throw new ConsentLeafCandidateError("unavailable");
};
const schemaConflict = (): never => {
  throw new ConsentLeafCandidateError("schema_conflict");
};
const custodyConflict = (): never => {
  throw new ConsentLeafCandidateError("custody_conflict");
};

/** Exact existing retained keys; no table/index is added to the Root-owned source. */
export const CONSENT_LEAF_RETAINED_AUTH_KEYS = Object.freeze([
  Object.freeze({
    table: "auth_principal_incarnations",
    columns: Object.freeze(["principal_id", "principal_incarnation"]),
  }),
  Object.freeze({
    table: "shared_principal_bindings",
    columns: Object.freeze(["binding_ref", "principal_id", "principal_incarnation"]),
  }),
  Object.freeze({
    table: "credential_authority_classes",
    columns: Object.freeze(["authority_ref"]),
  }),
  Object.freeze({
    table: "credential_authority_classes",
    columns: Object.freeze(["credential_incarnation"]),
  }),
]);

function textCheck(column: string, maximum = 512): string {
  return `CHECK(typeof(${column})='text' AND length(${column}) BETWEEN 1 AND ${maximum} AND instr(${column},char(0))=0)`;
}
function digestCheck(column: string): string {
  return `CHECK(typeof(${column})='text' AND length(${column})=71 AND substr(${column},1,7)='sha256:' AND substr(${column},8) NOT GLOB '*[^0-9a-f]*')`;
}
function timeCheck(column: string): string {
  return `CHECK(typeof(${column})='integer' AND ${column} BETWEEN 0 AND ${MAX_INTEGER})`;
}
function bytesCheck(column: string, maximum: number): string {
  return `CHECK(typeof(${column})='blob' AND length(${column}) BETWEEN 1 AND ${maximum})`;
}

const pendingDDL = `CREATE TABLE ${PENDING} (
 transaction_ref TEXT PRIMARY KEY NOT NULL,
 registration_ref TEXT NOT NULL, incarnation TEXT NOT NULL,
 challenge_ref TEXT NOT NULL, action_ref TEXT NOT NULL, action_kind TEXT NOT NULL,
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, workspace_ref TEXT NOT NULL,
 request_fingerprint TEXT NOT NULL,
 principal_id TEXT NOT NULL, principal_incarnation TEXT NOT NULL,
 principal_binding_ref TEXT NOT NULL, authority_ref TEXT NOT NULL,
 credential_incarnation TEXT NOT NULL, credential_target_ref TEXT NOT NULL,
 credential_organization_id TEXT NOT NULL, credential_workspace_id TEXT NOT NULL, credential_workspace_ref TEXT NOT NULL,
 action_original_bytes BLOB NOT NULL, action_custody_sha256 TEXT NOT NULL,
 terms_original_bytes BLOB NOT NULL, terms_digest_original TEXT NOT NULL,
 terms_custody_sha256 TEXT NOT NULL, disclosure_ref TEXT NOT NULL,
 challenge_original_bytes BLOB NOT NULL, challenge_custody_sha256 TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 UNIQUE(registration_ref,incarnation,challenge_ref,action_ref),
 FOREIGN KEY(principal_id,principal_incarnation) REFERENCES auth_principal_incarnations(principal_id,principal_incarnation) ON DELETE RESTRICT,
 FOREIGN KEY(principal_binding_ref,principal_id,principal_incarnation) REFERENCES shared_principal_bindings(binding_ref,principal_id,principal_incarnation) ON DELETE RESTRICT,
 FOREIGN KEY(authority_ref) REFERENCES credential_authority_classes(authority_ref) ON DELETE RESTRICT,
 ${textCheck("transaction_ref", 48)},
 CHECK(length(transaction_ref)=48 AND substr(transaction_ref,1,5)='rpfc_' AND substr(transaction_ref,6) NOT GLOB '*[^A-Za-z0-9_-]*'),
 ${["registration_ref", "incarnation", "challenge_ref", "action_ref", "organization_id", "workspace_id", "workspace_ref", "principal_id", "principal_incarnation", "principal_binding_ref", "authority_ref", "credential_incarnation", "credential_target_ref", "credential_organization_id", "credential_workspace_id", "credential_workspace_ref", "terms_digest_original", "disclosure_ref"].map((name) => textCheck(name)).join(",\n ")},
 CHECK(action_kind IN ('topup','subscription-start','card-setup','plan-change','cancel')),
 ${["request_fingerprint", "action_custody_sha256", "terms_custody_sha256", "challenge_custody_sha256"].map(digestCheck).join(",\n ")},
 ${bytesCheck("action_original_bytes", 16384)}, ${bytesCheck("terms_original_bytes", 16384)}, ${bytesCheck("challenge_original_bytes", 16384)},
 ${timeCheck("created_at")}, ${timeCheck("expires_at")},
 CHECK(expires_at>created_at AND expires_at-created_at<=300000)
)`;

// credential_* scope is the immutable Root class/RP-row tuple. The unprefixed
// scope is the separately selected Financial original tuple. They may differ;
// this DATA leaf never infers permission/current admission from either tuple.

const commandDDL = `CREATE TABLE ${COMMANDS} (
 command_ref TEXT PRIMARY KEY NOT NULL, transaction_ref TEXT NOT NULL UNIQUE,
 registration_ref TEXT NOT NULL, incarnation TEXT NOT NULL,
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, workspace_ref TEXT NOT NULL,
 family TEXT NOT NULL, consent_ref TEXT NOT NULL UNIQUE, receipt_ref TEXT NOT NULL UNIQUE,
 command_bytes BLOB NOT NULL, command_custody_sha256 TEXT NOT NULL,
 original_bytes BLOB NOT NULL, original_digest TEXT NOT NULL, original_custody_sha256 TEXT NOT NULL,
 captured_at INTEGER NOT NULL,
 FOREIGN KEY(transaction_ref) REFERENCES ${PENDING}(transaction_ref) ON DELETE RESTRICT,
 ${["command_ref", "transaction_ref", "registration_ref", "incarnation", "organization_id", "workspace_id", "workspace_ref", "consent_ref", "receipt_ref", "original_digest"].map((name) => textCheck(name)).join(",\n ")},
 CHECK(family='${FAMILY}'),
 ${bytesCheck("command_bytes", 65536)}, ${bytesCheck("original_bytes", 16384)},
 ${digestCheck("command_custody_sha256")}, ${digestCheck("original_custody_sha256")}, ${timeCheck("captured_at")}
)`;

// Mandatory receipt is a non-null vector in the SAME immutable CAS row as the
// original. There is no standalone original/receipt prefix that can commit.
const originalDDL = `CREATE TABLE ${ORIGINALS} (
 consent_ref TEXT PRIMARY KEY NOT NULL, command_ref TEXT NOT NULL UNIQUE,
 transaction_ref TEXT NOT NULL UNIQUE, receipt_ref TEXT NOT NULL UNIQUE,
 registration_ref TEXT NOT NULL, incarnation TEXT NOT NULL,
 organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, workspace_ref TEXT NOT NULL,
 original_bytes BLOB NOT NULL, original_digest TEXT NOT NULL, original_custody_sha256 TEXT NOT NULL,
 recorded_at INTEGER NOT NULL, receipt_recorded_at INTEGER NOT NULL,
 FOREIGN KEY(command_ref) REFERENCES ${COMMANDS}(command_ref) ON DELETE RESTRICT,
 FOREIGN KEY(transaction_ref) REFERENCES ${PENDING}(transaction_ref) ON DELETE RESTRICT,
 ${["consent_ref", "command_ref", "transaction_ref", "receipt_ref", "registration_ref", "incarnation", "organization_id", "workspace_id", "workspace_ref", "original_digest"].map((name) => textCheck(name)).join(",\n ")},
 ${bytesCheck("original_bytes", 16384)}, ${digestCheck("original_custody_sha256")},
 ${timeCheck("recorded_at")}, ${timeCheck("receipt_recorded_at")},
 CHECK(receipt_recorded_at=recorded_at)
)`;

// The RP issuer is a separate code-selected original, never an alias for the
// Auth103 RP registration or the Financial action-source registration. This is
// still an unnumbered candidate; Root owns any eventual composition/apply.
const issuerDDL = `CREATE TABLE ${SHARED_AUTH_FINANCIAL_CONSENT_ISSUERS} (
 registration_ref TEXT NOT NULL, incarnation TEXT NOT NULL,
 registration_digest TEXT NOT NULL, original_json TEXT NOT NULL,
 PRIMARY KEY(registration_ref,incarnation),
 ${textCheck("registration_ref")}, ${textCheck("incarnation")},
 ${digestCheck("registration_digest")},
 ${textCheck("original_json", 4096)}
)`;

const retainedJoin = `SELECT 1 FROM credential_authority_classes c
 JOIN shared_principal_bindings b ON b.binding_ref=c.principal_binding_ref AND b.principal_id=c.principal_id AND b.principal_incarnation=c.principal_incarnation
 JOIN auth_principal_incarnations p ON p.principal_id=c.principal_id AND p.principal_incarnation=c.principal_incarnation`;
const pendingAuth = `${retainedJoin}
 WHERE c.authority_ref=NEW.authority_ref AND c.credential_incarnation=NEW.credential_incarnation
 AND c.principal_id=NEW.principal_id AND c.principal_incarnation=NEW.principal_incarnation
 AND c.principal_binding_ref=NEW.principal_binding_ref AND c.target_ref=NEW.credential_target_ref
 AND c.backend='shared-rp-session' AND c.class='official-shared-rp-session'
 AND c.organization_id=NEW.credential_organization_id AND c.workspace_id=NEW.credential_workspace_id AND c.workspace_ref=NEW.credential_workspace_ref
 AND c.state='active' AND b.state='active' AND p.state='active'`;

type SchemaObject = Readonly<{
  type: "table" | "trigger";
  name: string;
  table: string;
  sql: string;
}>;
const objects: SchemaObject[] = [
  {
    type: "table",
    name: SHARED_AUTH_FINANCIAL_CONSENT_ISSUERS,
    table: SHARED_AUTH_FINANCIAL_CONSENT_ISSUERS,
    sql: issuerDDL,
  },
  { type: "table", name: PENDING, table: PENDING, sql: pendingDDL },
  { type: "table", name: COMMANDS, table: COMMANDS, sql: commandDDL },
  { type: "table", name: ORIGINALS, table: ORIGINALS, sql: originalDDL },
  {
    type: "trigger",
    name: `${PENDING}_auth_tuple`,
    table: PENDING,
    sql: `CREATE TRIGGER ${PENDING}_auth_tuple BEFORE INSERT ON ${PENDING}
WHEN NOT EXISTS(${pendingAuth}) BEGIN SELECT RAISE(ABORT,'Retained RP/human tuple required'); END`,
  },
  {
    type: "trigger",
    name: `${COMMANDS}_pending_tuple`,
    table: COMMANDS,
    sql: `CREATE TRIGGER ${COMMANDS}_pending_tuple BEFORE INSERT ON ${COMMANDS}
WHEN NOT EXISTS(SELECT 1 FROM ${PENDING} p WHERE p.transaction_ref=NEW.transaction_ref AND p.registration_ref=NEW.registration_ref AND p.incarnation=NEW.incarnation
 AND p.organization_id=NEW.organization_id AND p.workspace_id=NEW.workspace_id AND p.workspace_ref=NEW.workspace_ref
 AND p.created_at<=NEW.captured_at AND NEW.captured_at<p.expires_at)
BEGIN SELECT RAISE(ABORT,'Original pending transaction required'); END`,
  },
  {
    type: "trigger",
    name: `${ORIGINALS}_command_tuple`,
    table: ORIGINALS,
    sql: `CREATE TRIGGER ${ORIGINALS}_command_tuple BEFORE INSERT ON ${ORIGINALS}
WHEN NOT EXISTS(SELECT 1 FROM ${COMMANDS} c JOIN ${PENDING} p ON p.transaction_ref=c.transaction_ref
 WHERE c.command_ref=NEW.command_ref AND c.transaction_ref=NEW.transaction_ref
 AND c.registration_ref=NEW.registration_ref AND c.incarnation=NEW.incarnation
 AND c.organization_id=NEW.organization_id AND c.workspace_id=NEW.workspace_id AND c.workspace_ref=NEW.workspace_ref
 AND p.organization_id=c.organization_id AND p.workspace_id=c.workspace_id AND p.workspace_ref=c.workspace_ref
 AND c.consent_ref=NEW.consent_ref AND c.receipt_ref=NEW.receipt_ref
 AND c.original_bytes IS NEW.original_bytes AND c.original_digest IS NEW.original_digest
 AND c.original_custody_sha256 IS NEW.original_custody_sha256
 AND c.captured_at<=NEW.recorded_at AND NEW.recorded_at<p.expires_at
 AND EXISTS(SELECT 1 FROM credential_authority_classes auth_c
 JOIN shared_principal_bindings auth_b ON auth_b.binding_ref=auth_c.principal_binding_ref AND auth_b.principal_id=auth_c.principal_id AND auth_b.principal_incarnation=auth_c.principal_incarnation
 JOIN auth_principal_incarnations auth_p ON auth_p.principal_id=auth_c.principal_id AND auth_p.principal_incarnation=auth_c.principal_incarnation
 WHERE auth_c.authority_ref=p.authority_ref
 AND auth_c.credential_incarnation=p.credential_incarnation AND auth_c.principal_id=p.principal_id
 AND auth_c.principal_incarnation=p.principal_incarnation AND auth_c.principal_binding_ref=p.principal_binding_ref
 AND auth_c.target_ref=p.credential_target_ref AND auth_c.backend='shared-rp-session' AND auth_c.class='official-shared-rp-session'
 AND auth_c.organization_id=p.credential_organization_id AND auth_c.workspace_id=p.credential_workspace_id AND auth_c.workspace_ref=p.credential_workspace_ref
 AND auth_c.state='active' AND auth_b.state='active' AND auth_p.state='active'))
BEGIN SELECT RAISE(ABORT,'Exact predispatch command and active retained tuple required'); END`,
  },
];
for (const table of [SHARED_AUTH_FINANCIAL_CONSENT_ISSUERS, PENDING, COMMANDS, ORIGINALS]) {
  const duplicate =
    table === SHARED_AUTH_FINANCIAL_CONSENT_ISSUERS
      ? "registration_ref=NEW.registration_ref AND incarnation=NEW.incarnation"
      : table === PENDING
        ? `transaction_ref=NEW.transaction_ref OR (registration_ref=NEW.registration_ref AND incarnation=NEW.incarnation AND challenge_ref=NEW.challenge_ref AND action_ref=NEW.action_ref)`
        : `command_ref=NEW.command_ref OR transaction_ref=NEW.transaction_ref OR consent_ref=NEW.consent_ref OR receipt_ref=NEW.receipt_ref`;
  objects.push(
    {
      type: "trigger",
      name: `${table}_no_replace`,
      table,
      sql: `CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${duplicate}) BEGIN SELECT RAISE(ABORT,'Consent custody cannot be replaced'); END`,
    },
    {
      type: "trigger",
      name: `${table}_no_update`,
      table,
      sql: `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Consent custody is immutable'); END`,
    },
    {
      type: "trigger",
      name: `${table}_no_delete`,
      table,
      sql: `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Consent history is retained'); END`,
    },
  );
}
export const SHARED_AUTH_FINANCIAL_CONSENT_LEAF_OBJECTS = Object.freeze(
  objects.map((value) => Object.freeze(value)),
);

/** Returns source statements only. Does not apply/install/register anything. */
export function sharedAuthFinancialConsentLeafStatements(): readonly SqlStatement[] {
  return Object.freeze(
    SHARED_AUTH_FINANCIAL_CONSENT_LEAF_OBJECTS.map(({ sql }) => Object.freeze({ sql })),
  );
}

function exactOwn(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== names.length) return unavailable();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !names.includes(key)) return unavailable();
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
      return unavailable();
    result[key] = descriptor.value;
  }
  return result;
}

type CapturedReadPort = Readonly<{ receiver: Pick<Sql, "query">; method: Sql["query"] }>;
function captureReadPort(sql: Pick<Sql, "query">): CapturedReadPort {
  if (!sql || typeof sql !== "object") return unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(sql, "query");
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function")
    return unavailable();
  return Object.freeze({ receiver: sql, method: descriptor.value });
}

async function query(
  port: CapturedReadPort,
  statement: string,
  params: readonly string[] = [],
): Promise<readonly Row[]> {
  try {
    const rows: unknown = await Reflect.apply(port.method, port.receiver, [statement, params]);
    return ownedRows(rows);
  } catch {
    return unavailable();
  }
}

function ownedRows(value: unknown): readonly Row[] {
  if (!Array.isArray(value)) return unavailable();
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
  const size: unknown = descriptors.length?.value;
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > 128 ||
    Reflect.ownKeys(descriptors).length !== size + 1
  )
    return unavailable();
  const result: Row[] = [];
  for (let index = 0; index < size; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
      return unavailable();
    const row: unknown = descriptor.value;
    if (!row || typeof row !== "object" || Array.isArray(row)) return unavailable();
    const copy: Row = Object.create(null);
    const fields = Object.getOwnPropertyDescriptors(row);
    if (Reflect.ownKeys(fields).length > 64) return unavailable();
    for (const key of Reflect.ownKeys(fields)) {
      if (typeof key !== "string") return unavailable();
      const field = fields[key];
      if (!field || !Object.hasOwn(field, "value") || !field.enumerable) return unavailable();
      const item: unknown = field.value;
      if (item instanceof Uint8Array) copy[key] = new Uint8Array(item);
      else if (item instanceof ArrayBuffer) copy[key] = item.slice(0);
      else if (item === null || typeof item === "string" || typeof item === "number")
        copy[key] = item;
      else return unavailable();
    }
    result.push(Object.freeze(copy));
  }
  return Object.freeze(result);
}

/** Query-only leaf readiness. Root full Auth/schema/target qualification is separate. */
export async function inspectSharedAuthFinancialConsentLeafSchema(
  sql: Pick<Sql, "query">,
): Promise<"leaf-absent" | "leaf-present"> {
  return inspectSchemaWithPort(captureReadPort(sql));
}

async function inspectSchemaWithPort(
  port: CapturedReadPort,
): Promise<"leaf-absent" | "leaf-present"> {
  const foreignKeys = await query(port, "PRAGMA foreign_keys");
  if (foreignKeys.length !== 1 || foreignKeys[0]?.foreign_keys !== 1) return unavailable();
  for (const required of CONSENT_LEAF_RETAINED_AUTH_KEYS) {
    const columns = await query(port, `PRAGMA table_info(${required.table})`);
    if (
      required.columns.some(
        (name) =>
          !columns.some((row) => row.name === name && row.type === "TEXT" && row.notnull === 1),
      )
    )
      return schemaConflict();
    const primary = columns
      .filter((row) => typeof row.pk === "number" && row.pk > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((row) => row.name);
    let found = JSON.stringify(primary) === JSON.stringify(required.columns);
    for (const index of await query(port, `PRAGMA index_list(${required.table})`)) {
      if (
        index.unique !== 1 ||
        index.partial !== 0 ||
        typeof index.name !== "string" ||
        !/^sqlite_autoindex_[A-Za-z0-9_]+$/u.test(index.name)
      )
        continue;
      const fields = await query(port, `PRAGMA index_info(${index.name})`);
      if (JSON.stringify(fields.map((row) => row.name)) === JSON.stringify(required.columns))
        found = true;
    }
    if (!found) return schemaConflict();
  }
  const rows = await query(
    port,
    "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'shared_auth_financial_consent_*' AND sql IS NOT NULL ORDER BY name LIMIT 32",
  );
  if (rows.length === 0) return "leaf-absent";
  if (rows.length !== SHARED_AUTH_FINANCIAL_CONSENT_LEAF_OBJECTS.length) return schemaConflict();
  for (const row of rows) {
    const expected = SHARED_AUTH_FINANCIAL_CONSENT_LEAF_OBJECTS.find(
      (entry) => entry.name === row.name,
    );
    if (
      !expected ||
      row.type !== expected.type ||
      row.tbl_name !== expected.table ||
      row.sql !== expected.sql
    )
      return schemaConflict();
  }
  for (const table of [PENDING, COMMANDS, ORIGINALS]) {
    if ((await query(port, `PRAGMA foreign_key_check(${table})`)).length !== 0)
      return unavailable();
  }
  return "leaf-present";
}

export interface ConsentLeafOriginalKey {
  readonly registrationRef: string;
  readonly incarnation: string;
  readonly transactionRef: string;
  readonly commandRef: string;
  readonly consentRef: string;
  readonly receiptRef: string;
}
const keyNames = [
  "registrationRef",
  "incarnation",
  "transactionRef",
  "commandRef",
  "consentRef",
  "receiptRef",
];
function keySnapshot(value: unknown): ConsentLeafOriginalKey {
  const key = exactOwn(value, keyNames);
  for (const name of keyNames)
    if (
      typeof key[name] !== "string" ||
      key[name].length < 1 ||
      key[name].length > 512 ||
      key[name].includes("\0")
    )
      return unavailable();
  return Object.freeze({
    registrationRef: String(key.registrationRef),
    incarnation: String(key.incarnation),
    transactionRef: String(key.transactionRef),
    commandRef: String(key.commandRef),
    consentRef: String(key.consentRef),
    receiptRef: String(key.receiptRef),
  });
}

function matchesKey(row: Row, key: ConsentLeafOriginalKey): boolean {
  return (
    row.registration_ref === key.registrationRef &&
    row.incarnation === key.incarnation &&
    row.transaction_ref === key.transactionRef &&
    row.command_ref === key.commandRef &&
    row.consent_ref === key.consentRef &&
    row.receipt_ref === key.receiptRef
  );
}
export interface ConsentLeafSelectedScope {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly workspaceRef: string;
}
function scopeSnapshot(value: unknown): ConsentLeafSelectedScope {
  const scope = exactOwn(value, ["organizationId", "workspaceId", "workspaceRef"]);
  for (const name of ["organizationId", "workspaceId", "workspaceRef"]) {
    if (
      typeof scope[name] !== "string" ||
      scope[name].length < 1 ||
      scope[name].length > 512 ||
      scope[name].includes("\0")
    )
      return unavailable();
  }
  return Object.freeze({
    organizationId: String(scope.organizationId),
    workspaceId: String(scope.workspaceId),
    workspaceRef: String(scope.workspaceRef),
  });
}
function matchesScope(row: Row, scope: ConsentLeafSelectedScope): boolean {
  return (
    row.organization_id === scope.organizationId &&
    row.workspace_id === scope.workspaceId &&
    row.workspace_ref === scope.workspaceRef
  );
}
function ownedBytes(value: unknown, maximum: number): Uint8Array<ArrayBuffer> {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : value instanceof Uint8Array
        ? value
        : unavailable();
  if (bytes.byteLength < 1 || bytes.byteLength > maximum) return unavailable();
  return new Uint8Array(bytes);
}
async function checkCustodyHash(
  value: unknown,
  digest: unknown,
  maximum: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = ownedBytes(value, maximum);
  const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  if (
    `sha256:${Array.from(actual, (byte) => byte.toString(16).padStart(2, "0")).join("")}` !== digest
  )
    return unavailable();
  return bytes;
}

/** DATA diagnostic only. Internal raw-byte SHA256 is not the external digest recipe.
 * No absence/command-only state authorizes a write, new ref, resend or family switch.
 * Historical GET deliberately does not require currently active Auth rows.
 */
export async function inspectSharedAuthFinancialConsentLeafCustody(
  sql: Pick<Sql, "query">,
  input: ConsentLeafOriginalKey,
): Promise<
  Readonly<{
    state: "candidate-absent" | "pending-only" | "command-only" | "receipted-original-data";
    key: ConsentLeafOriginalKey;
  }>
> {
  const key = keySnapshot(input);
  const port = captureReadPort(sql);
  if ((await inspectSchemaWithPort(port)) !== "leaf-present") return unavailable();
  const pending = await query(port, `SELECT * FROM ${PENDING} WHERE transaction_ref=?`, [
    key.transactionRef,
  ]);
  const commands = await query(
    port,
    `SELECT * FROM ${COMMANDS} WHERE transaction_ref=? OR command_ref=? OR consent_ref=? OR receipt_ref=?`,
    [key.transactionRef, key.commandRef, key.consentRef, key.receiptRef],
  );
  const originals = await query(
    port,
    `SELECT * FROM ${ORIGINALS} WHERE transaction_ref=? OR command_ref=? OR consent_ref=? OR receipt_ref=?`,
    [key.transactionRef, key.commandRef, key.consentRef, key.receiptRef],
  );
  if (pending.length > 1 || commands.length > 1 || originals.length > 1) return custodyConflict();
  if (pending.length === 0) {
    if (commands.length || originals.length) return unavailable();
    return Object.freeze({ state: "candidate-absent", key });
  }
  const p = pending[0]!;
  if (p.registration_ref !== key.registrationRef || p.incarnation !== key.incarnation)
    return custodyConflict();
  const selectedScope = scopeSnapshot({
    organizationId: p.organization_id,
    workspaceId: p.workspace_id,
    workspaceRef: p.workspace_ref,
  });
  await checkCustodyHash(p.action_original_bytes, p.action_custody_sha256, 16384);
  await checkCustodyHash(p.terms_original_bytes, p.terms_custody_sha256, 16384);
  await checkCustodyHash(p.challenge_original_bytes, p.challenge_custody_sha256, 16384);
  if (commands.length === 0) {
    if (originals.length) return unavailable();
    return Object.freeze({ state: "pending-only", key });
  }
  const command = commands[0]!;
  if (
    !matchesKey(command, key) ||
    !matchesScope(command, selectedScope) ||
    command.family !== FAMILY
  )
    return custodyConflict();
  await checkCustodyHash(command.command_bytes, command.command_custody_sha256, 65536);
  const commandOriginal = await checkCustodyHash(
    command.original_bytes,
    command.original_custody_sha256,
    16384,
  );
  if (originals.length === 0) return Object.freeze({ state: "command-only", key });
  const original = originals[0]!;
  if (!matchesKey(original, key) || !matchesScope(original, selectedScope))
    return custodyConflict();
  const bytes = await checkCustodyHash(
    original.original_bytes,
    original.original_custody_sha256,
    16384,
  );
  if (
    bytes.byteLength !== commandOriginal.byteLength ||
    bytes.some((value, index) => value !== commandOriginal[index]) ||
    original.original_digest !== command.original_digest ||
    original.receipt_recorded_at !== original.recorded_at
  )
    return unavailable();
  return Object.freeze({ state: "receipted-original-data", key });
}

/** Actual consume callers must check this exact acknowledged INSERT RETURNING
 * postimage, in addition to genuine Root/currentness and complete command guards.
 * A caller-constructed SqlWrite passing this DATA validator has no Sql origin.
 */
export interface ConsentLeafConsumeExpected {
  readonly key: ConsentLeafOriginalKey;
  readonly selectedScope: ConsentLeafSelectedScope;
  readonly originalBytes: Uint8Array;
  readonly originalDigest: string;
  readonly originalCustodySHA256: string;
  readonly recordedAt: number;
}
export async function requireSharedAuthFinancialConsentConsumePostimage(
  result: SqlWrite,
  expected: ConsentLeafConsumeExpected,
): Promise<Readonly<{ state: "consume-postimage-data"; key: ConsentLeafOriginalKey }>> {
  const copied = exactOwn(expected, [
    "key",
    "selectedScope",
    "originalBytes",
    "originalDigest",
    "originalCustodySHA256",
    "recordedAt",
  ]);
  const key = keySnapshot(copied.key);
  const selectedScope = scopeSnapshot(copied.selectedScope);
  const expectedBytes = ownedBytes(copied.originalBytes, 16384);
  if (
    typeof copied.originalDigest !== "string" ||
    copied.originalDigest.length < 1 ||
    copied.originalDigest.length > 512 ||
    copied.originalDigest.includes("\0") ||
    typeof copied.originalCustodySHA256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(copied.originalCustodySHA256) ||
    typeof copied.recordedAt !== "number" ||
    !Number.isSafeInteger(copied.recordedAt) ||
    copied.recordedAt < 0
  )
    return unavailable();
  const write = exactOwn(result, ["changes", "rows"]);
  const rows = ownedRows(write.rows);
  if (
    write.changes !== 1 ||
    rows.length !== 1 ||
    !matchesKey(rows[0]!, key) ||
    !matchesScope(rows[0]!, selectedScope)
  )
    return unavailable();
  const row = rows[0]!;
  const bytes = await checkCustodyHash(row.original_bytes, row.original_custody_sha256, 16384);
  if (
    bytes.byteLength !== expectedBytes.byteLength ||
    bytes.some((value, index) => value !== expectedBytes[index]) ||
    row.original_digest !== copied.originalDigest ||
    row.original_custody_sha256 !== copied.originalCustodySHA256 ||
    row.recorded_at !== copied.recordedAt ||
    row.receipt_recorded_at !== copied.recordedAt ||
    typeof row.recorded_at !== "number" ||
    !Number.isSafeInteger(row.recorded_at) ||
    row.recorded_at < 0
  )
    return unavailable();
  return Object.freeze({ state: "consume-postimage-data", key });
}
