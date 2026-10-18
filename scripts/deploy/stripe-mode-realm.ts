import {
  hasImmutableStripeModeRealmSchema,
  type StripeMode,
  type StripeModeRealmSchemaRow,
} from "../../src/stripe-mode-realm.ts";

export interface StripeModeRealmRead {
  readonly schema: readonly StripeModeRealmSchemaRow[];
  readonly pins: readonly { readonly mode: unknown }[];
}

export interface StripeModeRealmStatus {
  readonly ready: boolean;
  readonly selectedMode: StripeMode;
  readonly pinnedMode: StripeMode | null;
  readonly reason: "unsafe_schema" | "not_pinned" | "mode_mismatch" | null;
}

/** Validate the read-only row and immutable 0098 trigger proof from the selected D1. */
export function inspectStripeModeRealm(
  proof: StripeModeRealmRead,
  selectedMode: StripeMode,
): StripeModeRealmStatus {
  if (!hasImmutableStripeModeRealmSchema(proof.schema)) {
    return { ready: false, selectedMode, pinnedMode: null, reason: "unsafe_schema" };
  }
  const pinnedMode = proof.pins.length === 1 ? proof.pins[0]?.mode : undefined;
  if (pinnedMode !== "test" && pinnedMode !== "live") {
    return { ready: false, selectedMode, pinnedMode: null, reason: "not_pinned" };
  }
  if (pinnedMode !== selectedMode) {
    return {
      ready: false,
      selectedMode,
      pinnedMode,
      reason: "mode_mismatch",
    };
  }
  return { ready: true, selectedMode, pinnedMode, reason: null };
}

// This import must resolve to the same Root owner module instance that minted
// the held context. The private source packet does not apply that Root module.
import {
  assertMoneyUnitHeldConvertCurrent,
  assertMoneyUnitHeldNormalWorkerModePreparationCurrent,
  type MoneyHeldNormalWorkerModeFacts,
  type MoneyUnitHeldConvertContext,
  type MoneyUnitHeldConvertFacts,
  type MoneyUnitHeldNormalWorkerModePreparation,
} from "@takoserver/core/deploy-extension";
import {
  MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE,
  MONEY_CUTOVER_EPOCH,
  MONEY_CUTOVER_PERMIT_TABLE,
  MONEY_CUTOVER_WRITER_EPOCH_PATTERN,
} from "../../src/money-cutover-sql.ts";
import {
  STRIPE_REALM_AMBIGUOUS_HISTORY_TABLES,
  STRIPE_REALM_FINANCIAL_HISTORY_QUERY,
} from "../../src/stripe-mode-realm.ts";

export type MoneyRealmTableClass =
  | "known_financial"
  | "unknown_financial_prefix"
  | "control_unqualified"
  | "outside_vocabulary";

export interface MoneyRealmTableObservation {
  readonly name: string;
  readonly rows: number;
  readonly classification: MoneyRealmTableClass;
}

export interface MoneyRealmCensusTotals {
  readonly tables: number;
  readonly rows: number;
  readonly nonzeroTables: number;
}

export interface MoneyRealmCensusAssessment {
  readonly observations: readonly MoneyRealmTableObservation[];
  readonly totals: Readonly<Record<MoneyRealmTableClass, MoneyRealmCensusTotals>>;
}

const MONEY_REALM_PREFIXES = [
  "stripe_",
  "wallet_",
  "org_wallet_",
  "money_",
  "usage_",
  "reseller_settlement_",
  "provider_meter_",
  "sponsorship_",
] as const;
const MONEY_REALM_CONTROLS = new Set(["stripe_mode_realm", "money_unit_policy"]);
const MONEY_REALM_KNOWN = new Set<string>([
  ...STRIPE_REALM_AMBIGUOUS_HISTORY_TABLES,
  // Exact additional 0092 Financial write table in the pinned actual
  // MONEY_CUTOVER_FINANCIAL_TABLES source. No prefix or name-pattern exemption.
  "sponsorship_credential_issuance_operations",
  // Exact Financial tables introduced by canonical0047, not a prefix exemption.
  // Zero is DATA only; existing original/converted/current nonzero refusals apply.
  "sponsorship_cutover_operation_starts",
  "sponsorship_cutover_operation_completions",
]);
const MONEY_REALM_SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MONEY_REALM_CLASSES: readonly MoneyRealmTableClass[] = [
  "known_financial",
  "unknown_financial_prefix",
  "control_unqualified",
  "outside_vocabulary",
];

/** A redacted error at the wrapper boundary; the original error remains its cause. */
export class MoneyRealmDiagnosticError extends Error {
  constructor(cause: unknown) {
    super("Financial realm diagnostic is unavailable", { cause });
    this.name = "MoneyRealmDiagnosticError";
  }
}

function moneyRealmCensusError(): Error {
  return new Error("Financial realm census is malformed");
}

function moneyRealmPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function moneyRealmOwnData(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor)) throw moneyRealmCensusError();
  return descriptor.value;
}

function moneyRealmAdd(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw moneyRealmCensusError();
  return sum;
}

/**
 * Data-only classification of an already supplied complete table census.
 * An unknown name remains unclassified even when its row count is zero.
 * This function has no authority to decide history freedom or source mode.
 */
export function classifyMoneyD1StripeRealmCensus(census: unknown): MoneyRealmCensusAssessment {
  if (!moneyRealmPlainRecord(census)) throw moneyRealmCensusError();
  const inventory = moneyRealmOwnData(census, "tableInventory");
  const counts = moneyRealmOwnData(census, "rowCounts");
  if (!Array.isArray(inventory) || Object.getPrototypeOf(inventory) !== Array.prototype)
    throw moneyRealmCensusError();
  if (!moneyRealmPlainRecord(counts)) throw moneyRealmCensusError();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(inventory, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  )
    throw moneyRealmCensusError();
  const length = lengthDescriptor.value as number;
  const inventoryKeys = Reflect.ownKeys(inventory);
  if (
    inventoryKeys.length !== length + 1 ||
    inventoryKeys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length),
    )
  )
    throw moneyRealmCensusError();
  const countKeys = Reflect.ownKeys(counts);
  if (countKeys.length !== length || countKeys.some((key) => typeof key !== "string"))
    throw moneyRealmCensusError();

  const totals: Record<MoneyRealmTableClass, MoneyRealmCensusTotals> = {
    known_financial: { tables: 0, rows: 0, nonzeroTables: 0 },
    unknown_financial_prefix: { tables: 0, rows: 0, nonzeroTables: 0 },
    control_unqualified: { tables: 0, rows: 0, nonzeroTables: 0 },
    outside_vocabulary: { tables: 0, rows: 0, nonzeroTables: 0 },
  };
  const observations: MoneyRealmTableObservation[] = [];
  let previous = "";
  const seenFolded = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(inventory, String(index));
    if (item === undefined || !("value" in item) || typeof item.value !== "string")
      throw moneyRealmCensusError();
    const name = item.value;
    if (!MONEY_REALM_SAFE_NAME.test(name) || (index > 0 && previous >= name))
      throw moneyRealmCensusError();
    const folded = name.toLowerCase();
    if (seenFolded.has(folded)) throw moneyRealmCensusError();
    seenFolded.add(folded);
    previous = name;
    const rows = moneyRealmOwnData(counts, name);
    if (typeof rows !== "number" || !Number.isSafeInteger(rows) || rows < 0)
      throw moneyRealmCensusError();
    let classification: MoneyRealmTableClass;
    if (MONEY_REALM_CONTROLS.has(folded)) classification = "control_unqualified";
    else if (MONEY_REALM_KNOWN.has(folded)) classification = "known_financial";
    else if (MONEY_REALM_PREFIXES.some((prefix) => folded.startsWith(prefix)))
      classification = "unknown_financial_prefix";
    else classification = "outside_vocabulary";
    const prior = totals[classification];
    totals[classification] = {
      tables: moneyRealmAdd(prior.tables, 1),
      rows: moneyRealmAdd(prior.rows, rows),
      nonzeroTables: moneyRealmAdd(prior.nonzeroTables, rows > 0 ? 1 : 0),
    };
    observations.push(Object.freeze({ name, rows, classification }));
  }
  if (
    countKeys.some(
      (key) =>
        !seenFolded.has(String(key).toLowerCase()) ||
        !observations.some((item) => item.name === key),
    )
  )
    throw moneyRealmCensusError();
  for (const kind of MONEY_REALM_CLASSES) Object.freeze(totals[kind]);
  return Object.freeze({
    observations: Object.freeze(observations),
    totals: Object.freeze(totals),
  });
}

