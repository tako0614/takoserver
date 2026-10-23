import { type Sql, SqlError, type SqlStatement, type SqlWrite } from "./ports.ts";

/** A selected Host may write money only inside its own D1 batch permit. */
export const MONEY_CUTOVER_WRITER_POLICY = "transaction-fenced-usd-micros-v1" as const;
export const MONEY_CUTOVER_EPOCH = "usd-micros-v2" as const;
export const MONEY_CUTOVER_WRITER_EPOCH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
export const MONEY_CUTOVER_FREEZE_TABLE = "money_cutover_freeze" as const;
export const MONEY_CUTOVER_FREEZE_DDL = `CREATE TABLE ${MONEY_CUTOVER_FREEZE_TABLE} (singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1), binding_digest TEXT NOT NULL, origin_digest TEXT NOT NULL, backup_digest TEXT NOT NULL, writer_digest TEXT NOT NULL, source_digest TEXT NOT NULL)`;
export const MONEY_CUTOVER_PERMIT_TABLE = "money_cutover_writer_permit" as const;
export const MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE = "money_cutover_authorized_epoch" as const;
export const MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL = `CREATE TABLE ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE} (singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1), writer_epoch TEXT NOT NULL CHECK (length(writer_epoch) = 71 AND substr(writer_epoch, 1, 7) = 'sha256:'))`;
export const MONEY_CUTOVER_PERMIT_DDL = `CREATE TABLE ${MONEY_CUTOVER_PERMIT_TABLE} (singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1), epoch TEXT NOT NULL CHECK (epoch = '${MONEY_CUTOVER_EPOCH}'), writer_epoch TEXT NOT NULL CHECK (length(writer_epoch) = 71 AND substr(writer_epoch, 1, 7) = 'sha256:'))`;
export const MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL = `CREATE TRIGGER money_cutover_permit_epoch_guard BEFORE INSERT ON ${MONEY_CUTOVER_PERMIT_TABLE} WHEN NEW.writer_epoch <> (SELECT writer_epoch FROM ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE} WHERE singleton = 1) OR NOT EXISTS (SELECT 1 FROM ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE} WHERE singleton = 1) BEGIN SELECT RAISE(ABORT, 'money cutover Writer epoch revoked'); END`;

/** Fixed 0092 public financial write surface, including indirect sponsorship writes. */
export const MONEY_CUTOVER_FINANCIAL_TABLES = [
  "ledger",
  "wallet_credit_lots",
  "wallet_credit_allocations",
  "wallet_allocation_guards",
  "quotes",
  "reservations",
  "usage_statements",
  "usage_events",
  "idempotency",
  "reseller_settlement_intents",
  "reseller_settlement_guards",
  "stripe_events",
  "org_wallet_holds",
  "org_wallet_usage_records",
  "org_wallet_grant_snapshots",
  "org_wallet_pricing_revisions",
  "org_wallet_monthly_tariffs",
  "sponsorship_tenants",
  "sponsorship_resources",
  "sponsorship_credential_issuance_operations",
] as const;

/**
 * The later Stripe customer guard generation: the Stripe tables a Financial
 * Customer batch writes. It exists only on a guarded primary that also holds
 * 0104's Customer link table, because the only guarded path that creates that
 * table (the Root post-Auth103 chain on a Money-preserved target) installs
 * these fences in the same import. Never installed by a numbered migration;
 * pre-cutover and self-host primaries keep raw Sql and carry no fence.
 */
export const MONEY_CUTOVER_STRIPE_CUSTOMER_TABLES = [
  "stripe_billing_customers",
  "stripe_billing_customer_commands",
  "stripe_customer_admission_links",
] as const;
/** The 0104 table whose presence on a guarded primary selects that generation. */
export const MONEY_CUTOVER_STRIPE_CUSTOMER_GENERATION_TABLE = "stripe_customer_admission_links";
export type MoneyCutoverGuardGeneration = "financial-0092" | "stripe-customer-0104";

