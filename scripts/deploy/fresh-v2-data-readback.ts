import { RemoteD1 } from "./d1.ts";
import { DeployError } from "./errors.ts";
import { type CommandResult, runCommand, wranglerCommand } from "./process.ts";

/**
 * The closed fresh v2 D1 profiles. Each names one reviewed, fixed-digest
 * payload; a later audited source migration never widens any selector.
 * `v2-0091` and `v2-0092` are staging-only: only the integration generation
 * surface offers them.
 */
export type FreshV2D1Lineage = "v2-0088" | "v2-0089" | "v2-0091" | "v2-0092";

/** The exact migration-ledger row count each fresh profile leaves behind. */
const FRESH_V2_LEDGER_ROWS: Readonly<Record<FreshV2D1Lineage, number>> = {
  "v2-0088": 88,
  "v2-0089": 89,
  "v2-0091": 91,
  "v2-0092": 92,
};

export interface FreshV2DataReadback {
  readonly tableCounts: Readonly<Record<string, number>>;
  readonly ledgerRows: number;
  readonly foreignKeyViolations: number;
  readonly invocationEpoch: readonly Record<string, unknown>[];
  readonly acceptanceCounter: readonly Record<string, unknown>[];
}

/** Test seam; deploy callers always use authoritative remote D1 queries. */
export interface FreshV2DataReader {
  read(phase: "preflight" | "verification", configPath: string): Promise<FreshV2DataReadback>;
}

export interface FreshV2DataReadbackOptions {
  readonly freshV2DataReader?: FreshV2DataReader;
  readonly run?: (
    command: readonly string[],
    options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
  ) => Promise<CommandResult>;
  readonly wranglerCommand?: (args: readonly string[]) => readonly string[];
  readonly wranglerPath?: string;
  /**
   * Tables a named pre-Host owner may already have written (for example the
   * append-only signing registration in `runtime_grant_keys`). Every other
   * table must still be exactly as the migrations left it.
   */
  readonly allowedTables?: readonly string[];
}

const FRESH_V2_SEED_TABLES = [
  "tf_cloudflare_provider_invocation_epoch",
  "tf_v2_operation_acceptance_counter",
] as const;

/**
 * Data proof in addition to the canonical schema/ledger readback, never a
 * prefix heuristic: the exact ledger count, no foreign-key violation, every
 * audited application table empty except the two migration-owned seeds, and
 * those seeds exactly as the migrations wrote them.
 */
export async function assertFreshV2DataReadback(
  phase: "preflight" | "verification",
  lineage: FreshV2D1Lineage,
  configPath: string,
  environment: Readonly<Record<string, string>>,
  expectedApplicationShape: string,
  options: FreshV2DataReadbackOptions,
): Promise<void> {
  const shape: unknown = JSON.parse(expectedApplicationShape);
  if (!Array.isArray(shape)) throw new DeployError(phase, "fresh v2 expected shape is malformed");
  const tables = shape
    .filter(
      (row): row is { type: string; name: string } =>
        typeof row === "object" &&
        row !== null &&
        row.type === "table" &&
        typeof row.name === "string",
    )
    .map(({ name }) => name);
  if (
    tables.length === 0 ||
    new Set(tables).size !== tables.length ||
    tables.some((name) => !/^[A-Za-z_][A-Za-z_0-9]*$/u.test(name))
  ) {
    throw new DeployError(phase, "fresh v2 audited table inventory is malformed");
  }
  const readback =
    options.freshV2DataReader === undefined
      ? await readRemoteFreshV2Data(configPath, environment, tables, phase, options)
      : await options.freshV2DataReader.read(phase, configPath);
  const allowed = new Set(options.allowedTables ?? []);
  if ([...allowed].some((name) => !tables.includes(name)))
    throw new DeployError(phase, "fresh v2 allowed table is not part of the audited schema");
  if (
    readback.ledgerRows !== FRESH_V2_LEDGER_ROWS[lineage] ||
    readback.foreignKeyViolations !== 0 ||
    Object.keys(readback.tableCounts).length !== tables.length ||
    FRESH_V2_SEED_TABLES.some((name) => !tables.includes(name)) ||
    tables.some((name) =>
      allowed.has(name)
        ? !Number.isSafeInteger(readback.tableCounts[name]) ||
          (readback.tableCounts[name] as number) < 0
        : readback.tableCounts[name] !==
          (FRESH_V2_SEED_TABLES.includes(name as (typeof FRESH_V2_SEED_TABLES)[number]) ? 1 : 0),
    ) ||
    !matchesFreshV2Seed(
      readback.invocationEpoch,
      ["closed_at_ms", "epoch_id", "opened_at_ms", "singleton", "state"],
      { singleton: 1, epoch_id: null, state: "closed", opened_at_ms: null, closed_at_ms: null },
    ) ||
    !matchesFreshV2Seed(readback.acceptanceCounter, ["id", "last_operation_id", "last_order"], {
      id: 1,
      last_order: 0,
      last_operation_id: null,
    })
  ) {
    throw new DeployError(
      phase,
      `fresh v2 D1 is not the exact empty ${String(FRESH_V2_LEDGER_ROWS[lineage]).padStart(4, "0")} database`,
    );
  }
}