/** Fixed 0094 source tables that feed both preserved-preimage and aggregate checks. */
const MONEY_REALM_PREIMAGE_SOURCES = [
  "ledger",
  "wallet_credit_lots",
  "wallet_credit_allocations",
  "org_wallet_holds",
  "org_wallet_usage_records",
  "org_wallet_grant_snapshots",
  "org_wallet_monthly_tariffs",
] as const;
const MONEY_REALM_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export type MoneyRealmNamedArtifact =
  | "money_cutover_preimage"
  | "money_cutover_aggregates"
  | "wallet_credit_lot_classification_proofs"
  | "money_cutover_freeze"
  | typeof MONEY_CUTOVER_PERMIT_TABLE
  | typeof MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE
  | "money_unit_policy";

export interface MoneyRealmNamedArtifactFinding {
  readonly artifact: MoneyRealmNamedArtifact;
  readonly currentRows: number | null;
  /** A data observation under Root's two assertions, never a serving decision. */
  readonly sourceEvidence: "consistent_with_fixed_root_checks" | "not_established";
}

function moneyRealmObservedRows(
  census: MoneyRealmCensusAssessment,
  name: string,
): number | undefined {
  return census.observations.find((item) => item.name === name)?.rows;
}

/**
 * Called only inside the genuine Root assertion bracket. Existing Root v4 checks
 * exact source imports, tuple digests, classifications, freeze and live backup.
 * Named findings never exempt another table or produce a pin/permit.
 */
function moneyRealmFixedArtifactFindings(
  facts: MoneyUnitHeldConvertContext["facts"],
  original92: MoneyRealmCensusAssessment,
  converted94: MoneyRealmCensusAssessment,
  current94: MoneyRealmCensusAssessment,
): readonly MoneyRealmNamedArtifactFinding[] {
  const zeroPreimageSources = MONEY_REALM_PREIMAGE_SOURCES.every(
    (table) => moneyRealmObservedRows(original92, table) === 0,
  );
  const zeroKnownOrigin = original92.totals.known_financial.rows === 0;
  const evidence = (
    artifact: MoneyRealmNamedArtifact,
    matched: boolean,
  ): MoneyRealmNamedArtifactFinding => {
    const currentRows = moneyRealmObservedRows(current94, artifact);
    const sourceEvidence: MoneyRealmNamedArtifactFinding["sourceEvidence"] = matched
      ? "consistent_with_fixed_root_checks"
      : "not_established";
    return Object.freeze({ artifact, currentRows: currentRows ?? null, sourceEvidence });
  };
  const conserved = (
    artifact: MoneyRealmNamedArtifact,
    digestOriginal: string,
    digestConverted: string,
  ): MoneyRealmNamedArtifactFinding => {
    const currentRows = moneyRealmObservedRows(current94, artifact);
    const convertedRows = moneyRealmObservedRows(converted94, artifact);
    return evidence(
      artifact,
      zeroKnownOrigin &&
        zeroPreimageSources &&
        currentRows === 0 &&
        convertedRows === 0 &&
        MONEY_REALM_DIGEST.test(digestOriginal) &&
        digestOriginal === digestConverted,
    );
  };
  const preimage = conserved(
    "money_cutover_preimage",
    facts.original92.preimageDigest,
    facts.converted94.preimageDigest,
  );
  const aggregates = conserved(
    "money_cutover_aggregates",
    facts.original92.aggregateDigest,
    facts.converted94.aggregateDigest,
  );
  const classificationRows = facts.conversion.classifications.length;
  const classifications = evidence(
    "wallet_credit_lot_classification_proofs",
    zeroKnownOrigin &&
      moneyRealmObservedRows(original92, "wallet_credit_lots") === 0 &&
      classificationRows === 0 &&
      moneyRealmObservedRows(converted94, "wallet_credit_lot_classification_proofs") ===
        classificationRows &&
      moneyRealmObservedRows(current94, "wallet_credit_lot_classification_proofs") ===
        classificationRows &&
      MONEY_REALM_DIGEST.test(facts.conversion.classificationDigest),
  );
  const freeze = evidence(
    "money_cutover_freeze",
    moneyRealmObservedRows(converted94, "money_cutover_freeze") === 1 &&
      moneyRealmObservedRows(current94, "money_cutover_freeze") === 1 &&
      MONEY_REALM_DIGEST.test(facts.conversion.freezeBindingDigest) &&
      facts.current94.freezeBindingDigest === facts.conversion.freezeBindingDigest,
  );
  const permit = evidence(
    MONEY_CUTOVER_PERMIT_TABLE,
    moneyRealmObservedRows(converted94, MONEY_CUTOVER_PERMIT_TABLE) === 0 &&
      moneyRealmObservedRows(current94, MONEY_CUTOVER_PERMIT_TABLE) === 0,
  );
  const authorizedEpoch = evidence(
    MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE,
    moneyRealmObservedRows(converted94, MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE) === 1 &&
      moneyRealmObservedRows(current94, MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE) === 1 &&
      MONEY_CUTOVER_WRITER_EPOCH_PATTERN.test(facts.previousWriterEpoch) &&
      facts.current94.authorizedWriterEpoch === facts.previousWriterEpoch,
  );
  // The public guard knows the expected policy tuple, but the held Root reader
  // does not invoke it or return the row. Count alone cannot authenticate value.
  const policy = evidence("money_unit_policy", false);
  return Object.freeze([
    preimage,
    aggregates,
    classifications,
    freeze,
    permit,
    authorizedEpoch,
    policy,
  ]);
}

/** A recognized value is DATA only, never a Root-observed row or policy proof. */
export type MoneyRealmPolicyTupleDataAssessment = Readonly<{
  scope: "financial-policy-tuple-data-only";
}> &
  (
    | Readonly<{
        classification: "expected_tuple_data";
        tuple: Readonly<{
          singleton: 1;
          ledger_unit: typeof MONEY_CUTOVER_EPOCH;
          historical_usage_unit: "microcent-v1";
          cash_unit: "usd-cents-v1";
        }>;
      }>
    | Readonly<{ classification: "refused"; tuple: null }>
  );

