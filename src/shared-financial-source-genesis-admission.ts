import {
  FINANCIAL_0104_C0_FENCE_SCHEMA,
  FINANCIAL_0104_RECEIVER_FENCED_SCHEMA_DIGEST,
  FINANCIAL_RECEIVER_UNFENCED_SCHEMA_DIGEST,
  isFinancialMoneyFencedBatch,
} from "./financial-0104-money-fence.ts";
import { assertHostedBillingFinancialRealm } from "./hosted-billing-realm.ts";
import { canonicalDigest, canonicalJson } from "./json.ts";
import { assertMoneyCutoverSqlOrigin } from "./money-cutover-sql.ts";
import { SqlError, type SqlParam, type SqlStatement } from "./ports.ts";
import {
  canonicalFinancialSourceJson,
  type FinancialSourceDigest,
  financialSourceDigest,
  financialSourceRef,
  parseFinancialSourceRegistration,
} from "./shared-financial-source-contract.ts";
import {
  FINANCIAL_SOURCE_ENROLLMENT_SCHEMA,
  type FinancialEnrollmentComponentOptions,
  type FinancialMaterializationSource,
} from "./shared-financial-source-enrollment.ts";
import {
  FINANCIAL_GENESIS_SCHEMA,
  FINANCIAL_SOURCE_GENESIS_DDL,
} from "./shared-financial-source-genesis-schema.ts";

export { FINANCIAL_SOURCE_GENESIS_DDL };

/** Source-only historical custody. This factory is unmounted and does not qualify Core or Root. */
export interface FinancialControlGenesisOriginal {
  readonly workspaceId: string;
  readonly sourceRef: string;
  readonly incarnation: string;
  readonly registrationJson: string;
  readonly enrollmentJson: string;
  readonly identityJson: string;
  readonly enrolledAt: string;
}
export interface FinancialControlGenesisCommand {
  readonly admissionRef: string;
  readonly commandRef: string;
  readonly receiptRef: string;
  readonly enrollmentOriginal: FinancialControlGenesisOriginal;
}
export interface FinancialControlGenesisReceipt {
  readonly admissionRef: string;
  readonly commandRef: string;
  readonly receiptRef: string;
}
export class FinancialControlGenesisError extends Error {
  constructor(
    readonly code: "invalid_request" | "conflict" | "unavailable",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "FinancialControlGenesisError";
  }
}
function fail(code: FinancialControlGenesisError["code"], cause?: unknown): never {
  throw new FinancialControlGenesisError(code, cause === undefined ? undefined : { cause });
}
function ref(value: unknown): string {
  if (!financialSourceRef(value)) fail("invalid_request");
  return value;
}
function digest(value: unknown): FinancialSourceDigest {
  if (!financialSourceDigest(value)) fail("invalid_request");
  return value;
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail("invalid_request");
  return value as Record<string, unknown>;
}
function json(value: unknown): string {
  return canonicalFinancialSourceJson(value);
}
const CORE_REGISTRATION_BYTES = 16_384;
const CORE_ENROLLMENT_BYTES = 262_144;
const CORE_IDENTITY_BYTES = 262_144;
// Twice the Core raw text domain covers JSON string escaping. The remaining
// 118,656 bytes cover the bounded source and ref/framing fields; see BUDGET-AND-LAYOUT.md.
const GENESIS_RECORD_BYTES = 1_200_000;
const utf8 = (value: string) => new TextEncoder().encode(value).byteLength;
function rawText(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    utf8(value) > maximum ||
    new TextDecoder().decode(new TextEncoder().encode(value)) !== value
  )
    fail("invalid_request");
  return value;
}
/** G alone snapshots its two closed frames without the generic 16 KiB string cap. */
function closedData(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    fail("invalid_request");
  const found = Reflect.ownKeys(value);
  if (
    found.length !== keys.length ||
    found.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    fail("invalid_request");
  const captured: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("invalid_request");
    captured[key] = descriptor.value;
  }
  return captured;
}
function snapshotCommand(value: unknown): Record<string, unknown> {
  const command = closedData(value, [
    "admissionRef",
    "commandRef",
    "receiptRef",
    "enrollmentOriginal",
  ]);
  const original = closedData(command.enrollmentOriginal, [
    "workspaceId",
    "sourceRef",
    "incarnation",
    "registrationJson",
    "enrollmentJson",
    "identityJson",
    "enrolledAt",
  ]);
  command.enrollmentOriginal = {
    ...original,
    registrationJson: rawText(original.registrationJson, CORE_REGISTRATION_BYTES),
    enrollmentJson: rawText(original.enrollmentJson, CORE_ENROLLMENT_BYTES),
    identityJson: rawText(original.identityJson, CORE_IDENTITY_BYTES),
  };
  return command;
}
function genesisRecordJson(value: unknown): string {
  // value is the freshly constructed Parsed record, whose nested source was
  // captured by the unchanged generic codec and original by snapshotCommand.
  const encoded = canonicalJson(value);
  if (utf8(encoded) > GENESIS_RECORD_BYTES) fail("invalid_request");
  return encoded;
}
function snapshot(value: unknown): unknown {
  try {
    const bytes = json(value);
    if (new TextEncoder().encode(bytes).byteLength > 32768) fail("invalid_request");
    return JSON.parse(bytes);
  } catch (error) {
    if (error instanceof FinancialControlGenesisError) throw error;
    return fail("invalid_request", error);
  }
}
function parseStoredJson(value: string, maximum: number): unknown {
  rawText(value, maximum);
  try {
    return JSON.parse(value);
  } catch (error) {
    return fail("invalid_request", error);
  }
}
function iso(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail("invalid_request");
  return value;
}