function moneyCutoverFenceTriggerSql(table: string, verb: "INSERT" | "UPDATE" | "DELETE"): string {
  return `CREATE TRIGGER money_cutover_fence_${table}_${verb.toLowerCase()} BEFORE ${verb} ON ${table} WHEN EXISTS (SELECT 1 FROM ${MONEY_CUTOVER_FREEZE_TABLE}) OR NOT EXISTS (SELECT 1 FROM ${MONEY_CUTOVER_PERMIT_TABLE} AS permit JOIN ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE} AS authorized ON authorized.singleton = 1 AND authorized.writer_epoch = permit.writer_epoch WHERE permit.singleton = 1 AND permit.epoch = '${MONEY_CUTOVER_EPOCH}') BEGIN SELECT RAISE(ABORT, 'money cutover writer permit required'); END`;
}

export function moneyCutoverFinancialTriggerSql(
  table: string,
  verb: "INSERT" | "UPDATE" | "DELETE",
): string {
  if (!(MONEY_CUTOVER_FINANCIAL_TABLES as readonly string[]).includes(table)) {
    throw new TypeError("unknown money cutover financial table");
  }
  return moneyCutoverFenceTriggerSql(table, verb);
}

/** The same permit/freeze fence shape on one Stripe customer generation table. */
export function moneyCutoverStripeCustomerTriggerSql(
  table: string,
  verb: "INSERT" | "UPDATE" | "DELETE",
): string {
  if (!(MONEY_CUTOVER_STRIPE_CUSTOMER_TABLES as readonly string[]).includes(table)) {
    throw new TypeError("unknown money cutover Stripe customer table");
  }
  return moneyCutoverFenceTriggerSql(table, verb);
}

/** Exact [name, sql] Stripe customer generation fences, in table/verb order. */
export function moneyCutoverStripeCustomerGuardDefinitions(): readonly (readonly [
  string,
  string,
])[] {
  return MONEY_CUTOVER_STRIPE_CUSTOMER_TABLES.flatMap((table) =>
    (["INSERT", "UPDATE", "DELETE"] as const).map(
      (verb) =>
        [
          `money_cutover_fence_${table}_${verb.toLowerCase()}`,
          moneyCutoverStripeCustomerTriggerSql(table, verb),
        ] as const,
    ),
  );
}

export function moneyCutoverClassificationTriggerSql(verb: "INSERT" | "UPDATE" | "DELETE"): string {
  return `CREATE TRIGGER money_cutover_fence_wallet_credit_lot_classification_proofs_${verb.toLowerCase()} BEFORE ${verb} ON wallet_credit_lot_classification_proofs BEGIN SELECT RAISE(ABORT, 'money cutover frozen'); END`;
}

export type MoneyCutoverGuardState = "frozen" | "ready";