/** Classifies exactly one closed own-data row. No getter or inherited value is read. */
export function classifyMoneyD1StripeRealmPolicyTupleData(
  rows: unknown,
): MoneyRealmPolicyTupleDataAssessment {
  const refused = (): MoneyRealmPolicyTupleDataAssessment =>
    Object.freeze({
      scope: "financial-policy-tuple-data-only",
      classification: "refused",
      tuple: null,
    });
  try {
    if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype) return refused();
    const keys = Reflect.ownKeys(rows);
    const length = Object.getOwnPropertyDescriptor(rows, "length");
    const member = Object.getOwnPropertyDescriptor(rows, "0");
    if (
      keys.length !== 2 ||
      !keys.includes("length") ||
      !keys.includes("0") ||
      !length ||
      !("value" in length) ||
      length.value !== 1 ||
      !member ||
      !("value" in member) ||
      member.enumerable !== true ||
      !moneyRealmPlainRecord(member.value)
    )
      return refused();
    const fields = ["singleton", "ledger_unit", "historical_usage_unit", "cash_unit"] as const;
    const row = member.value;
    const rowKeys = Reflect.ownKeys(row);
    if (
      rowKeys.length !== fields.length ||
      rowKeys.some((key) => typeof key !== "string" || !fields.some((field) => field === key))
    )
      return refused();
    const values: unknown[] = [];
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(row, field);
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true)
        return refused();
      values.push(descriptor.value);
    }
    if (
      values[0] !== 1 ||
      values[1] !== MONEY_CUTOVER_EPOCH ||
      values[2] !== "microcent-v1" ||
      values[3] !== "usd-cents-v1"
    )
      return refused();
    return Object.freeze({
      scope: "financial-policy-tuple-data-only",
      classification: "expected_tuple_data",
      tuple: Object.freeze({
        singleton: 1,
        ledger_unit: MONEY_CUTOVER_EPOCH,
        historical_usage_unit: "microcent-v1",
        cash_unit: "usd-cents-v1",
      }),
    });
  } catch {
    return refused();
  }
}

export interface MoneyRealmPolicyTuplePredicateData {
  readonly scope: "financial-policy-tuple-predicate-data-only";
  readonly sql: string;
  readonly params: readonly [1, typeof MONEY_CUTOVER_EPOCH, "microcent-v1", "usd-cents-v1"];
}

/** Fixed expression DATA, not an executable batch, observed tuple or mandatory rollback.
 * A future owning ONE must embed this expression and enforce false/NULL as failure. */
export function buildMoneyD1StripeRealmPolicyTuplePredicateData(
  ...input: never[]
): MoneyRealmPolicyTuplePredicateData {
  if (input.length !== 0) throw new TypeError("Financial policy predicate accepts no input");
  return Object.freeze({
    scope: "financial-policy-tuple-predicate-data-only",
    sql: `((SELECT count(*) FROM money_unit_policy) = 1 AND EXISTS (
      SELECT 1 FROM money_unit_policy
      WHERE typeof(singleton) = 'integer' AND singleton IS ?
        AND typeof(ledger_unit) = 'text' AND ledger_unit IS ?
        AND typeof(historical_usage_unit) = 'text' AND historical_usage_unit IS ?
        AND typeof(cash_unit) = 'text' AND cash_unit IS ?))`,
    params: Object.freeze([1, MONEY_CUTOVER_EPOCH, "microcent-v1", "usd-cents-v1"] as const),
  });
}

export type MoneyRealmUnresolvedReason =
  | "original92_financial_rows"
  | "original92_unknown_financial_prefix"
  | "original92_outside_vocabulary"
  | "original92_control_rows_unqualified"
  | "current94_financial_rows_unbound"
  | "current94_unknown_financial_prefix"
  | "current94_outside_vocabulary"
  | "current94_control_rows_unbound"
  | "normal_worker_test_mode_unproven";

export interface MoneyRealmTransitionDiagnostic {
  readonly original92: Readonly<Record<MoneyRealmTableClass, MoneyRealmCensusTotals>>;
  readonly current94: Readonly<Record<MoneyRealmTableClass, MoneyRealmCensusTotals>>;
  readonly namedArtifacts: readonly MoneyRealmNamedArtifactFinding[];
  readonly unresolved: readonly MoneyRealmUnresolvedReason[];
}

/** Authenticated observation only; it cannot prepare a pin or grant serving. */
export async function inspectMoneyD1StripeRealmTransition(
  context: unknown,
): Promise<MoneyRealmTransitionDiagnostic> {
  try {
    await assertMoneyUnitHeldConvertCurrent(context);
    const held = context as MoneyUnitHeldConvertContext;
    if (held.kind !== "takoserver.money-held-convert-context@v1") throw moneyRealmCensusError();
    const original92 = classifyMoneyD1StripeRealmCensus(held.facts.original92);
    const converted94 = classifyMoneyD1StripeRealmCensus(held.facts.converted94);
    const current94 = classifyMoneyD1StripeRealmCensus(held.facts.current94);
    const namedArtifacts = moneyRealmFixedArtifactFindings(
      held.facts,
      original92,
      converted94,
      current94,
    );
    const unresolved: MoneyRealmUnresolvedReason[] = [];
    if (original92.totals.known_financial.rows > 0) unresolved.push("original92_financial_rows");
    if (original92.totals.unknown_financial_prefix.tables > 0)
      unresolved.push("original92_unknown_financial_prefix");
    if (original92.totals.outside_vocabulary.tables > 0)
      unresolved.push("original92_outside_vocabulary");
    if (original92.totals.control_unqualified.rows > 0)
      unresolved.push("original92_control_rows_unqualified");
    if (current94.totals.known_financial.rows > 0)
      unresolved.push("current94_financial_rows_unbound");
    if (current94.totals.unknown_financial_prefix.tables > 0)
      unresolved.push("current94_unknown_financial_prefix");
    if (current94.totals.outside_vocabulary.tables > 0)
      unresolved.push("current94_outside_vocabulary");
    if (current94.totals.control_unqualified.rows > 0)
      unresolved.push("current94_control_rows_unbound");
    unresolved.push("normal_worker_test_mode_unproven");
    await assertMoneyUnitHeldConvertCurrent(context);
    return Object.freeze({
      original92: original92.totals,
      current94: current94.totals,
      namedArtifacts,
      unresolved: Object.freeze(unresolved),
    });
  } catch (cause) {
    throw new MoneyRealmDiagnosticError(cause);
  }
}

export type MoneyRealmHistoryDataRefusal =
  | "original92_required_source_missing"
  | "original92_financial_rows"
  | "original92_unknown_financial_prefix"
  | "original92_control_rows_unqualified"
  | "converted94_unknown_financial_prefix"
  | "current94_unknown_financial_prefix"
  | "converted94_financial_rows_unbound"
  | "current94_financial_rows_unbound"
  | "pre_suffix_realm_table_present"
  | "policy_row_count_unexpected"
  | "fixed_conversion_artifact_unbound"
  | "original_conversion_lineage_differs"
  | "protected_current_census_differs";