function matchesFreshV2Seed(
  rows: readonly Record<string, unknown>[],
  expectedKeys: readonly string[],
  expected: Readonly<Record<string, unknown>>,
): boolean {
  if (rows.length !== 1) return false;
  const row = rows[0];
  return (
    row !== undefined &&
    JSON.stringify(Object.keys(row).sort()) === JSON.stringify(expectedKeys) &&
    expectedKeys.every((key) => row[key] === expected[key])
  );
}

async function readRemoteFreshV2Data(
  configPath: string,
  environment: Readonly<Record<string, string>>,
  tables: readonly string[],
  phase: "preflight" | "verification",
  options: FreshV2DataReadbackOptions,
): Promise<FreshV2DataReadback> {
  const database = new RemoteD1(configPath, {
    environment,
    run: options.run ?? runCommand,
    wranglerCommand:
      options.wranglerCommand ??
      (options.wranglerPath === undefined
        ? wranglerCommand
        : (args) => [options.wranglerPath as string, ...args]),
  });
  const tableCounts: Record<string, number> = {};
  for (let index = 0; index < tables.length; index += 16) {
    const batch = tables.slice(index, index + 16);
    const sql = `SELECT ${batch.map((name) => `(SELECT COUNT(*) FROM "${name}") AS "${name}"`).join(", ")}`;
    const rows = await database.query(phase, "fresh v2 application row counts", sql);
    if (rows.length !== 1 || Object.keys(rows[0] ?? {}).length !== batch.length) {
      throw new DeployError(phase, "fresh v2 application row counts are malformed");
    }
    for (const name of batch) {
      const value = rows[0]?.[name];
      if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new DeployError(phase, "fresh v2 application row count is malformed");
      }
      tableCounts[name] = value as number;
    }
  }
  const ledger = await database.query(
    phase,
    "fresh v2 migration ledger count",
    "SELECT COUNT(*) AS count FROM d1_migrations",
  );
  if (ledger.length !== 1 || !Number.isSafeInteger(ledger[0]?.count)) {
    throw new DeployError(phase, "fresh v2 migration ledger count is malformed");
  }
  const foreignKeys = await database.query(
    phase,
    "fresh v2 foreign-key integrity",
    "SELECT 1 AS violation FROM pragma_foreign_key_check LIMIT 1",
  );
  const invocationEpoch = await database.query(
    phase,
    "fresh v2 invocation epoch seed",
    "SELECT singleton, epoch_id, state, opened_at_ms, closed_at_ms FROM tf_cloudflare_provider_invocation_epoch LIMIT 2",
  );
  const acceptanceCounter = await database.query(
    phase,
    "fresh v2 acceptance counter seed",
    "SELECT id, last_order, last_operation_id FROM tf_v2_operation_acceptance_counter LIMIT 2",
  );
  return {
    tableCounts,
    ledgerRows: ledger[0]?.count as number,
    foreignKeyViolations: foreignKeys.length,
    invocationEpoch,
    acceptanceCounter,
  };
}
