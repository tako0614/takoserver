import { assertFinancial0104CustomerWriteShape } from "./financial-0104-customer-schema.ts";
import { isFinancialMoneyFencedBatch } from "./financial-0104-money-fence.ts";
import { canonicalJson } from "./json.ts";
import { assertMoneyCutoverSqlOrigin } from "./money-cutover-sql.ts";
import { type JsonValue, type Row, type Sql, SqlError, type SqlStatement } from "./ports.ts";

/** Unmounted private H0 component. Syntactic captured inputs are NOT source authentication. */
export const HISTORY_COMPONENT_QUALIFICATION = "synthetic-input-h0-component-only" as const;
export interface HistoryRoot {
  readonly primaryRef: string;
  readonly primaryIncarnation: string;
  readonly physicalBindingRef: string;
  readonly physicalBindingIncarnation: string;
  readonly resourceRef: string;
  readonly lineageEvidenceRef: string;
  readonly qualificationRef: string;
  readonly profileRef: string;
  readonly accountId: string;
  readonly mode: "test" | "live";
  readonly billingAuthority: string;
  readonly financialRealm: string;
  readonly writerEpoch: string;
}
export interface HistoryScope {
  readonly scopeKind:
    | "physical-primary"
    | "writer"
    | "credential-alias"
    | "org-namespace"
    | "retired-namespace"
    | "org-alias";
  readonly originalScopeRef: string;
  readonly originalScopeIncarnation: string;
  readonly sourceRegistrationRef: string;
  readonly sourceIncarnation: string;
  readonly sourceHeadRef: string;
  readonly sourceSequence: number;
  readonly evidenceRef: string;
  readonly evidenceDigest: string;
  readonly fenceRef: string | null;
  readonly drainRef: string | null;
  readonly drainDisposition: "drained" | "retained-original" | "not-applicable";
  readonly ownerPrincipalId: string | null;
  readonly orgCreatedAt: string | null;
}
export interface HistoryEnrollment {
  readonly enrollmentRef: string;
  readonly enrollmentIncarnation: string;
  readonly generation: number;
  readonly startReceiptRef: string;
  readonly sealReceiptRef: string;
  readonly previousStartReceiptRef: string | null;
  readonly previousSealRef: string | null;
  readonly required: readonly HistoryScope[];
}
const rootKeys = [
  "primaryRef",
  "primaryIncarnation",
  "physicalBindingRef",
  "physicalBindingIncarnation",
  "resourceRef",
  "lineageEvidenceRef",
  "qualificationRef",
  "profileRef",
  "accountId",
  "mode",
  "billingAuthority",
  "financialRealm",
  "writerEpoch",
];
const scopeKeys = [
  "scopeKind",
  "originalScopeRef",
  "originalScopeIncarnation",
  "sourceRegistrationRef",
  "sourceIncarnation",
  "sourceHeadRef",
  "sourceSequence",
  "evidenceRef",
  "evidenceDigest",
  "fenceRef",
  "drainRef",
  "drainDisposition",
  "ownerPrincipalId",
  "orgCreatedAt",
];
const runKeys = [
  "enrollmentRef",
  "enrollmentIncarnation",
  "generation",
  "startReceiptRef",
  "sealReceiptRef",
  "previousStartReceiptRef",
  "previousSealRef",
  "required",
];
const validRef = (s: unknown): s is string =>
  typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(s);