export interface MoneyRealmHistoryDataAssessment {
  /** Source predicates over supplied DATA; these strings are never capabilities. */
  readonly zeroOrigin: "source_predicates_satisfied" | "refused";
  /** The policy tuple is deliberately a separate, unresolved obligation. */
  readonly convertedHistoryExceptPolicy: "source_predicates_satisfied" | "refused";
  readonly policyTuple: "not_established";
  readonly census: Readonly<{
    original92: MoneyRealmCensusAssessment;
    converted94: MoneyRealmCensusAssessment;
    current94: MoneyRealmCensusAssessment;
  }>;
  readonly namedArtifacts: readonly MoneyRealmNamedArtifactFinding[];
  readonly refusals: readonly MoneyRealmHistoryDataRefusal[];
}

/**
 * Pure Financial policy calculation for the fixed Root fact fields. A caller's
 * synthetic DATA can exercise these predicates but cannot authenticate a census,
 * its completeness, physical origin, mode, or any dispatch. The context-taking
 * preparation below is the only consumer that authenticates those observations.
 *
 * All observed tables are classified. Absence from an authenticated phase's
 * complete schema is not a synthetic zero row count: the seven actual preimage
 * sources must be present; the closed 45-name vocabulary (public42, one issuance
 * table and two canonical0047 operation tables) spans several schema phases.
 * Each phase retains its actual complete observed inventory; 45 is not a floor.
 * Root checks the complete exact 0092/0094 schema and full typed row bytes.
 * Non-Financial tables (for example principals) are retained in this assessment;
 * their rows do not become Financial history. Unknown Financial-prefix tables
 * refuse even at zero, except the exact, evidenced current conversion controls.
 */
export function assessMoneyD1StripeRealmHistoryData(
  facts: MoneyUnitHeldConvertContext["facts"],
): MoneyRealmHistoryDataAssessment {
  const original92 = classifyMoneyD1StripeRealmCensus(facts.original92);
  const converted94 = classifyMoneyD1StripeRealmCensus(facts.converted94);
  const current94 = classifyMoneyD1StripeRealmCensus(facts.current94);
  const namedArtifacts = moneyRealmFixedArtifactFindings(facts, original92, converted94, current94);
  const refusals = new Set<MoneyRealmHistoryDataRefusal>();
  const refuse = (reason: MoneyRealmHistoryDataRefusal) => {
    refusals.add(reason);
  };
  if (
    MONEY_REALM_PREIMAGE_SOURCES.some(
      (name) => moneyRealmObservedRows(original92, name) === undefined,
    )
  )
    refuse("original92_required_source_missing");
  if (original92.totals.known_financial.rows !== 0) refuse("original92_financial_rows");
  if (original92.totals.unknown_financial_prefix.tables !== 0)
    refuse("original92_unknown_financial_prefix");
  if (original92.totals.control_unqualified.rows !== 0)
    refuse("original92_control_rows_unqualified");

  // Whole protected/current equality is necessary, never sufficient by itself:
  // the bounded original->conversion predicates below also have to match.
  if (
    !MONEY_REALM_DIGEST.test(facts.converted94.allDataDigest) ||
    facts.converted94.allDataDigest !== facts.current94.allDataDigest ||
    JSON.stringify(converted94.observations) !== JSON.stringify(current94.observations)
  )
    refuse("protected_current_census_differs");
  const conversion = facts.conversion;
  const retainedPhases = ["freeze", "prepare", "classify", "convert"];
  const convert = conversion.retained[3];
  if (
    facts.schemaPhase !== "0094-fenced" ||
    !MONEY_REALM_DIGEST.test(facts.original92.backupDigest) ||
    !MONEY_REALM_DIGEST.test(facts.original92.identityDigest) ||
    !MONEY_REALM_DIGEST.test(facts.original92.allDataDigest) ||
    !MONEY_REALM_DIGEST.test(facts.original92.sourceDigest) ||
    !MONEY_REALM_DIGEST.test(facts.converted94.backupDigest) ||
    !MONEY_REALM_DIGEST.test(facts.converted94.identityDigest) ||
    facts.original92.backupDigest === facts.converted94.backupDigest ||
    !MONEY_REALM_DIGEST.test(conversion.source94Digest) ||
    facts.converted94.sourceDigest !== conversion.source94Digest ||
    !MONEY_REALM_DIGEST.test(facts.current94.schemaShapeDigest) ||
    !MONEY_CUTOVER_WRITER_EPOCH_PATTERN.test(facts.nextWriterEpoch) ||
    facts.previousWriterEpoch === facts.nextWriterEpoch ||
    facts.original92.preimageDigest !== conversion.preimageDigest ||
    facts.original92.aggregateDigest !== conversion.aggregateDigest ||
    !MONEY_REALM_DIGEST.test(conversion.originDigest) ||
    !MONEY_REALM_DIGEST.test(conversion.convertBindingDigest) ||
    !MONEY_REALM_DIGEST.test(conversion.convertPostDigest) ||
    !MONEY_REALM_DIGEST.test(conversion.convertImportDigest) ||
    !MONEY_REALM_DIGEST.test(conversion.writerDigest) ||
    conversion.retained.length !== retainedPhases.length ||
    conversion.retained.some(
      (receipt, index) =>
        receipt.phase !== retainedPhases[index] ||
        !MONEY_REALM_DIGEST.test(receipt.bindingDigest) ||
        !MONEY_REALM_DIGEST.test(receipt.receiptDigest) ||
        !MONEY_REALM_DIGEST.test(receipt.importDigest) ||
        !MONEY_REALM_DIGEST.test(receipt.sourceDigest),
    ) ||
    convert?.bindingDigest !== conversion.convertBindingDigest ||
    convert?.importDigest !== conversion.convertImportDigest ||
    convert?.sourceDigest !== conversion.source94Digest
  )
    refuse("original_conversion_lineage_differs");

  // Exactly six fixed conversion artifacts, not an extensible name allowlist.
  const evidenced = new Set(
    namedArtifacts
      .filter(
        (item) =>
          item.artifact !== "money_unit_policy" &&
          item.sourceEvidence === "consistent_with_fixed_root_checks",
      )
      .map((item) => item.artifact),
  );
  if (evidenced.size !== 6) refuse("fixed_conversion_artifact_unbound");
  for (const [phase, census] of [
    ["converted94", converted94],
    ["current94", current94],
  ] as const) {
    for (const item of census.observations) {
      const artifact = namedArtifacts.find((entry) => entry.artifact === item.name);
      const fixed = artifact !== undefined && evidenced.has(artifact.artifact);
      if (item.classification === "unknown_financial_prefix" && !fixed)
        refuse(
          phase === "converted94"
            ? "converted94_unknown_financial_prefix"
            : "current94_unknown_financial_prefix",
        );
      if (item.classification === "known_financial" && item.rows !== 0 && !fixed)
        refuse(
          phase === "converted94"
            ? "converted94_financial_rows_unbound"
            : "current94_financial_rows_unbound",
        );
      if (item.name.toLowerCase() === "stripe_mode_realm") refuse("pre_suffix_realm_table_present");
    }
    if (moneyRealmObservedRows(census, "money_unit_policy") !== 1)
      refuse("policy_row_count_unexpected");
  }
  if (original92.observations.some((item) => item.name.toLowerCase() === "stripe_mode_realm"))
    refuse("pre_suffix_realm_table_present");
  const originalRefused = [...refusals].some(
    (reason) => reason.startsWith("original92_") || reason === "pre_suffix_realm_table_present",
  );
  return Object.freeze({
    zeroOrigin: originalRefused ? "refused" : "source_predicates_satisfied",
    convertedHistoryExceptPolicy: refusals.size === 0 ? "source_predicates_satisfied" : "refused",
    policyTuple: "not_established",
    census: Object.freeze({ original92, converted94, current94 }),
    namedArtifacts,
    refusals: Object.freeze([...refusals]),
  });
}

