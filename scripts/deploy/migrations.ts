import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RemoteD1 } from "./d1.ts";
import { type DeployPhase, mutationError, preflightError, verificationError } from "./errors.ts";
import { REPOSITORY } from "./process.ts";

const MIGRATION_NAME = /^([0-9]{4})_[a-z0-9_]+\.sql$/u;

export interface MigrationFile {
  readonly name: string;
  readonly path: string;
  readonly digest: string;
  readonly bytes: number;
}

export interface MigrationArtifact {
  readonly files: readonly MigrationFile[];
  readonly names: readonly string[];
  readonly digest: string;
  readonly bytes: number;
}

/** Exact ordered local migration bytes; links and numbering gaps are refused. */
export function readMigrationArtifact(
  directory = resolve(REPOSITORY, "migrations"),
): MigrationArtifact {
  const root = realpathSync(directory);
  const names = readdirSync(root).sort();
  if (names.length === 0) throw preflightError("no D1 migrations are declared");
  const files = names.map((name, index): MigrationFile => {
    const match = MIGRATION_NAME.exec(name);
    if (!match || Number(match[1]) !== index + 1) {
      throw preflightError(
        "D1 migration names must be one gap-free ordered 0001_*.sql lineage",
        `position=${index + 1} name=${JSON.stringify(name)}`,
      );
    }
    const path = join(root, name);
    const status = lstatSync(path);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
      throw preflightError(`D1 migration is not a link-free regular file: ${name}`);
    }
    const body = readFileSync(path);
    if (body.byteLength === 0) throw preflightError(`D1 migration is empty: ${name}`);
    return {
      name,
      path,
      digest: sha256(body),
      bytes: body.byteLength,
    };
  });
  const hash = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    const body = readFileSync(file.path);
    hash.update(file.name);
    hash.update("\0");
    hash.update(String(body.byteLength));
    hash.update("\0");
    hash.update(body);
    bytes += body.byteLength;
  }
  return {
    files,
    names: files.map(({ name }) => name),
    digest: `sha256:${hash.digest("hex")}`,
    bytes,
  };
}

/** Applied rows must be exactly the prefix Wrangler would extend. */
/** The migration that creates `stripe_events`, which every webhook delivery writes. */
export const STRIPE_EVENTS_MIGRATION = "0091_stripe_events.sql";
/** Durable Organization hold, usage, grant, and tariff lifecycle. */
export const ORG_BILLING_MIGRATION = "0092_org_wallet_lifecycle.sql";

/**
 * A target that asks for the Stripe webhook must already hold the table the
 * webhook records into. Without it every delivery fails until Stripe disables
 * the endpoint, so publication is refused before anything is uploaded.
 */
export function stripeWebhookSchemaReady(
  target: { readonly stripeWebhook?: boolean },
  applied: readonly string[],
): boolean {
  return target.stripeWebhook !== true || applied.includes(STRIPE_EVENTS_MIGRATION);
}

export function assertStripeWebhookSchema(
  target: { readonly stripeWebhook?: boolean },
  applied: readonly string[],
): void {
  if (!stripeWebhookSchemaReady(target, applied)) {
    throw preflightError(
      `the Stripe webhook needs ${STRIPE_EVENTS_MIGRATION} applied to this D1 before publication`,
      `applied=${applied.length}`,
    );
  }
}

/** Billing is opt-in in the realized Worker target and requires its full lineage first. */
export function orgBillingSchemaReady(
  target: { readonly billingConfig?: unknown },
  applied: readonly string[],
): boolean {
  return target.billingConfig === undefined || applied.includes(ORG_BILLING_MIGRATION);
}

export function assertOrgBillingSchema(
  target: { readonly billingConfig?: unknown },
  applied: readonly string[],
): void {
  if (!orgBillingSchemaReady(target, applied)) {
    throw preflightError(
      `Organization billing needs ${ORG_BILLING_MIGRATION} applied to this D1 before publication`,
      `applied=${applied.length}`,
    );
  }
}

export function pendingMigrations(
  local: readonly string[],
  applied: readonly string[],
): readonly string[] {
  if (applied.length > local.length) {
    throw preflightError(
      "D1 has more applied migrations than the selected source",
      `local=${JSON.stringify(local)} applied=${JSON.stringify(applied)}`,
    );
  }
  for (const [index, name] of applied.entries()) {
    if (local[index] !== name) {
      throw preflightError(
        `D1 migration lineage diverges at position ${index + 1}`,
        `local=${JSON.stringify(local)} applied=${JSON.stringify(applied)}`,
      );
    }
  }
  return local.slice(applied.length);
}

export interface D1SchemaState {
  readonly applied: readonly string[];
  readonly shape: string;
  readonly shapeDigest: string;
}

/** Strict D1 lineage plus a canonical sqlite_schema shape. */
export async function readD1SchemaState(
  database: RemoteD1,
  phase: DeployPhase = "preflight",
): Promise<D1SchemaState> {
  const tables = await database.column(
    phase,
    "D1 table inventory",
    "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    "name",
  );
  const applied = tables.includes("d1_migrations")
    ? await database.column(
        phase,
        "D1 migration lineage",
        "SELECT name FROM d1_migrations ORDER BY id",
        "name",
      )
    : [];
  const rows = await database.query(
    phase,
    "D1 canonical schema shape",
    "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql " +
      "FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
  );
  const shape = canonicalSchemaShape(rows, phase);
  return { applied, shape, shapeDigest: sha256(shape) };
}

export function canonicalSchemaShape(
  rows: readonly Record<string, unknown>[],
  phase: DeployPhase = "preflight",
): string {
  const normalized = rows.map((row) => {
    for (const field of ["type", "name", "tbl_name", "sql"] as const) {
      if (typeof row[field] !== "string") {
        throw schemaShapeError(
          phase,
          `D1 schema shape row has no string ${field}`,
          schemaRowDetail(row),
        );
      }
    }
    return {
      type: row.type as string,
      name: row.name as string,
      table: row.tbl_name as string,
      sql: row.sql as string,
    };
  });
  const sorted = [...normalized].sort((left, right) =>
    `${left.type}\0${left.name}`.localeCompare(`${right.type}\0${right.name}`),
  );
  if (JSON.stringify(normalized) !== JSON.stringify(sorted)) {
    throw schemaShapeError(phase, "D1 schema shape readback is not canonically ordered");
  }
  return `${JSON.stringify(normalized)}\n`;
}

function schemaShapeError(phase: DeployPhase, message: string, detail?: string) {
  return phase === "preflight"
    ? preflightError(message, detail)
    : phase === "mutation"
      ? mutationError(message, detail)
      : verificationError(message, detail);
}

function schemaRowDetail(row: Record<string, unknown>): string {
  return JSON.stringify({ keys: Object.keys(row).sort() });
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