/** In particular, these checks do not prove the JSON strings came from Core's retained row. */
function parseCoreOriginal(
  value: unknown,
  affectedRef: string,
  registration: ReturnType<typeof parseFinancialSourceRegistration>,
): FinancialControlGenesisOriginal {
  const original = closed(value, [
    "workspaceId",
    "sourceRef",
    "incarnation",
    "registrationJson",
    "enrollmentJson",
    "identityJson",
    "enrolledAt",
  ]);
  const workspaceId = ref(original.workspaceId),
    sourceRef = ref(original.sourceRef),
    incarnation = ref(original.incarnation);
  if (
    workspaceId !== affectedRef ||
    sourceRef !== registration.registrationRef ||
    incarnation !== registration.incarnation
  )
    fail("invalid_request");
  if (
    typeof original.registrationJson !== "string" ||
    typeof original.enrollmentJson !== "string" ||
    typeof original.identityJson !== "string"
  )
    fail("invalid_request");
  const coreRegistration = closed(
    parseStoredJson(original.registrationJson, CORE_REGISTRATION_BYTES),
    ["sourceRef", "incarnation", "genesisDigest", "requiredReceivers"],
  );
  if (
    coreRegistration.sourceRef !== sourceRef ||
    coreRegistration.incarnation !== incarnation ||
    typeof coreRegistration.genesisDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(coreRegistration.genesisDigest) ||
    `sha256:${coreRegistration.genesisDigest}` !== registration.genesisDigest ||
    !Array.isArray(coreRegistration.requiredReceivers)
  )
    fail("invalid_request");
  const converted = parseFinancialSourceRegistration({
    registrationRef: sourceRef,
    incarnation,
    genesisDigest: registration.genesisDigest,
    receivers: coreRegistration.requiredReceivers,
  });
  if (json(converted) !== json(registration)) fail("invalid_request");
  const enrollment = closed(parseStoredJson(original.enrollmentJson, CORE_ENROLLMENT_BYTES), [
    "workspace",
    "management",
    "binding",
    "members",
  ]);
  const workspace = enrollment.workspace as Record<string, unknown> | null;
  const binding = enrollment.binding as Record<string, unknown> | null;
  if (
    !workspace ||
    typeof workspace !== "object" ||
    workspace.id !== workspaceId ||
    !binding ||
    typeof binding !== "object" ||
    binding.workspaceId !== workspaceId ||
    !Array.isArray(enrollment.members) ||
    enrollment.members.length === 0 ||
    enrollment.members.length > 64
  )
    fail("invalid_request");
  const identity = closed(parseStoredJson(original.identityJson, CORE_IDENTITY_BYTES), [
    "sourceRef",
    "incarnation",
    "genesisDigest",
    "requiredReceivers",
    "workspaceId",
    "workspaceCreatedAt",
    "organizationRef",
    "workspaceRef",
    "bindingIntentId",
    "bindingJson",
    "enrolledAt",
  ]);
  if (
    identity.sourceRef !== sourceRef ||
    identity.incarnation !== incarnation ||
    identity.genesisDigest !== coreRegistration.genesisDigest ||
    json(identity.requiredReceivers) !== json(coreRegistration.requiredReceivers) ||
    identity.workspaceId !== workspaceId ||
    identity.workspaceCreatedAt !== workspace.createdAt ||
    identity.organizationRef !== binding.organizationRef ||
    identity.workspaceRef !== binding.workspaceRef ||
    identity.bindingIntentId !== binding.intentId ||
    identity.bindingJson !== JSON.stringify(binding) ||
    identity.enrolledAt !== original.enrolledAt
  )
    fail("invalid_request");
  return {
    workspaceId,
    sourceRef,
    incarnation,
    registrationJson: original.registrationJson,
    enrollmentJson: original.enrollmentJson,
    identityJson: original.identityJson,
    enrolledAt: iso(original.enrolledAt),
  };
}