export interface MoneyRealmTransitionPreparation {
  readonly scope: "financial-history-policy-data-only";
  readonly history: MoneyRealmHistoryDataAssessment;
  /** The Root request is intent, not historical or native TEST-mode evidence. */
  readonly requestedMode: "test";
  readonly normalWorkerMode: "not_established";
  readonly contribution: null;
  readonly remaining: readonly [
    "held_root_policy_tuple_not_returned",
    "normal_worker_test_mode_unproven",
    "same_one_contribution_not_prepared",
  ];
}

/**
 * Authenticated Financial history preparation, with zero target SQL or writes.
 * Must resolve the exact original Root v8 owner module instance. Its two genuine
 * assertions bracket all Financial reads/calculation, including the zero-origin
 * result. No caller callback, local WeakMap or DATA shape substitutes for Root.
 *
 * The existing facts do not supply the expected policy tuple or genuine normal
 * Worker/native mode preparation. Return useful history DATA while keeping the
 * contribution absent: no pin SQL, digest, capability, grant, or serving signal.
 */
export async function prepareMoneyD1StripeRealmTransition(
  context: unknown,
): Promise<MoneyRealmTransitionPreparation> {
  try {
    await assertMoneyUnitHeldConvertCurrent(context);
    const held = context as MoneyUnitHeldConvertContext;
    if (
      held.kind !== "takoserver.money-held-convert-context@v1" ||
      held.facts.selectedStripeMode !== "test"
    )
      throw moneyRealmCensusError();
    const history = assessMoneyD1StripeRealmHistoryData(held.facts);
    const result: MoneyRealmTransitionPreparation = Object.freeze({
      scope: "financial-history-policy-data-only",
      history,
      requestedMode: held.facts.selectedStripeMode,
      normalWorkerMode: "not_established",
      contribution: null,
      remaining: Object.freeze([
        "held_root_policy_tuple_not_returned",
        "normal_worker_test_mode_unproven",
        "same_one_contribution_not_prepared",
      ] as const),
    });
    await assertMoneyUnitHeldConvertCurrent(context);
    return result;
  } catch (cause) {
    throw new MoneyRealmDiagnosticError(cause);
  }
}

/** SOURCE DATA only. These three statements are not an operative ONE contribution. */
export interface MoneyRealmPinDraftStatementData {
  readonly sql: string;
  readonly params: readonly (string | number)[];
}

export interface MoneyRealmPinDraftData {
  readonly scope: "financial-realm-pin-source-data-only";
  readonly sourceFactsJson: string;
  readonly statements: readonly [
    MoneyRealmPinDraftStatementData,
    MoneyRealmPinDraftStatementData,
    MoneyRealmPinDraftStatementData,
  ];
  readonly normalWorkerMode: "not_established";
  readonly contribution: null;
}

// Exact sqlite_schema strings from the existing src/stripe-mode-realm.ts guard,
// not a migration recipe or a new schema. No DDL is executed by this module.
const MONEY_REALM_PIN_SCHEMA_DATA = [
  [
    "table",
    "stripe_mode_realm",
    `CREATE TABLE stripe_mode_realm (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  pinned_at TEXT NOT NULL
)`,
  ],
  [
    "trigger",
    "stripe_mode_realm_no_update",
    `CREATE TRIGGER stripe_mode_realm_no_update BEFORE UPDATE ON stripe_mode_realm
BEGIN
  SELECT RAISE(ABORT, 'Stripe mode realm pin is immutable');
END`,
  ],
  [
    "trigger",
    "stripe_mode_realm_no_delete",
    `CREATE TRIGGER stripe_mode_realm_no_delete BEFORE DELETE ON stripe_mode_realm
BEGIN
  SELECT RAISE(ABORT, 'Stripe mode realm pin is immutable');
END`,
  ],
] as const;

/** Internal source encoding, not a public codec or the bounded16KiB wire helper.
 * Own enumerable JSON data only; never call a getter or toJSON. */
function moneyRealmDraftSourceJson(input: unknown): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  let budget = 4 * 1024 * 1024;
  const charge = (text: string): string => {
    budget -= new TextEncoder().encode(text).length;
    if (budget < 0) throw moneyRealmCensusError();
    return text;
  };
  const encode = (value: unknown, depth: number): string => {
    if (++nodes > 100_000 || depth > 64) throw moneyRealmCensusError();
    if (value === null) return charge("null");
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      const encoded = JSON.stringify(value);
      if (typeof encoded !== "string") throw moneyRealmCensusError();
      return charge(encoded);
    }
    if (typeof value !== "object" || ancestors.has(value)) throw moneyRealmCensusError();
    ancestors.add(value);
    try {
      const keys = Reflect.ownKeys(value);
      if (Array.isArray(value)) {
        const length = Object.getOwnPropertyDescriptor(value, "length");
        if (
          Object.getPrototypeOf(value) !== Array.prototype ||
          !length ||
          !("value" in length) ||
          typeof length.value !== "number" ||
          !Number.isSafeInteger(length.value) ||
          length.value < 0 ||
          length.value > 10_000 ||
          keys.length !== length.value + 1
        )
          throw moneyRealmCensusError();
        const items: string[] = [];
        for (let index = 0; index < length.value; index++) {
          const field = Object.getOwnPropertyDescriptor(value, String(index));
          if (!field || !("value" in field) || !field.enumerable) throw moneyRealmCensusError();
          items.push(encode(field.value, depth + 1));
        }
        charge("[]" + ",".repeat(Math.max(0, items.length - 1)));
        return "[" + items.join(",") + "]";
      }
      if (!moneyRealmPlainRecord(value) || keys.some((key) => typeof key !== "string"))
        throw moneyRealmCensusError();
      const fields: string[] = [];
      for (const key of Object.keys(value).sort()) {
        const field = Object.getOwnPropertyDescriptor(value, key);
        if (!field || !("value" in field) || !field.enumerable) throw moneyRealmCensusError();
        fields.push(charge(JSON.stringify(key) + ":") + encode(field.value, depth + 1));
      }
      if (fields.length !== keys.length) throw moneyRealmCensusError();
      charge("{}" + ",".repeat(Math.max(0, fields.length - 1)));
      return "{" + fields.join(",") + "}";
    } finally {
      ancestors.delete(value);
    }
  };
  return encode(input, 0);
}

/** Balance only this new ordered guard; the V7 policy expression stays exact. */
function moneyRealmDraftAnd(parts: readonly string[]): string {
  if (parts.length === 0) throw moneyRealmCensusError();
  if (parts.length === 1) return parts[0]!;
  const middle = Math.floor(parts.length / 2);
  return `(${moneyRealmDraftAnd(parts.slice(0, middle))} AND ${moneyRealmDraftAnd(parts.slice(middle))})`;
}

function moneyRealmDraftHistoryName(name: string): boolean {
  const folded = name.toLowerCase();
  return (
    folded !== "money_unit_policy" &&
    folded !== "stripe_mode_realm" &&
    (MONEY_REALM_PREFIXES.some((prefix) => folded.startsWith(prefix)) ||
      ["ledger", "quotes", "reservations", "idempotency"].includes(folded))
  );
}