const digest = (s: unknown): boolean => typeof s === "string" && /^sha256:[0-9a-f]{64}$/u.test(s);
function closed(v: unknown, keys: readonly string[]): void {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    throw new SqlError("invalid", "closed history input required");
}
const encode = (v: unknown): string => canonicalJson(v as JsonValue);
function inputs(root: HistoryRoot, run: HistoryEnrollment): void {
  closed(root, rootKeys);
  closed(run, runKeys);
  for (const k of rootKeys)
    if (!validRef(root[k as keyof HistoryRoot]))
      throw new SqlError("invalid", "invalid history root");
  if (
    !["test", "live"].includes(root.mode) ||
    !digest(root.writerEpoch) ||
    !/^realm:[0-9a-f]{64}$/u.test(root.financialRealm)
  )
    throw new SqlError("invalid", "invalid history realm");
  if (
    !validRef(run.enrollmentRef) ||
    !validRef(run.enrollmentIncarnation) ||
    !validRef(run.startReceiptRef) ||
    !validRef(run.sealReceiptRef) ||
    run.startReceiptRef === run.sealReceiptRef ||
    !Number.isSafeInteger(run.generation) ||
    run.generation < 1 ||
    (run.previousSealRef !== null && !validRef(run.previousSealRef)) ||
    (run.previousStartReceiptRef !== null && !validRef(run.previousStartReceiptRef)) ||
    (run.generation === 1) !== (run.previousStartReceiptRef === null) ||
    (run.generation === 1 && run.previousSealRef !== null) ||
    !Array.isArray(run.required) ||
    run.required.length < 1 ||
    run.required.length > 64
  )
    throw new SqlError("invalid", "invalid history enrollment");
  const keys = new Set<string>();
  for (const s of run.required) {
    closed(s, scopeKeys);
    if (
      ![
        "physical-primary",
        "writer",
        "credential-alias",
        "org-namespace",
        "retired-namespace",
        "org-alias",
      ].includes(s.scopeKind) ||
      ![
        s.originalScopeRef,
        s.originalScopeIncarnation,
        s.sourceRegistrationRef,
        s.sourceIncarnation,
        s.sourceHeadRef,
        s.evidenceRef,
      ].every(validRef) ||
      !Number.isSafeInteger(s.sourceSequence) ||
      s.sourceSequence < 0 ||
      !digest(s.evidenceDigest) ||
      !["drained", "retained-original", "not-applicable"].includes(s.drainDisposition)
    )
      throw new SqlError("invalid", "invalid history scope");
    for (const x of [s.fenceRef, s.drainRef, s.ownerPrincipalId])
      if (x !== null && !validRef(x)) throw new SqlError("invalid", "invalid history evidence");
    // Raw legacy Org TEXT, not an owned Clock timestamp. Preserve empty/extended/nonISO exactly.
    if (s.orgCreatedAt !== null && typeof s.orgCreatedAt !== "string")
      throw new SqlError("invalid", "invalid raw namespace text");
    if (
      (s.scopeKind === "writer" &&
        (!s.fenceRef || !s.drainRef || s.drainDisposition === "not-applicable")) ||
      (s.scopeKind === "credential-alias" && !s.fenceRef) ||
      (["org-namespace", "retired-namespace", "org-alias"].includes(s.scopeKind) &&
        (!s.ownerPrincipalId || s.orgCreatedAt === null))
    )
      throw new SqlError("invalid", "missing typed closure/namespace evidence");
    const key = encode([s.scopeKind, s.originalScopeRef, s.originalScopeIncarnation]);
    if (keys.has(key)) throw new SqlError("invalid", "duplicate required scope");
    keys.add(key);
  }
  const physical = run.required.filter((s) => s.scopeKind === "physical-primary");
  if (
    physical.length !== 1 ||
    physical[0]?.originalScopeRef !== root.primaryRef ||
    physical[0]?.originalScopeIncarnation !== root.primaryIncarnation
  )
    throw new SqlError("invalid", "physical scope must bind exact original root");
  for (const kind of ["physical-primary", "writer", "credential-alias"])
    if (!run.required.some((s) => s.scopeKind === kind))
      throw new SqlError("invalid", "missing required fixture scope family");
}
/** Current SQL facts are actual same-primary rows, not cached JS readiness. Full genuine capture remains unmounted.
 * Money currentness is not read here: every H0 table is 0104 money-fenced (freeze,
 * Root permit and the root's own writer epoch) inside Root's Money writer. */
