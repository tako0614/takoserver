import { isEdgeFormsApiVersion } from "./edge-family.ts";
import type { ArtifactResolver } from "./engine.ts";
import type { TakoformStoredRelation } from "./relations.ts";
import type { TakoformStore } from "./store.ts";
import type {
  InstalledTakoformForm,
  TakoformCondition,
  TakoformResourceDriver,
  TakoformSqliteMigration,
  TakoformSqliteMigrationIdentity,
  TakoformStoredResource,
} from "./types.ts";
import { TakoformHostError } from "./types.ts";

const SQLITE_APPLICATION = "SQLiteMigrationApplication";
const DATABASE_RELATION = "/database";
const SET_RELATION = "/migrationSet";

interface MigrationContext {
  readonly tenantId: string;
  readonly space: string;
  readonly form: InstalledTakoformForm;
  readonly relations: readonly TakoformStoredRelation[];
  readonly store: Pick<TakoformStore, "readResource">;
  readonly artifacts: ArtifactResolver;
  readonly driver: TakoformResourceDriver;
}

interface MigrationPlan {
  readonly database: TakoformStoredResource;
  readonly desired: readonly TakoformSqliteMigrationIdentity[];
}

export function isSqliteMigrationApplication(form: InstalledTakoformForm): boolean {
  return (
    isEdgeFormsApiVersion(form.identity.formRef.apiVersion) &&
    form.identity.formRef.kind === SQLITE_APPLICATION &&
    form.role === "attachment"
  );
}

/** Validates and applies only the exact unapplied suffix to the target DB. */
export async function applySqliteMigrationApplication(input: MigrationContext): Promise<void> {
  if (!isSqliteMigrationApplication(input.form)) return;
  const executor = input.driver.sqliteMigrations;
  if (!executor) throw new TakoformHostError("unsupported_capability", 422);
  const plan = await migrationPlan(input);
  const applied = await executor.readLedger({ tenantId: input.tenantId, database: plan.database });
  requirePrefix(applied, plan.desired);
  const migrations: TakoformSqliteMigration[] = [];
  for (const migration of plan.desired.slice(applied.length)) {
    const sql = await input.artifacts.resolveBlob(input.tenantId, migration.digest);
    if (!sql) throw new TakoformHostError("artifact_missing", 404);
    migrations.push({ ...migration, sql });
  }
  if (migrations.length > 0) {
    await executor.applySuffix({
      tenantId: input.tenantId,
      database: plan.database,
      expectedPrefix: applied,
      migrations,
    });
  }
  const settled = await executor.readLedger({ tenantId: input.tenantId, database: plan.database });
  if (!sameLedger(settled, plan.desired)) throw new TakoformHostError("backend_unavailable", 503);
}

/** Derived readiness follows the target database's authoritative ledger. */
export async function sqliteMigrationCondition(
  input: MigrationContext,
): Promise<TakoformCondition | null> {
  if (!isSqliteMigrationApplication(input.form)) return null;
  const executor = input.driver.sqliteMigrations;
  if (!executor) {
    return condition("UnsupportedCapability", "SQLite migration execution is unavailable");
  }
  try {
    const plan = await migrationPlan(input);
    const applied = await executor.readLedger({
      tenantId: input.tenantId,
      database: plan.database,
    });
    if (sameLedger(applied, plan.desired)) return null;
    return condition(
      "Reconciling",
      `migration application declares ${plan.desired.length} entries while database ledger has ${applied.length}`,
    );
  } catch (error) {
    if (error instanceof TakoformHostError && error.code === "migration_required") {
      return condition("SpecDrift", "database migration history is not an exact prefix");
    }
    return condition("DependencyMissing", "migration application dependency is unavailable");
  }
}

async function migrationPlan(input: MigrationContext): Promise<MigrationPlan> {
  const database = await relationTarget(input, DATABASE_RELATION);
  const set = await relationTarget(input, SET_RELATION);
  const digest = set.spec.manifestDigest;
  if (typeof digest !== "string") throw new TakoformHostError("artifact_missing", 404);
  const manifest = await input.artifacts.resolveManifest(input.tenantId, digest);
  if (manifest?.kind !== "MigrationBundle" || !manifest.files?.length) {
    throw new TakoformHostError(
      manifest ? "artifact_invalid" : "artifact_missing",
      manifest ? 400 : 404,
    );
  }
  const desired = manifest.files.map((file) => {
    if (file.mediaType !== "application/sql") throw new TakoformHostError("artifact_invalid", 400);
    return { path: file.path, digest: file.digest };
  });
  return { database, desired };
}

async function relationTarget(
  input: MigrationContext,
  pointer: string,
): Promise<TakoformStoredResource> {
  const relation = input.relations.find((candidate) => candidate.relation === pointer);
  if (!relation) throw new TakoformHostError("resource_not_found", 404, { pointer });
  const resource = await input.store.readResource({
    tenantId: input.tenantId,
    space: input.space,
    apiVersion: relation.targetApiVersion,
    kind: relation.targetKind,
    name: relation.targetName,
  });
  if (
    !resource ||
    resource.metadata.uid !== relation.targetUid ||
    resource.form.formRef.definitionVersion !== relation.targetFormRef.definitionVersion ||
    resource.form.formRef.schemaDigest !== relation.targetFormRef.schemaDigest
  ) {
    throw new TakoformHostError("resource_not_found", 404, { pointer });
  }
  return resource;
}

function requirePrefix(
  applied: readonly TakoformSqliteMigrationIdentity[],
  desired: readonly TakoformSqliteMigrationIdentity[],
): void {
  if (
    applied.length > desired.length ||
    applied.some(
      (migration, index) =>
        migration.path !== desired[index]?.path || migration.digest !== desired[index]?.digest,
    )
  ) {
    throw new TakoformHostError("migration_required", 409);
  }
}

function sameLedger(
  left: readonly TakoformSqliteMigrationIdentity[],
  right: readonly TakoformSqliteMigrationIdentity[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (migration, index) =>
        migration.path === right[index]?.path && migration.digest === right[index]?.digest,
    )
  );
}

function condition(reason: TakoformCondition["reason"], hostReason: string): TakoformCondition {
  return {
    type: "Ready",
    status: "False",
    reason,
    hostReason,
    lastTransitionTime: "",
  };
}