// Exact additive Financial table names from canonical0095 (12),0096 (5),0097 (1).
// They are absent from the original held0094 schema and receive no seed rows.
// Root owns canonical suffix DDL/source verification in the same sealed import;
// this fixed post0098 inventory adds no prefix exemption or schema authority.
const MONEY_REALM_POST94_STAGE_TABLES = [
  "stripe_billing_associations",
  "stripe_billing_checkouts",
  "stripe_billing_commands",
  "stripe_billing_customers",
  "stripe_billing_fences",
  "stripe_billing_grants",
  "stripe_billing_object_claims",
  "stripe_billing_price_identity",
  "stripe_billing_price_identity_checks",
  "stripe_billing_pricing",
  "stripe_billing_reconcile",
  "stripe_billing_reconcile_failures",
  "stripe_billing_refund_observations",
  "stripe_billing_refunds",
  "stripe_billing_subscriptions",
  "stripe_subscription_cancellation_intents",
  "stripe_subscription_checkout_intents",
  "stripe_subscription_custody_reconcile",
] as const;

/** Canonical command audit metadata only; this is not a native/policy Clock.
 * A DATA caller supplies its original instant explicitly. Only the operative
 * constructor captures a new wall-clock instant after genuine Root assertions. */
function moneyRealmOriginalPinInstant(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 24 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw moneyRealmCensusError();
  return value;
}

function moneyRealmCapturePinInstant(): string {
  return moneyRealmOriginalPinInstant(new Date().toISOString());
}

/** Pure DATA compiler. Supplied facts, even matching ones, are not Root evidence.
 * There is no SQL/table/callback input and no SQL runner. A future Root ONE must
 * keep the ordered three adjacent and roll back the entire transaction on error. */
export function compileMoneyD1StripeRealmPinDraftData(
  facts: MoneyUnitHeldConvertFacts,
  originalPinnedAt: string,
): MoneyRealmPinDraftData {
  const pinnedAt = moneyRealmOriginalPinInstant(originalPinnedAt);
  const sourceFactsJson = moneyRealmDraftSourceJson(facts);
  // JSON parse uses only our own-data encoding: no borrowed DTO is read again.
  const snapshot: MoneyUnitHeldConvertFacts = JSON.parse(sourceFactsJson);
  const history = assessMoneyD1StripeRealmHistoryData(snapshot);
  if (
    snapshot.selectedStripeMode !== "test" ||
    history.zeroOrigin !== "source_predicates_satisfied" ||
    history.convertedHistoryExceptPolicy !== "source_predicates_satisfied"
  )
    throw moneyRealmCensusError();
  const policy = buildMoneyD1StripeRealmPolicyTuplePredicateData();
  // The contribution runs after0098, while these original facts remain at0094.
  // A pre-existing stage table (including a case variant) is not a new zero.
  const stageNames = new Set<string>(MONEY_REALM_POST94_STAGE_TABLES);
  if (history.census.current94.observations.some((item) => stageNames.has(item.name.toLowerCase())))
    throw moneyRealmCensusError();
  const financial = [
    ...history.census.current94.observations.filter((item) =>
      moneyRealmDraftHistoryName(item.name),
    ),
    ...MONEY_REALM_POST94_STAGE_TABLES.map((name) => ({ name, rows: 0 })),
  ].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const params: (string | number)[] = [...policy.params];
  const guards = [policy.sql];
  guards.push(`(SELECT count(*) FROM sqlite_schema
    WHERE lower(name) = 'stripe_mode_realm'
       OR lower(tbl_name) = 'stripe_mode_realm') = 3`);
  for (const [type, name, sql] of MONEY_REALM_PIN_SCHEMA_DATA) {
    guards.push(`EXISTS (SELECT 1 FROM sqlite_schema
      WHERE type = '${type}' AND name = '${name}' AND tbl_name = 'stripe_mode_realm' AND sql IS ?)`);
    params.push(sql);
  }
  guards.push(
    `(SELECT json_group_array(name) FROM (${STRIPE_REALM_FINANCIAL_HISTORY_QUERY})) IS ?`,
  );
  const inventoryJson = JSON.stringify(financial.map((item) => item.name));
  if (typeof inventoryJson !== "string") throw moneyRealmCensusError();
  params.push(inventoryJson);
  for (const item of financial) {
    // Only the already validated, fixed Financial vocabulary reaches identifiers.
    if (!MONEY_REALM_SAFE_NAME.test(item.name)) throw moneyRealmCensusError();
    guards.push(`(SELECT count(*) FROM "${item.name}") IS ?`);
    params.push(item.rows);
  }
  guards.push(`EXISTS (SELECT 1 FROM ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE}
    WHERE typeof(singleton) = 'integer' AND singleton IS 1
      AND typeof(writer_epoch) = 'text' AND writer_epoch IS ?)`);
  params.push(snapshot.previousWriterEpoch);
  guards.push(`EXISTS (SELECT 1 FROM money_cutover_freeze
    WHERE typeof(singleton) = 'integer' AND singleton IS 1
      AND binding_digest IS ? AND origin_digest IS ? AND backup_digest IS ?
      AND writer_digest IS ? AND source_digest IS ?)`);
  params.push(
    snapshot.current94.freezeBindingDigest,
    snapshot.conversion.originDigest,
    snapshot.original92.backupDigest,
    snapshot.conversion.writerDigest,
    snapshot.original92.sourceDigest,
  );
  if (params.length !== financial.length + 14 || params.length + 1 > 100)
    throw moneyRealmCensusError();
  const common = moneyRealmDraftAnd(guards);
  const pre = moneyRealmDraftAnd([common, "NOT EXISTS (SELECT 1 FROM stripe_mode_realm)"]);
  const post = moneyRealmDraftAnd([
    "changes() = 1",
    common,
    "(SELECT count(*) FROM stripe_mode_realm) = 1",
    `EXISTS (SELECT 1 FROM stripe_mode_realm WHERE typeof(singleton) = 'integer'
      AND singleton IS 1 AND typeof(mode) = 'text' AND mode IS 'test'
      AND typeof(pinned_at) = 'text' AND pinned_at IS ?
      AND strftime('%Y-%m-%dT%H:%M:%fZ', pinned_at) IS pinned_at)`,
  ]);
  const statement = (
    sql: string,
    statementParams: readonly (string | number)[] = params,
  ): MoneyRealmPinDraftStatementData =>
    Object.freeze({ sql, params: Object.freeze([...statementParams]) });
  return Object.freeze({
    scope: "financial-realm-pin-source-data-only",
    sourceFactsJson,
    statements: Object.freeze([
      statement(
        `SELECT json_extract(CASE WHEN ${pre} THEN '[1]' ELSE '!' END, '$[0]') AS required_financial_realm`,
      ),
      Object.freeze({
        sql: `INSERT INTO stripe_mode_realm (singleton, mode, pinned_at)
VALUES (1, 'test', ?)
RETURNING singleton, mode, pinned_at`,
        params: Object.freeze([pinnedAt]),
      }),
      statement(
        `SELECT json_extract(CASE WHEN ${post} THEN '[1]' ELSE '!' END, '$[0]') AS required_financial_realm`,
        [...params, pinnedAt],
      ),
    ] as const),
    normalWorkerMode: "not_established",
    contribution: null,
  });
}

