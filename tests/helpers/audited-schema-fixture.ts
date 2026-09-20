import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MIGRATIONS } from "../../src/db-schema.ts";

/** Frozen catch-up-wave source, distinct from the current integration schema. */
export function copyAuditedSchemaFixture(directory: string): string {
  const prefix = MIGRATIONS.slice(0, 49);
  if (prefix.at(-1)?.name !== "0049_artifact_consumer_active_resolution.sql") {
    throw new Error("audited schema fixture requires the historical 0001-0049 prefix");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const { name } of prefix) {
    // Copy the actual source bytes: the production guard still checks every
    // frozen filename and hash, so an edited historical migration must fail.
    copyFileSync(resolve(import.meta.dir, "../../migrations", name), join(directory, name));
  }
  return directory;
}

/** Current audited source, including the additive 0050/0051 workflow tables,
 * 0052 termination intent, 0053 Queue custody state, its 0054 bounded
 * readiness index, its 0055 durable transfer notices, the 0056 bounded
 * VectorIndex SQL store, the 0057 execution-material tables, 0058 managed
 * Worker domain receipts, 0059 apply provider selection, 0060 operation
 * generation, and 0061 accepted authority continuity. */
export function copyCurrentSchemaFixture(directory: string): string {
  if (
    MIGRATIONS.length !== 61 ||
    MIGRATIONS.at(-1)?.name !== "0061_takoform_accepted_authority_continuity.sql"
  ) {
    throw new Error("current schema fixture requires the audited 0001-0061 lineage");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const { name } of MIGRATIONS) {
    copyFileSync(resolve(import.meta.dir, "../../migrations", name), join(directory, name));
  }
  return directory;
}

/** Frozen 0001-0060 source used only by historical operation-generation tests. */
export function copyOperationGenerationSchemaFixture(directory: string): string {
  const prefix = MIGRATIONS.slice(0, 60);
  if (prefix.length !== 60 || prefix.at(-1)?.name !== "0060_takoform_operation_generation.sql") {
    throw new Error("operation-generation fixture requires the frozen 0001-0060 lineage");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const { name } of prefix) {
    copyFileSync(resolve(import.meta.dir, "../../migrations", name), join(directory, name));
  }
  return directory;
}