function current(alias: string): string {
  return `EXISTS(SELECT 1 FROM stripe_mode_realm m WHERE m.singleton=1 AND m.mode IS json_extract(${alias}.root_json,'$.mode'))
 AND EXISTS(SELECT 1 FROM stripe_billing_account_realms a WHERE a.singleton=1 AND a.account_id IS json_extract(${alias}.root_json,'$.accountId') AND a.mode IS json_extract(${alias}.root_json,'$.mode') AND a.billing_authority IS json_extract(${alias}.root_json,'$.billingAuthority'))`;
}
const rootMatch = `r.primary_ref=? AND r.root_json=? AND ${current("r")}`;
export function prepareHistoryStart(
  root: HistoryRoot,
  run: HistoryEnrollment,
): readonly SqlStatement[] {
  inputs(root, run);
  const body = encode(root),
    required = encode(run.required);
  const rootInsert = {
    sql: `INSERT INTO financial_history_primary_roots(primary_ref,primary_incarnation,physical_binding_ref,physical_binding_incarnation,root_json) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM financial_history_primary_roots WHERE primary_ref=?) AND EXISTS(SELECT 1 FROM (SELECT ? AS root_json) r WHERE ${current("r")})`,
    params: [
      root.primaryRef,
      root.primaryIncarnation,
      root.physicalBindingRef,
      root.physicalBindingIncarnation,
      body,
      root.primaryRef,
      body,
    ],
  };
  const runInsert = {
    sql: `INSERT INTO financial_history_enrollments(enrollment_ref,enrollment_incarnation,primary_ref,generation,expected_start_receipt_ref,expected_seal_ref,previous_start_receipt_ref,previous_seal_ref,required_json,org_high_water,change_high_water) SELECT ?,?,?,?,?,?,?,?,?,COALESCE((SELECT max(rowid) FROM orgs),0),COALESCE((SELECT max(change_seq) FROM financial_customer_history_org_changes),0) WHERE EXISTS(SELECT 1 FROM financial_history_primary_roots r WHERE ${rootMatch}) AND (?=1 OR EXISTS(SELECT 1 FROM financial_history_enrollment_heads h JOIN financial_history_enrollments e ON e.enrollment_ref=h.enrollment_ref AND e.primary_ref=h.primary_ref JOIN financial_history_enrollment_receipts start ON start.receipt_ref=e.expected_start_receipt_ref AND start.primary_ref=e.primary_ref AND start.enrollment_ref=e.enrollment_ref AND start.generation=e.generation AND start.receipt_kind='capture-start' AND start.all_rows_match=1 LEFT JOIN financial_history_enrollment_receipts seal ON seal.receipt_ref=e.expected_seal_ref AND seal.primary_ref=e.primary_ref AND seal.enrollment_ref=e.enrollment_ref AND seal.generation=e.generation AND seal.receipt_kind='complete-seal' AND seal.all_rows_match=1 WHERE h.primary_ref=? AND h.state='closed' AND h.generation=?-1 AND e.generation=h.generation AND start.receipt_ref IS ? AND seal.receipt_ref IS ?))`,
    params: [
      run.enrollmentRef,
      run.enrollmentIncarnation,
      root.primaryRef,
      run.generation,
      run.startReceiptRef,
      run.sealReceiptRef,
      run.previousStartReceiptRef,
      run.previousSealRef,
      required,
      root.primaryRef,
      body,
      run.generation,
      root.primaryRef,
      run.generation,
      run.previousStartReceiptRef,
      run.previousSealRef,
    ],
  };
  const head: SqlStatement =
    run.generation === 1
      ? {
          sql: `INSERT INTO financial_history_enrollment_heads(primary_ref,enrollment_ref,generation,capture_sequence,state,expected_receipt_ref) SELECT ?,?,?,0,'capturing',? WHERE EXISTS(SELECT 1 FROM financial_history_enrollments WHERE enrollment_ref=? AND primary_ref=?)`,
          params: [
            root.primaryRef,
            run.enrollmentRef,
            run.generation,
            run.startReceiptRef,
            run.enrollmentRef,
            root.primaryRef,
          ],
        }
      : {
          sql: `UPDATE financial_history_enrollment_heads SET enrollment_ref=?,generation=?,state='capturing',expected_receipt_ref=? WHERE primary_ref=? AND state='closed' AND generation=?-1 AND EXISTS(SELECT 1 FROM financial_history_enrollments WHERE enrollment_ref=? AND primary_ref=?)`,
          params: [
            run.enrollmentRef,
            run.generation,
            run.startReceiptRef,
            root.primaryRef,
            run.generation,
            run.enrollmentRef,
            root.primaryRef,
          ],
        };
  const last = {
    sql: `INSERT INTO financial_history_enrollment_receipts(receipt_ref,attempt_ref,enrollment_ref,primary_ref,generation,receipt_kind,capture_sequence,all_rows_match) VALUES(?,?,?,?,?,'capture-start',COALESCE((SELECT capture_sequence FROM financial_history_enrollment_heads WHERE primary_ref=?),0),CASE WHEN EXISTS(SELECT 1 FROM financial_history_primary_roots r JOIN financial_history_enrollments e ON e.primary_ref=r.primary_ref JOIN financial_history_enrollment_heads h ON h.primary_ref=e.primary_ref AND h.enrollment_ref=e.enrollment_ref WHERE ${rootMatch} AND e.enrollment_ref=? AND e.enrollment_incarnation=? AND e.required_json=? AND e.expected_start_receipt_ref=? AND e.expected_seal_ref=? AND e.previous_start_receipt_ref IS ? AND e.previous_seal_ref IS ? AND h.state='capturing' AND h.generation=? AND h.expected_receipt_ref=?) THEN 1 ELSE NULL END)`,
    params: [
      run.startReceiptRef,
      run.startReceiptRef,
      run.enrollmentRef,
      root.primaryRef,
      run.generation,
      root.primaryRef,
      root.primaryRef,
      body,
      run.enrollmentRef,
      run.enrollmentIncarnation,
      required,
      run.startReceiptRef,
      run.sealReceiptRef,
      run.previousStartReceiptRef,
      run.previousSealRef,
      run.generation,
      run.startReceiptRef,
    ],
  };
  return fenced([rootInsert, runInsert, head, last]);
}
/** Every H0 statement writes one 0104 money-fenced history table; nothing else is built. */
function fenced<T extends readonly SqlStatement[]>(statements: T): T {
  if (!isFinancialMoneyFencedBatch(statements))
    throw new SqlError("invalid", "history batch must write only money-fenced tables");
  return statements;
}
export function prepareHistoryInventory(
  root: HistoryRoot,
  run: HistoryEnrollment,
  evidence: HistoryScope,
  inventoryRef: string,
): SqlStatement {
  inputs(root, run);
  if (!validRef(inventoryRef) || !run.required.some((s) => encode(s) === encode(evidence)))
    throw new SqlError("invalid", "inventory not in original required set");
  const statement: SqlStatement = {
    sql: `INSERT INTO financial_history_enrollment_inventory(inventory_ref,enrollment_ref,primary_ref,scope_kind,original_scope_ref,original_scope_incarnation,evidence_json) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM financial_history_primary_roots r WHERE ${rootMatch})`,
    params: [
      inventoryRef,
      run.enrollmentRef,
      root.primaryRef,
      evidence.scopeKind,
      evidence.originalScopeRef,
      evidence.originalScopeIncarnation,
      encode(evidence),
      root.primaryRef,
      encode(root),
    ],
  };
  fenced([statement]);
  return statement;
}
export function prepareHistorySeal(
  root: HistoryRoot,
  run: HistoryEnrollment,
  sequence: number,
): readonly SqlStatement[] {
  inputs(root, run);
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new SqlError("invalid", "invalid capture sequence");
  return fenced([
    {
      sql: `UPDATE financial_history_enrollment_heads SET state='sealed',expected_receipt_ref=? WHERE primary_ref=? AND enrollment_ref=? AND generation=? AND capture_sequence=? AND state='capturing' AND EXISTS(SELECT 1 FROM financial_history_primary_roots r WHERE ${rootMatch})`,
      params: [
        run.sealReceiptRef,
        root.primaryRef,
        run.enrollmentRef,
        run.generation,
        sequence,
        root.primaryRef,
        encode(root),
      ],
    },
    {
      sql: `INSERT INTO financial_history_enrollment_receipts(receipt_ref,attempt_ref,enrollment_ref,primary_ref,generation,receipt_kind,capture_sequence,all_rows_match) VALUES(?,?,?,?,?,'complete-seal',?,CASE WHEN EXISTS(SELECT 1 FROM financial_history_primary_roots r JOIN financial_history_enrollments e ON e.primary_ref=r.primary_ref JOIN financial_history_enrollment_heads h ON h.primary_ref=e.primary_ref AND h.enrollment_ref=e.enrollment_ref WHERE ${rootMatch} AND e.enrollment_ref=? AND e.enrollment_incarnation=? AND e.required_json=? AND e.expected_start_receipt_ref=? AND e.expected_seal_ref=? AND e.previous_start_receipt_ref IS ? AND e.previous_seal_ref IS ? AND h.generation=? AND h.capture_sequence=? AND h.state='sealed' AND h.expected_receipt_ref=?) THEN 1 ELSE NULL END)`,
      params: [
        run.sealReceiptRef,
        run.sealReceiptRef,
        run.enrollmentRef,
        root.primaryRef,
        run.generation,
        sequence,
        root.primaryRef,
        encode(root),
        run.enrollmentRef,
        run.enrollmentIncarnation,
        encode(run.required),
        run.startReceiptRef,
        run.sealReceiptRef,
        run.previousStartReceiptRef,
        run.previousSealRef,
        run.generation,
        sequence,
        run.sealReceiptRef,
      ],
    },
  ]);
}
/** Close an open capture after an observed Org change. Root's Org triggers only
 * append change observations; closing (and so a next-generation restart) is this
 * framed Financial H0 step, admitted only when a change was observed after the
 * capture started. */