export interface MoneyRealmRootCheckedPinDraft {
  readonly scope: "financial-root-checked-pin-draft-not-permission";
  readonly draft: MoneyRealmPinDraftData;
  readonly sourceBindingDigest: `sha256:${string}`;
  readonly normalWorkerMode: "not_established";
  readonly contribution: null;
  readonly remaining: readonly [
    "root_outer_freeze_native_currentness_unintegrated",
    "root_same_one_adjacent_transaction_unintegrated",
    "normal_worker_native_test_unproven",
    "root_epoch_rotation_order_unintegrated",
  ];
}

/** Actual curated Root identity brackets the source-only draft. Capture every
 * fact and exact statement/bind before hashing awaits; no caller DTO is read
 * before the first original assertion. No native-positive context is minted. */
export async function readMoneyD1StripeRealmPinSourceDraft(
  context: unknown,
): Promise<MoneyRealmRootCheckedPinDraft> {
  try {
    await assertMoneyUnitHeldConvertCurrent(context);
    const held = context as MoneyUnitHeldConvertContext;
    if (held.kind !== "takoserver.money-held-convert-context@v1") throw moneyRealmCensusError();
    const facts = held.facts;
    const draft = compileMoneyD1StripeRealmPinDraftData(facts, moneyRealmCapturePinInstant());
    const source = moneyRealmDraftSourceJson([
      "takoserver.financial-realm-pin-internal-source-v1",
      draft,
    ]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    const sourceBindingDigest: `sha256:${string}` = `sha256:${[...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`;
    await assertMoneyUnitHeldConvertCurrent(context);
    if (held.facts !== facts || moneyRealmDraftSourceJson(facts) !== draft.sourceFactsJson)
      throw moneyRealmCensusError();
    return Object.freeze({
      scope: "financial-root-checked-pin-draft-not-permission",
      draft,
      sourceBindingDigest,
      normalWorkerMode: "not_established",
      contribution: null,
      remaining: Object.freeze([
        "root_outer_freeze_native_currentness_unintegrated",
        "root_same_one_adjacent_transaction_unintegrated",
        "normal_worker_native_test_unproven",
        "root_epoch_rotation_order_unintegrated",
      ] as const),
    });
  } catch (cause) {
    throw new MoneyRealmDiagnosticError(cause);
  }
}

export interface MoneyRealmNormalModeDraftData {
  readonly scope: "financial-normal-mode-pin-source-data-only";
  readonly pin: MoneyRealmPinDraftData;
  readonly modeFactsJson: string;
  readonly contribution: null;
}

const MONEY_REALM_MODE_DIGEST_FIELDS = [
  "heldConvertDigest",
  "convertBindingDigest",
  "converted94BackupDigest",
  "moduleDigest",
  "sourceArtifactDigest",
  "sourceTreeDigest",
  "dependencyClosureDigest",
  "toolClosureDigest",
  "nativeBindingDigest",
  "entrySourceDigest",
  "entryModuleSourceDigest",
  "parserSourceDigest",
  "parserFunctionDigest",
] as const;

/** Detached source DATA only: matching shapes can pass, without native authority.
 * Preserve all27 mode fields in the internal source binding. The Root assertion
 * below, not this comparison, proves the original preparation/context pairing. */
export function compileMoneyD1StripeRealmNormalModeDraftData(
  facts: MoneyUnitHeldConvertFacts,
  modeFacts: MoneyHeldNormalWorkerModeFacts,
  originalPinnedAt: string,
): MoneyRealmNormalModeDraftData {
  const pin = compileMoneyD1StripeRealmPinDraftData(facts, originalPinnedAt);
  const held: MoneyUnitHeldConvertFacts = JSON.parse(pin.sourceFactsJson);
  const modeFactsJson = moneyRealmDraftSourceJson(modeFacts);
  const mode: MoneyHeldNormalWorkerModeFacts = JSON.parse(modeFactsJson);
  const fields = [
    "kind",
    "accountId",
    "databaseId",
    "databaseName",
    "bucketName",
    "workerName",
    "previousWriterEpoch",
    "nextWriterEpoch",
    "versionId",
    "sourceCommit",
    "sourceArtifactBytes",
    "sourceArtifactFiles",
    "stripeMode",
    "modeEvidence",
    ...MONEY_REALM_MODE_DIGEST_FIELDS,
  ];
  if (
    Object.keys(mode).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(mode, key)) ||
    mode.kind !== "takoserver.money-held-normal-worker-mode-facts@v1" ||
    mode.stripeMode !== "test" ||
    (mode.modeEvidence !== "explicit-native-test" &&
      mode.modeEvidence !== "verified-source-default-test-native-absence") ||
    !held.storage ||
    (["accountId", "databaseId", "databaseName", "bucketName"] as const).some(
      (key) => typeof mode[key] !== "string" || !mode[key] || mode[key] !== held.storage[key],
    ) ||
    mode.previousWriterEpoch !== held.previousWriterEpoch ||
    mode.nextWriterEpoch !== held.nextWriterEpoch ||
    mode.convertBindingDigest !== held.conversion.convertBindingDigest ||
    mode.converted94BackupDigest !== held.converted94.backupDigest ||
    typeof mode.workerName !== "string" ||
    !mode.workerName ||
    typeof mode.versionId !== "string" ||
    !mode.versionId ||
    typeof mode.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(mode.sourceCommit) ||
    !Number.isSafeInteger(mode.sourceArtifactBytes) ||
    mode.sourceArtifactBytes <= 0 ||
    !Number.isSafeInteger(mode.sourceArtifactFiles) ||
    mode.sourceArtifactFiles <= 0 ||
    MONEY_REALM_MODE_DIGEST_FIELDS.some(
      (key) => typeof mode[key] !== "string" || !MONEY_REALM_DIGEST.test(mode[key]),
    )
  )
    throw moneyRealmCensusError();
  return Object.freeze({
    scope: "financial-normal-mode-pin-source-data-only",
    pin,
    modeFactsJson,
    contribution: null,
  });
}

export interface MoneyRealmOriginalModeCheckedPinDraft {
  readonly scope: "financial-original-mode-checked-pin-draft-not-permission";
  readonly draft: MoneyRealmNormalModeDraftData;
  readonly sourceBindingDigest: `sha256:${string}`;
  readonly normalWorkerMode: "original-root-preparation-checked";
  readonly contribution: null;
  readonly remaining: readonly [
    "root_outer_freeze_native_currentness_unintegrated",
    "root_same_one_adjacent_transaction_unintegrated",
    "root_epoch_rotation_order_unintegrated",
  ];
}

/** Only the curated original Root assertion can cross this boundary. It repeats
 * native/source/held checks on the exact pair before and after our hashing await.
 * There is no runner, issuer, local capability map or consumer assertion port.
 * Root must still bind these exact statements to its sealed ONE and recheck the
 * originals at dispatch; this result cannot perform or authorize an import. */