/** Historical original custody only; Root's genuine Core producer and currentness are separate. */
export function createFinancialControlGenesisAdmissionStore(
  options: FinancialEnrollmentComponentOptions & {
    readonly source: FinancialMaterializationSource;
    readonly affectedRef: string;
    readonly genesisQualificationRef: string;
  },
) {
  const { sql, clock, client, realm } = options;
  assertHostedBillingFinancialRealm(realm, {
    sql,
    client,
    billingAuthority: realm.billingAuthority,
  });
  if (typeof clock !== "function") fail("unavailable");
  const writerEpoch = digest(options.writerEpoch),
    receiverRef = ref(options.receiverRef),
    targetRef = ref(options.targetRef);
  const affectedRef = ref(options.affectedRef),
    genesisQualificationRef = ref(options.genesisQualificationRef);
  const descriptor = closed(snapshot(options.source), [
    "registration",
    "registrationDigest",
    "qualificationRef",
    "sourceSchemaDigest",
    "sourceCredentialRef",
    "clockPolicyRef",
    "originRef",
  ]);
  const registration = parseFinancialSourceRegistration(descriptor.registration);
  if (
    !registration.receivers.some((p) => p.receiverRef === receiverRef && p.targetRef === targetRef)
  )
    fail("invalid_request");
  const source = {
    registration,
    registrationDigest: digest(descriptor.registrationDigest),
    qualificationRef: ref(descriptor.qualificationRef),
    sourceSchemaDigest: digest(descriptor.sourceSchemaDigest),
    sourceCredentialRef: ref(descriptor.sourceCredentialRef),
    clockPolicyRef: ref(descriptor.clockPolicyRef),
    originRef: ref(descriptor.originRef),
    accountId: realm.accountId,
    mode: realm.mode,
    billingAuthority: realm.billingAuthority,
    financialRealm: realm.financialRealm,
    writerEpoch,
    receiverRef,
    targetRef,
  };
  const sourceJson = json(source),
    registrationJson = json(registration);
  const { registrationRef, incarnation, genesisDigest } = registration;
  // G is written only inside Root's permit-framed Money writer; freeze, permit
  // and epoch are the per-table Financial 0104 money fences, not this predicate.
  const current = `EXISTS (SELECT 1 FROM stripe_mode_realm WHERE singleton=1 AND mode='test')
    AND EXISTS (SELECT 1 FROM stripe_billing_account_realms WHERE singleton=1 AND account_id=? AND mode='test' AND billing_authority=?)`;
  const currentParams: readonly SqlParam[] = [realm.accountId, realm.billingAuthority];
  const regMatch = `r.registration_ref=? AND r.incarnation=? AND r.receiver_ref=? AND r.target_ref=?
    AND r.genesis_digest=? AND r.registration_digest=? AND r.registration_json=? AND r.qualification_ref=?`;
  const regParams: readonly SqlParam[] = [
    registrationRef,
    incarnation,
    receiverRef,
    targetRef,
    genesisDigest,
    source.registrationDigest,
    registrationJson,
    source.qualificationRef,
  ];

  async function ready() {
    try {
      const complete = { ...FINANCIAL_SOURCE_ENROLLMENT_SCHEMA, ...FINANCIAL_GENESIS_SCHEMA };
      const rows = await sql.query(`SELECT name,sql FROM sqlite_schema WHERE tbl_name IN
        ('financial_preproof_challenges','financial_preproof_challenge_receipts','financial_source_materializations',
         'financial_source_materialization_receipts','financial_source_genesis_admissions','financial_source_genesis_admission_receipts')
        AND sql IS NOT NULL ORDER BY name`);
      // Exactly the complete overlay, or exactly it plus every 0104 C0/M/G fence.
      const fenced = rows.some(
        (r) => typeof r.name === "string" && Object.hasOwn(FINANCIAL_0104_C0_FENCE_SCHEMA, r.name),
      );
      const expected: Readonly<Record<string, string>> = fenced
        ? { ...complete, ...FINANCIAL_0104_C0_FENCE_SCHEMA }
        : complete;
      if (
        rows.length !== Object.keys(expected).length ||
        rows.some((r) => typeof r.name !== "string" || r.sql !== expected[r.name])
      )
        fail("unavailable");
      const receiverRows =
        await sql.query(`SELECT type,name,sql FROM sqlite_schema WHERE tbl_name IN
        ('financial_source_registrations','financial_source_heads','financial_source_events','financial_source_receipts') AND sql IS NOT NULL ORDER BY type,name`);
      if (
        (await canonicalDigest(receiverRows)) !==
        (fenced
          ? FINANCIAL_0104_RECEIVER_FENCED_SCHEMA_DIGEST
          : FINANCIAL_RECEIVER_UNFENCED_SCHEMA_DIGEST)
      )
        fail("unavailable");
    } catch (error) {
      if (error instanceof FinancialControlGenesisError) throw error;
      fail("unavailable", error);
    }
  }
  function parse(input: unknown) {
    const c = snapshotCommand(input);
    const enrollmentOriginal = parseCoreOriginal(c.enrollmentOriginal, affectedRef, registration);
    const command = {
      admissionRef: ref(c.admissionRef),
      commandRef: ref(c.commandRef),
      receiptRef: ref(c.receiptRef),
      enrollmentOriginal,
    };
    const saved = { ...command, source, affectedRef, genesisQualificationRef };
    genesisRecordJson(saved);
    return saved;
  }
  type Parsed = ReturnType<typeof parse>;
  async function original(saved: Parsed): Promise<FinancialControlGenesisReceipt | undefined> {
    const recordJson = genesisRecordJson(saved);
    const roots = await sql.query(
      `SELECT g.admission_ref,g.command_ref,g.receipt_ref,g.registration_ref,g.incarnation,g.affected_ref,
      g.source_json,g.genesis_qualification_ref,g.created_at,g.record_json=? AS record_matches,
      q.receipt_ref AS sealed_receipt,q.record_json=g.record_json AS sealed_record_matches,q.all_rows_match,
      h.created_at AS head_created,h.genesis_qualification_ref AS head_genesis,
      r.registration_json,r.registration_digest,r.genesis_digest,r.qualification_ref,r.receiver_ref,r.target_ref
      FROM financial_source_genesis_admissions g
      LEFT JOIN financial_source_genesis_admission_receipts q ON q.admission_ref=g.admission_ref
      LEFT JOIN financial_source_heads h ON h.registration_ref=g.registration_ref AND h.incarnation=g.incarnation AND h.affected_ref=g.affected_ref
      LEFT JOIN financial_source_registrations r ON r.registration_ref=g.registration_ref AND r.incarnation=g.incarnation
      WHERE g.admission_ref=? OR g.command_ref=? OR g.receipt_ref=?
      OR (g.registration_ref=? AND g.incarnation=?)`,
      [
        recordJson,
        saved.admissionRef,
        saved.commandRef,
        saved.receiptRef,
        registrationRef,
        incarnation,
      ],
    );
    const receipts = await sql.query(
      `SELECT receipt_ref,admission_ref,command_ref,registration_ref,incarnation,affected_ref,
      source_json,all_rows_match,record_json=? AS record_matches FROM financial_source_genesis_admission_receipts
      WHERE receipt_ref=? OR admission_ref=? OR command_ref=? OR (registration_ref=? AND incarnation=?)`,
      [
        recordJson,
        saved.receiptRef,
        saved.admissionRef,
        saved.commandRef,
        registrationRef,
        incarnation,
      ],
    );
    const m = await sql.query(
      `SELECT materialization_ref FROM financial_source_materializations
      WHERE command_ref=? OR json_extract(record_json,'$.receiptRef')=? OR (registration_ref=? AND incarnation=?)`,
      [saved.commandRef, saved.receiptRef, registrationRef, incarnation],
    );
    const mq = await sql.query(
      `SELECT receipt_ref FROM financial_source_materialization_receipts
      WHERE command_ref=? OR receipt_ref=? OR (registration_ref=? AND incarnation=? AND affected_ref=?)`,
      [saved.commandRef, saved.receiptRef, registrationRef, incarnation, affectedRef],
    );
    if (m.length || mq.length) fail("conflict");
    if (roots.length === 0) {
      if (receipts.length) fail("unavailable");
      const occupied = await sql.query(
        `SELECT
        EXISTS(SELECT 1 FROM financial_source_heads WHERE registration_ref=? AND incarnation=?) AS head,
        EXISTS(SELECT 1 FROM financial_source_registrations WHERE registration_ref=? AND incarnation=?) AS registration`,
        [registrationRef, incarnation, registrationRef, incarnation],
      );
      if (occupied.length !== 1 || occupied[0]?.head !== 0 || occupied[0]?.registration !== 0)
        fail("unavailable");
      return undefined;
    }
    const row = roots[0],
      receipt = receipts[0];
    if (
      roots.length !== 1 ||
      row?.record_matches !== 1 ||
      row?.source_json !== sourceJson ||
      row?.admission_ref !== saved.admissionRef ||
      row?.command_ref !== saved.commandRef ||
      row?.receipt_ref !== saved.receiptRef ||
      row?.registration_ref !== registrationRef ||
      row?.incarnation !== incarnation ||
      row?.affected_ref !== affectedRef
    )
      fail("conflict");
    if (
      receipts.length !== 1 ||
      !receipt ||
      receipt.receipt_ref !== saved.receiptRef ||
      receipt.admission_ref !== saved.admissionRef ||
      receipt.command_ref !== saved.commandRef ||
      receipt.registration_ref !== registrationRef ||
      receipt.incarnation !== incarnation ||
      receipt.affected_ref !== affectedRef ||
      receipt.source_json !== sourceJson ||
      receipt.record_matches !== 1 ||
      receipt.all_rows_match !== 1 ||
      row.sealed_receipt !== saved.receiptRef ||
      row.sealed_record_matches !== 1 ||
      row.all_rows_match !== 1 ||
      row.genesis_qualification_ref !== genesisQualificationRef ||
      row.head_created !== row.created_at ||
      row.head_genesis !== genesisQualificationRef ||
      row.registration_json !== registrationJson ||
      row.registration_digest !== source.registrationDigest ||
      row.genesis_digest !== genesisDigest ||
      row.qualification_ref !== source.qualificationRef ||
      row.receiver_ref !== receiverRef ||
      row.target_ref !== targetRef
    )
      fail("unavailable");
    return {
      admissionRef: saved.admissionRef,
      commandRef: saved.commandRef,
      receiptRef: saved.receiptRef,
    };
  }
  async function readGenesisOriginal(
    input: FinancialControlGenesisCommand,
  ): Promise<FinancialControlGenesisReceipt | undefined> {
    let saved: Parsed;
    try {
      saved = parse(input);
    } catch (error) {
      return fail("invalid_request", error);
    }
    try {
      await ready();
      return await original(saved);
    } catch (error) {
      if (error instanceof FinancialControlGenesisError) throw error;
      return fail("unavailable", error);
    }
  }
  async function admitGenesis(
    input: FinancialControlGenesisCommand,
  ): Promise<FinancialControlGenesisReceipt> {
    // Same epoch binding as R1: only Root's Money writer for exactly the
    // configured writer epoch, checked before any statement is built or sent.
    try {
      assertMoneyCutoverSqlOrigin(sql, { writerEpoch });
    } catch (error) {
      return fail("unavailable", error);
    }
    let saved: Parsed;
    try {
      saved = parse(input);
    } catch (error) {
      return fail("invalid_request", error);
    }
    try {
      await ready();
      const prior = await original(saved);
      if (prior) return prior;
      let at: string;
      try {
        at = iso(clock().toISOString());
      } catch (error) {
        return fail("unavailable", error);
      }
      const recordJson = genesisRecordJson(saved);
      const statements: readonly SqlStatement[] = [
        {
          sql: `INSERT INTO financial_source_genesis_admissions(admission_ref,command_ref,receipt_ref,registration_ref,incarnation,affected_ref,source_json,record_json,genesis_qualification_ref,created_at)
          SELECT ?,?,?,?,?,?,?,?,?,? WHERE (${current}) AND NOT EXISTS(SELECT 1 FROM financial_source_registrations WHERE registration_ref=? AND incarnation=?)`,
          params: [
            saved.admissionRef,
            saved.commandRef,
            saved.receiptRef,
            registrationRef,
            incarnation,
            affectedRef,
            sourceJson,
            recordJson,
            genesisQualificationRef,
            at,
            ...currentParams,
            registrationRef,
            incarnation,
          ],
        },
        {
          sql: `INSERT INTO financial_source_registrations(registration_ref,incarnation,receiver_ref,target_ref,genesis_digest,registration_digest,registration_json,qualification_ref,registered_at)
          SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM financial_source_genesis_admissions WHERE admission_ref=? AND record_json=?)
          AND NOT EXISTS(SELECT 1 FROM financial_source_registrations WHERE registration_ref=? AND incarnation=?)`,
          params: [...regParams, at, saved.admissionRef, recordJson, registrationRef, incarnation],
        },
        {
          sql: `INSERT INTO financial_source_heads(registration_ref,incarnation,affected_ref,genesis_qualification_ref,created_at,sequence,event_digest,state,last_event_ref,updated_at)
          SELECT ?,?,?,?,?,0,?,'active',NULL,? WHERE EXISTS(SELECT 1 FROM financial_source_genesis_admissions WHERE admission_ref=? AND record_json=?)
          AND EXISTS(SELECT 1 FROM financial_source_registrations r WHERE ${regMatch} AND r.retired_at IS NULL)`,
          params: [
            registrationRef,
            incarnation,
            affectedRef,
            genesisQualificationRef,
            at,
            genesisDigest,
            at,
            saved.admissionRef,
            recordJson,
            ...regParams,
          ],
        },
        {
          sql: `INSERT INTO financial_source_genesis_admission_receipts(receipt_ref,admission_ref,command_ref,registration_ref,incarnation,affected_ref,source_json,record_json,all_rows_match)
          VALUES(?,?,?,?,?,?,?,?,CASE WHEN changes()=1 AND (${current}) AND EXISTS(
            SELECT 1 FROM financial_source_genesis_admissions g JOIN financial_source_registrations r
              ON r.registration_ref=g.registration_ref AND r.incarnation=g.incarnation
            JOIN financial_source_heads h ON h.registration_ref=g.registration_ref AND h.incarnation=g.incarnation AND h.affected_ref=g.affected_ref
            WHERE g.admission_ref=? AND g.command_ref=? AND g.receipt_ref=? AND g.record_json=? AND g.source_json=?
            AND ${regMatch} AND r.retired_at IS NULL AND h.affected_ref=? AND h.sequence=0 AND h.event_digest=r.genesis_digest
            AND h.last_event_ref IS NULL AND h.state='active' AND h.genesis_qualification_ref=? AND h.created_at=g.created_at)
            THEN 1 ELSE 0 END)`,
          params: [
            saved.receiptRef,
            saved.admissionRef,
            saved.commandRef,
            registrationRef,
            incarnation,
            affectedRef,
            sourceJson,
            recordJson,
            ...currentParams,
            saved.admissionRef,
            saved.commandRef,
            saved.receiptRef,
            recordJson,
            sourceJson,
            ...regParams,
            affectedRef,
            genesisQualificationRef,
          ],
        },
      ];
      // Every G statement writes a 0104 money-fenced table; nothing else is built.
      if (!isFinancialMoneyFencedBatch(statements)) fail("unavailable");
      try {
        await sql.batch(statements);
      } catch (error) {
        const recovered = await original(saved);
        if (recovered) return recovered;
        if (error instanceof SqlError && error.code === "constraint") fail("conflict", error);
        fail("unavailable", error);
      }
      const committed = await original(saved);
      if (!committed) fail("unavailable");
      return committed;
    } catch (error) {
      if (error instanceof FinancialControlGenesisError) throw error;
      return fail("unavailable", error);
    }
  }
  return Object.freeze({ admitGenesis, readGenesisOriginal });
}