/** Read-only exact guard proof, before any selected-target application startup write. */
export async function inspectMoneyCutoverGuard(
  sql: Sql,
  writerEpoch: string,
): Promise<MoneyCutoverGuardState> {
  if (!MONEY_CUTOVER_WRITER_EPOCH_PATTERN.test(writerEpoch))
    throw new SqlError("invalid", "money cutover Writer epoch is invalid");
  const names = [
    MONEY_CUTOVER_FREEZE_TABLE,
    MONEY_CUTOVER_PERMIT_TABLE,
    MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE,
    "money_cutover_permit_epoch_guard",
    ...[...MONEY_CUTOVER_FINANCIAL_TABLES, "wallet_credit_lot_classification_proofs"].flatMap(
      (table) =>
        ["INSERT", "UPDATE", "DELETE"].map(
          (verb) => `money_cutover_fence_${table}_${verb.toLowerCase()}`,
        ),
    ),
  ];
  const stripe = moneyCutoverStripeCustomerGuardDefinitions();
  const generationNames = [
    MONEY_CUTOVER_STRIPE_CUSTOMER_GENERATION_TABLE,
    ...stripe.map(([name]) => name),
  ];
  const lookup = [...names, ...generationNames];
  const found = await sql.query(
    `SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name IN (${lookup.map(() => "?").join(", ")}) ORDER BY name`,
    lookup,
  );
  const rows = found.filter((row) => !generationNames.includes(row.name as string));
  if (rows.length !== names.length)
    throw new SqlError("invalid", "money cutover guard is incomplete");
  const byName = new Map(rows.map((row) => [row.name, row]));
  // Explicit generation: 0104's Customer link table on a guarded primary means
  // the Stripe customer generation was installed with it, so all of its fences
  // must be exact; before it, none of them may exist. Partial is refused.
  const generationTable = found.filter(
    (row) => row.name === MONEY_CUTOVER_STRIPE_CUSTOMER_GENERATION_TABLE,
  );
  const stripeFences = new Map(
    found
      .filter(
        (row) =>
          row.name !== MONEY_CUTOVER_STRIPE_CUSTOMER_GENERATION_TABLE &&
          generationNames.includes(row.name as string),
      )
      .map((row) => [row.name, row]),
  );
  if (
    generationTable.length > 1 ||
    (generationTable.length === 1 &&
      (generationTable[0]?.type !== "table" ||
        generationTable[0]?.tbl_name !== MONEY_CUTOVER_STRIPE_CUSTOMER_GENERATION_TABLE))
  )
    throw new SqlError("invalid", "money cutover guard generation differs");
  if (generationTable.length === 0) {
    if (stripeFences.size !== 0)
      throw new SqlError("invalid", "money cutover Stripe customer fence predates its generation");
  } else if (
    stripeFences.size !== stripe.length ||
    stripe.some(([name, definition]) => {
      const row = stripeFences.get(name);
      return row?.type !== "trigger" || row.sql !== definition;
    })
  ) {
    throw new SqlError("invalid", "money cutover Stripe customer trigger differs");
  }
  if (
    byName.get(MONEY_CUTOVER_PERMIT_TABLE)?.type !== "table" ||
    byName.get(MONEY_CUTOVER_PERMIT_TABLE)?.sql !== MONEY_CUTOVER_PERMIT_DDL ||
    byName.get(MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE)?.type !== "table" ||
    byName.get(MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE)?.sql !== MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL ||
    byName.get("money_cutover_permit_epoch_guard")?.type !== "trigger" ||
    byName.get("money_cutover_permit_epoch_guard")?.sql !== MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL ||
    byName.get(MONEY_CUTOVER_FREEZE_TABLE)?.type !== "table" ||
    byName.get(MONEY_CUTOVER_FREEZE_TABLE)?.sql !== MONEY_CUTOVER_FREEZE_DDL
  ) {
    throw new SqlError("invalid", "money cutover guard table differs");
  }
  for (const verb of ["INSERT", "UPDATE", "DELETE"] as const) {
    const name = `money_cutover_fence_wallet_credit_lot_classification_proofs_${verb.toLowerCase()}`;
    const row = byName.get(name);
    if (row?.type !== "trigger" || row.sql !== moneyCutoverClassificationTriggerSql(verb)) {
      throw new SqlError("invalid", "money cutover classification trigger differs");
    }
  }
  for (const table of MONEY_CUTOVER_FINANCIAL_TABLES) {
    for (const verb of ["INSERT", "UPDATE", "DELETE"] as const) {
      const name = `money_cutover_fence_${table}_${verb.toLowerCase()}`;
      const row = byName.get(name);
      if (row?.type !== "trigger" || row.sql !== moneyCutoverFinancialTriggerSql(table, verb)) {
        throw new SqlError("invalid", "money cutover financial trigger differs");
      }
    }
  }
  const [freeze, permit, authorized, policy] = await Promise.all([
    sql.query(
      `SELECT singleton, binding_digest, origin_digest, backup_digest, writer_digest, source_digest FROM ${MONEY_CUTOVER_FREEZE_TABLE}`,
    ),
    sql.query(`SELECT singleton, epoch, writer_epoch FROM ${MONEY_CUTOVER_PERMIT_TABLE}`),
    sql.query(`SELECT singleton, writer_epoch FROM ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE}`),
    sql.query(
      "SELECT singleton, ledger_unit, historical_usage_unit, cash_unit FROM money_unit_policy",
    ),
  ]);
  if (
    permit.length !== 0 ||
    authorized.length !== 1 ||
    authorized[0]?.singleton !== 1 ||
    authorized[0]?.writer_epoch !== writerEpoch ||
    policy.length !== 1 ||
    policy[0]?.singleton !== 1 ||
    policy[0]?.ledger_unit !== MONEY_CUTOVER_EPOCH ||
    policy[0]?.historical_usage_unit !== "microcent-v1" ||
    policy[0]?.cash_unit !== "usd-cents-v1"
  ) {
    throw new SqlError("invalid", "money cutover permit or policy differs");
  }
  if (freeze.length === 0) return "ready";
  if (
    freeze.length !== 1 ||
    freeze[0]?.singleton !== 1 ||
    ![
      freeze[0]?.binding_digest,
      freeze[0]?.origin_digest,
      freeze[0]?.backup_digest,
      freeze[0]?.writer_digest,
      freeze[0]?.source_digest,
    ].every((value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value))
  ) {
    throw new SqlError("invalid", "money cutover freeze row differs");
  }
  return "frozen";
}