async function moneyRealmReadOriginalModePinSourceDraft(
  context: unknown,
  preparation: unknown,
  originalPinnedAt?: string,
): Promise<{ readonly checked: MoneyRealmOriginalModeCheckedPinDraft; readonly pinnedAt: string }> {
  try {
    await assertMoneyUnitHeldNormalWorkerModePreparationCurrent(preparation, context);
    // Creation samples the actual owner clock once. Currentness reconstruction
    // supplies the retained original, so it never samples a new instant.
    const pinnedAt =
      originalPinnedAt === undefined
        ? moneyRealmCapturePinInstant()
        : moneyRealmOriginalPinInstant(originalPinnedAt);
    const held = context as MoneyUnitHeldConvertContext;
    const original = preparation as MoneyUnitHeldNormalWorkerModePreparation;
    const facts = held.facts;
    const mode = original.facts;
    const preparationBindingDigest = original.bindingDigest;
    const draft = compileMoneyD1StripeRealmNormalModeDraftData(facts, mode, pinnedAt);
    const source = moneyRealmDraftSourceJson([
      "takoserver.financial-normal-mode-pin-internal-source-v1",
      preparationBindingDigest,
      draft,
    ]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    const sourceBindingDigest: `sha256:${string}` = `sha256:${[...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`;
    await assertMoneyUnitHeldNormalWorkerModePreparationCurrent(preparation, context);
    if (
      held.facts !== facts ||
      original.facts !== mode ||
      original.bindingDigest !== preparationBindingDigest ||
      moneyRealmDraftSourceJson(facts) !== draft.pin.sourceFactsJson ||
      moneyRealmDraftSourceJson(mode) !== draft.modeFactsJson
    )
      throw moneyRealmCensusError();
    const checked: MoneyRealmOriginalModeCheckedPinDraft = Object.freeze({
      scope: "financial-original-mode-checked-pin-draft-not-permission",
      draft,
      sourceBindingDigest,
      normalWorkerMode: "original-root-preparation-checked",
      contribution: null,
      remaining: Object.freeze([
        "root_outer_freeze_native_currentness_unintegrated",
        "root_same_one_adjacent_transaction_unintegrated",
        "root_epoch_rotation_order_unintegrated",
      ] as const),
    });
    return Object.freeze({ checked, pinnedAt });
  } catch (cause) {
    throw new MoneyRealmDiagnosticError(cause);
  }
}

/** Original checked DATA entry; operative assertions use only the private
 * reconstruction path with their retained command instant. */
export async function readMoneyD1StripeRealmNormalModePinSourceDraft(
  context: unknown,
  preparation: unknown,
): Promise<MoneyRealmOriginalModeCheckedPinDraft> {
  return (await moneyRealmReadOriginalModePinSourceDraft(context, preparation)).checked;
}

declare const moneyRealmPinContributionBrand: unique symbol;

/** Source-built pre-import fragment, never a dispatch/resume/retry permission. */
export interface MoneyRealmPinContribution {
  readonly [moneyRealmPinContributionBrand]: true;
  readonly kind: "takoserver.financial-stripe-realm-pin-contribution@v1";
  readonly scope: "fixed-financial-fragment-not-dispatch-permission";
  readonly sourceBindingDigest: `sha256:${string}`;
  readonly modePreparationDigest: `sha256:${string}`;
  readonly writerEpochBeforeRotation: string;
  readonly statements: MoneyRealmPinDraftData["statements"];
  readonly placement: "same-sealed-one-after-0098-schema-before-epoch-rotation";
}

interface MoneyRealmPinContributionOrigin {
  readonly context: unknown;
  readonly preparation: unknown;
  readonly pinnedAt: string;
  readonly sourceBindingDigest: `sha256:${string}`;
  readonly modePreparationDigest: `sha256:${string}`;
  readonly statementsJson: string;
  readonly contributionJson: string;
}

// This records only the identity of our fixed Financial fragment. It is never
// evidence for Root origin/native facts: both creation and revalidation call the
// actual Root assertion through the mode-bound reader, with the original pair.
const moneyRealmPinContributions = new WeakMap<object, MoneyRealmPinContributionOrigin>();

function moneyRealmOriginalModeDigest(preparation: unknown): `sha256:${string}` {
  if (typeof preparation !== "object" || preparation === null) throw moneyRealmCensusError();
  const field = Object.getOwnPropertyDescriptor(preparation, "bindingDigest");
  if (
    !field ||
    !("value" in field) ||
    typeof field.value !== "string" ||
    !MONEY_REALM_DIGEST.test(field.value)
  )
    throw moneyRealmCensusError();
  return field.value as `sha256:${string}`;
}

/** Called by Root in-process with inputs.context and its original mode member.
 * Selection/declaration custody stays Root-owned. There is no SQL/runner/callback
 * argument, and matching mode DATA cannot pass the original Root assertion.
 * The mandatory pre/INSERT/post triple must stay adjacent inside the existing
 * sealed ONE; a post-import/unknown-ACK/resume path cannot reuse this artifact. */
export async function readMoneyD1StripeRealmPinContribution(
  context: unknown,
  preparation: unknown,
): Promise<MoneyRealmPinContribution> {
  try {
    const { checked, pinnedAt } = await moneyRealmReadOriginalModePinSourceDraft(
      context,
      preparation,
    );
    const modePreparationDigest = moneyRealmOriginalModeDigest(preparation);
    const facts: MoneyUnitHeldConvertFacts = JSON.parse(checked.draft.pin.sourceFactsJson);
    const contribution = Object.freeze({
      kind: "takoserver.financial-stripe-realm-pin-contribution@v1",
      scope: "fixed-financial-fragment-not-dispatch-permission",
      sourceBindingDigest: checked.sourceBindingDigest,
      modePreparationDigest,
      writerEpochBeforeRotation: facts.previousWriterEpoch,
      statements: checked.draft.pin.statements,
      placement: "same-sealed-one-after-0098-schema-before-epoch-rotation",
    }) as MoneyRealmPinContribution;
    moneyRealmPinContributions.set(contribution, {
      context,
      preparation,
      pinnedAt,
      sourceBindingDigest: checked.sourceBindingDigest,
      modePreparationDigest,
      statementsJson: moneyRealmDraftSourceJson(contribution.statements),
      contributionJson: moneyRealmDraftSourceJson(contribution),
    });
    return contribution;
  } catch (cause) {
    throw new MoneyRealmDiagnosticError(cause);
  }
}

/** Exact Financial source identity plus genuine original Root currentness.
 * The private map alone can never establish native authority or currentness.
 * Root must separately retain selection/custody, seal the one atomic suffix and
 * preserve rollback/epoch order. This function executes no statement/import. */
export async function assertMoneyD1StripeRealmPinContributionCurrent(
  contribution: unknown,
  context: unknown,
  preparation: unknown,
): Promise<void> {
  try {
    const original =
      typeof contribution === "object" && contribution !== null
        ? moneyRealmPinContributions.get(contribution)
        : undefined;
    if (!original || original.context !== context || original.preparation !== preparation)
      throw moneyRealmCensusError();
    // Only our deeply frozen original reaches the encoder; fake/copy/Proxy and
    // inherited artifacts are refused by identity without invoking their traps.
    if (moneyRealmDraftSourceJson(contribution) !== original.contributionJson)
      throw moneyRealmCensusError();
    const { checked } = await moneyRealmReadOriginalModePinSourceDraft(
      context,
      preparation,
      original.pinnedAt,
    );
    if (
      checked.sourceBindingDigest !== original.sourceBindingDigest ||
      moneyRealmOriginalModeDigest(preparation) !== original.modePreparationDigest ||
      moneyRealmDraftSourceJson(checked.draft.pin.statements) !== original.statementsJson ||
      moneyRealmDraftSourceJson(contribution) !== original.contributionJson
    )
      throw moneyRealmCensusError();
  } catch (cause) {
    throw new MoneyRealmDiagnosticError(cause);
  }
}