export function prepareHistoryClose(root: HistoryRoot, run: HistoryEnrollment): SqlStatement {
  inputs(root, run);
  const statement: SqlStatement = {
    sql: `UPDATE financial_history_enrollment_heads SET state='closed',capture_sequence=capture_sequence+1 WHERE primary_ref=? AND enrollment_ref=? AND generation=? AND state IN('capturing','sealed') AND EXISTS(SELECT 1 FROM financial_history_primary_roots r WHERE ${rootMatch}) AND EXISTS(SELECT 1 FROM financial_history_enrollments e JOIN financial_customer_history_org_changes ch ON ch.change_seq>e.change_high_water WHERE e.enrollment_ref=? AND e.primary_ref=? AND e.enrollment_incarnation=?)`,
    params: [
      root.primaryRef,
      run.enrollmentRef,
      run.generation,
      root.primaryRef,
      encode(root),
      run.enrollmentRef,
      root.primaryRef,
      run.enrollmentIncarnation,
    ],
  };
  fenced([statement]);
  return statement;
}
function detached(
  root: HistoryRoot,
  run: HistoryEnrollment,
): Readonly<{ root: HistoryRoot; run: HistoryEnrollment }> {
  let value: { root: HistoryRoot; run: HistoryEnrollment };
  try {
    value = JSON.parse(encode({ root, run })) as { root: HistoryRoot; run: HistoryEnrollment };
  } catch {
    throw new SqlError("invalid", "history inputs must be detached JSON data");
  }
  inputs(value.root, value.run);
  const freeze = (v: unknown): void => {
    if (v && typeof v === "object") {
      for (const x of Object.values(v)) freeze(x);
      Object.freeze(v);
    }
  };
  freeze(value);
  return value;
}
/** One historical selection, one row: never authorize a receipt by independently finding another run. */
export function prepareHistoryReceiptRead(
  root: HistoryRoot,
  run: HistoryEnrollment,
  kind: "capture-start" | "complete-seal",
  sequence: number | null,
): SqlStatement {
  inputs(root, run);
  if (
    (kind === "capture-start" && sequence !== null) ||
    (kind === "complete-seal" &&
      (!Number.isSafeInteger(sequence) || sequence === null || sequence < 0))
  )
    throw new SqlError("invalid", "invalid historical receipt selection");
  const ref = kind === "capture-start" ? run.startReceiptRef : run.sealReceiptRef;
  return {
    sql: `SELECT receipt.*,CASE WHEN receipt.attempt_ref IS ? AND receipt.receipt_kind IS ? AND receipt.primary_ref IS ? AND receipt.enrollment_ref IS ? AND receipt.generation IS ? AND receipt.all_rows_match=1 AND typeof(receipt.capture_sequence)='integer' AND receipt.capture_sequence BETWEEN 0 AND 9007199254740991 AND (? IS NULL OR receipt.capture_sequence IS ?) AND root.root_json IS ? AND e.enrollment_incarnation IS ? AND e.generation IS ? AND e.expected_start_receipt_ref IS ? AND e.expected_seal_ref IS ? AND e.previous_start_receipt_ref IS ? AND e.previous_seal_ref IS ? AND e.required_json IS ? THEN 1 ELSE 0 END AS original_matches FROM financial_history_enrollment_receipts receipt LEFT JOIN financial_history_enrollments e ON e.enrollment_ref=receipt.enrollment_ref AND e.primary_ref=receipt.primary_ref LEFT JOIN financial_history_primary_roots root ON root.primary_ref=e.primary_ref WHERE receipt.receipt_ref=?`,
    params: [
      ref,
      kind,
      root.primaryRef,
      run.enrollmentRef,
      run.generation,
      sequence,
      sequence,
      encode(root),
      run.enrollmentIncarnation,
      run.generation,
      run.startReceiptRef,
      run.sealReceiptRef,
      run.previousStartReceiptRef,
      run.previousSealRef,
      encode(run.required),
      ref,
    ],
  };
}
export function createHistoryH0Component(sql: Sql) {
  /** Root hands H0 only its Money writer, created for exactly the root's own writer
   * epoch (as R1 binds its epoch); a raw Sql or another epoch is refused before any
   * SQL. Writes also require the exact fenced 0104 Customer shape. */
  function framed(root: HistoryRoot): void {
    try {
      assertMoneyCutoverSqlOrigin(sql, { writerEpoch: root.writerEpoch });
    } catch {
      throw new SqlError("unavailable", "history writer must be Root's Money writer for its epoch");
    }
  }
  /** Raw diagnostic SELECT only. Completion paths never use this unselected read. */
  async function receipt(ref: string): Promise<Row | null> {
    return (
      (
        await sql.query("SELECT * FROM financial_history_enrollment_receipts WHERE receipt_ref=?", [
          ref,
        ])
      )[0] ?? null
    );
  }
  async function originalReceipt(
    root: HistoryRoot,
    run: HistoryEnrollment,
    kind: "capture-start" | "complete-seal",
    sequence: number | null,
  ): Promise<Row | null> {
    const statement = prepareHistoryReceiptRead(root, run, kind, sequence);
    const row = (await sql.query(statement.sql, statement.params))[0];
    if (!row) return null;
    if (row.original_matches !== 1)
      throw new SqlError("constraint", "original history receipt mismatch");
    const { original_matches: _matches, ...saved } = row;
    return saved;
  }
  return {
    receipt,
    async start(root: HistoryRoot, run: HistoryEnrollment) {
      const fixed = detached(root, run);
      framed(fixed.root);
      const saved = await originalReceipt(fixed.root, fixed.run, "capture-start", null);
      if (saved) return saved;
      const statements = prepareHistoryStart(fixed.root, fixed.run);
      await assertFinancial0104CustomerWriteShape(sql);
      await sql.batch(statements);
      const completed = await originalReceipt(fixed.root, fixed.run, "capture-start", null);
      if (!completed) throw new SqlError("unavailable", "completed history receipt missing");
      return completed;
    },
    async inventory(
      root: HistoryRoot,
      run: HistoryEnrollment,
      evidence: HistoryScope,
      ref: string,
    ) {
      const statement = prepareHistoryInventory(root, run, evidence, ref);
      framed(root);
      await assertFinancial0104CustomerWriteShape(sql);
      const result = await sql.run(statement.sql, statement.params);
      if (result.changes !== 1) throw new SqlError("constraint", "inventory currentness failed");
    },
    async close(root: HistoryRoot, run: HistoryEnrollment) {
      const fixed = detached(root, run);
      framed(fixed.root);
      const statement = prepareHistoryClose(fixed.root, fixed.run);
      await assertFinancial0104CustomerWriteShape(sql);
      const result = await sql.run(statement.sql, statement.params);
      if (result.changes !== 1) throw new SqlError("constraint", "no observed Org change to close");
    },
    async seal(root: HistoryRoot, run: HistoryEnrollment, sequence: number) {
      const fixed = detached(root, run);
      if (!Number.isSafeInteger(sequence) || sequence < 0)
        throw new SqlError("invalid", "invalid capture sequence");
      framed(fixed.root);
      const saved = await originalReceipt(fixed.root, fixed.run, "complete-seal", sequence);
      if (saved) return saved;
      const statements = prepareHistorySeal(fixed.root, fixed.run, sequence);
      await assertFinancial0104CustomerWriteShape(sql);
      await sql.batch(statements);
      const completed = await originalReceipt(fixed.root, fixed.run, "complete-seal", sequence);
      if (!completed) throw new SqlError("unavailable", "completed history receipt missing");
      return completed;
    },
  };
}