function ownDataSqlMethod<K extends keyof Sql>(sql: Sql, name: K): Sql[K] | undefined {
  if ((typeof sql !== "object" && typeof sql !== "function") || sql === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(sql, name);
  return descriptor && "value" in descriptor && typeof descriptor.value === "function"
    ? (descriptor.value as Sql[K])
    : undefined;
}

const moneyCutoverSqlOrigins = new WeakMap<
  object,
  {
    readonly raw: Sql;
    readonly writerEpoch: string;
    readonly query: Sql["query"];
    readonly run: Sql["run"];
    readonly batch: Sql["batch"];
    readonly rawQuery: Sql["query"] | undefined;
    readonly rawRun: Sql["run"] | undefined;
    readonly rawBatch: Sql["batch"] | undefined;
  }
>();

/**
 * Checks an actual wrapper's captured epoch and original methods. This neither
 * exposes its raw Sql nor replaces the current permit/freeze guards on writes.
 */
export function assertMoneyCutoverSqlOrigin(
  sql: unknown,
  context: { readonly writerEpoch: string },
): asserts sql is Sql {
  const origin =
    typeof sql === "object" && sql !== null ? moneyCutoverSqlOrigins.get(sql) : undefined;
  if (!origin || typeof context !== "object" || context === null) {
    throw new SqlError("invalid", "money cutover Sql origin differs");
  }
  const writerEpoch = Object.getOwnPropertyDescriptor(context, "writerEpoch");
  const query = Object.getOwnPropertyDescriptor(sql, "query");
  const run = Object.getOwnPropertyDescriptor(sql, "run");
  const batch = Object.getOwnPropertyDescriptor(sql, "batch");
  if (
    !writerEpoch ||
    !("value" in writerEpoch) ||
    writerEpoch.value !== origin.writerEpoch ||
    !query ||
    !("value" in query) ||
    query.value !== origin.query ||
    !run ||
    !("value" in run) ||
    run.value !== origin.run ||
    !batch ||
    !("value" in batch) ||
    batch.value !== origin.batch
  ) {
    throw new SqlError("invalid", "money cutover Sql origin differs");
  }
}

/**
 * Checks that a captured wrapper still belongs to the exact backing Sql and
 * epoch supplied by its caller. This is origin evidence only; it does not
 * qualify the backing adapter, selected realm, schema, or writer profile.
 */
export function assertMoneyCutoverSqlBackingOrigin(
  sql: unknown,
  context: { readonly rawSql: Sql; readonly writerEpoch: string },
): void {
  assertMoneyCutoverSqlOrigin(sql, context);
  const origin = moneyCutoverSqlOrigins.get(sql);
  const rawSql = Object.getOwnPropertyDescriptor(context, "rawSql");
  if (
    !origin ||
    !rawSql ||
    !("value" in rawSql) ||
    rawSql.value !== origin.raw ||
    origin.rawQuery === undefined ||
    origin.rawRun === undefined ||
    origin.rawBatch === undefined ||
    ownDataSqlMethod(origin.raw, "query") !== origin.rawQuery ||
    ownDataSqlMethod(origin.raw, "run") !== origin.rawRun ||
    ownDataSqlMethod(origin.raw, "batch") !== origin.rawBatch
  ) {
    throw new SqlError("invalid", "money cutover Sql backing origin differs");
  }
}

function assertPublicStatement(statement: SqlStatement): void {
  const source = statement.sql.trim();
  if (
    /\b(?:money_cutover_freeze|money_cutover_writer_permit|money_cutover_authorized_epoch)\b/iu.test(
      source,
    ) ||
    !/^(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\b/iu.test(source) ||
    /;[\s\S]*\S/iu.test(source.replace(/;\s*$/u, ""))
  )
    throw new SqlError("invalid", "money cutover Writer statement is outside the guarded surface");
}

/** Fresh Auth103 uses the same public SQL surface, without a Money permit or epoch. */
const freshNativeSqlOrigins = new WeakMap<
  object,
  {
    readonly raw: Sql;
    readonly methods: readonly [Sql["query"], Sql["run"], Sql["batch"]];
    readonly rawMethods: readonly [
      Sql["query"] | undefined,
      Sql["run"] | undefined,
      Sql["batch"] | undefined,
    ];
  }
>();

export function assertFreshNativeSqlBackingOrigin(sql: unknown, rawSql: Sql): asserts sql is Sql {
  const origin =
    typeof sql === "object" && sql !== null ? freshNativeSqlOrigins.get(sql) : undefined;
  if (
    !origin ||
    origin.raw !== rawSql ||
    ownDataSqlMethod(sql as Sql, "query") !== origin.methods[0] ||
    ownDataSqlMethod(sql as Sql, "run") !== origin.methods[1] ||
    ownDataSqlMethod(sql as Sql, "batch") !== origin.methods[2] ||
    ownDataSqlMethod(rawSql, "query") !== origin.rawMethods[0] ||
    ownDataSqlMethod(rawSql, "run") !== origin.rawMethods[1] ||
    ownDataSqlMethod(rawSql, "batch") !== origin.rawMethods[2]
  )
    throw new SqlError("invalid", "fresh native Sql backing origin differs");
}

/** This wrapper is provisional until Auth103's native origin qualifies Accounts/RP. */
export function createFreshNativeSql(raw: Sql): Sql {
  const batch: Sql["batch"] = async (statements) => {
    statements.forEach(assertPublicStatement);
    return await raw.batch(statements);
  };
  const wrapped: Sql = {
    async query(sql, params) {
      const head = sql.trimStart();
      if (
        (/^SELECT\b/iu.test(head) || /^PRAGMA\s+table_info\s*\(/iu.test(head)) &&
        !/;[\s\S]*\S/iu.test(head.replace(/;\s*$/u, ""))
      ) {
        if (/^SELECT\b/iu.test(head)) assertPublicStatement({ sql });
        return await raw.query(sql, params);
      }
      if (
        /^WITH\b/iu.test(head) ||
        /^UPDATE\s+(?:tf_v2_worker_invocations|tf_v2_operations)\b/iu.test(head)
      )
        return (await batch([{ sql, ...(params === undefined ? {} : { params }) }]))[0]?.rows ?? [];
      throw new SqlError("invalid", "fresh native query is outside the public surface");
    },
    async run(sql, params) {
      assertPublicStatement({ sql, ...(params === undefined ? {} : { params }) });
      return await raw.run(sql, params);
    },
    batch,
  };
  freshNativeSqlOrigins.set(
    wrapped,
    Object.freeze({
      raw,
      methods: [wrapped.query, wrapped.run, wrapped.batch] as const,
      rawMethods: [
        ownDataSqlMethod(raw, "query"),
        ownDataSqlMethod(raw, "run"),
        ownDataSqlMethod(raw, "batch"),
      ] as const,
    }),
  );
  return wrapped;
}

/** All selected-Host mutations are one D1 transaction. A failed batch leaves no permit. */
export function createMoneyCutoverSql(raw: Sql, writerEpoch: string): Sql {
  if (!MONEY_CUTOVER_WRITER_EPOCH_PATTERN.test(writerEpoch))
    throw new SqlError("invalid", "money cutover Writer epoch is invalid");
  const permitInsert: SqlStatement = {
    sql: `INSERT INTO ${MONEY_CUTOVER_PERMIT_TABLE} (singleton, epoch, writer_epoch) VALUES (1, '${MONEY_CUTOVER_EPOCH}', ?)`,
    params: [writerEpoch],
  };
  const permitDelete: SqlStatement = {
    sql: `DELETE FROM ${MONEY_CUTOVER_PERMIT_TABLE} WHERE singleton = 1 AND epoch = '${MONEY_CUTOVER_EPOCH}' AND writer_epoch = ?`,
    params: [writerEpoch],
  };
  async function guarded(statements: readonly SqlStatement[]): Promise<readonly SqlWrite[]> {
    if (statements.length === 0) return [];
    statements.forEach(assertPublicStatement);
    const result = await raw.batch([permitInsert, ...statements, permitDelete]);
    if (
      result.length !== statements.length + 2 ||
      result[0]?.changes !== 1 ||
      result.at(-1)?.changes !== 1
    ) {
      throw new SqlError("unavailable", "money cutover permit batch acknowledgement is incomplete");
    }
    return result.slice(1, -1);
  }
  const wrapped: Sql = {
    async query(sql, params) {
      // SELECT and the one audited introspection PRAGMA cannot mutate SQLite.
      // WITH (including a mutating final statement) takes the guarded transaction.
      // Two audited Takoform UPDATE...RETURNING query sites also need that path.
      const head = sql.trimStart();
      if (
        (/^SELECT\b/iu.test(head) || /^PRAGMA\s+table_info\s*\(/iu.test(head)) &&
        !/;[\s\S]*\S/iu.test(head.replace(/;\s*$/u, ""))
      ) {
        if (/^SELECT\b/iu.test(head)) assertPublicStatement({ sql });
        return raw.query(sql, params);
      }
      if (
        /^WITH\b/iu.test(head) ||
        /^UPDATE\s+(?:tf_v2_worker_invocations|tf_v2_operations)\b/iu.test(head)
      ) {
        return (
          (await guarded([{ sql, ...(params === undefined ? {} : { params }) }]))[0]?.rows ?? []
        );
      }
      throw new SqlError(
        "invalid",
        "money cutover query is not in the audited read or guarded-returning surface",
      );
    },
    async run(sql, params) {
      return (await guarded([{ sql, ...(params === undefined ? {} : { params }) }]))[0] as SqlWrite;
    },
    batch: guarded,
  };
  moneyCutoverSqlOrigins.set(
    wrapped,
    Object.freeze({
      raw,
      writerEpoch,
      query: wrapped.query,
      run: wrapped.run,
      batch: wrapped.batch,
      rawQuery: ownDataSqlMethod(raw, "query"),
      rawRun: ownDataSqlMethod(raw, "run"),
      rawBatch: ownDataSqlMethod(raw, "batch"),
    }),
  );
  return wrapped;
}
