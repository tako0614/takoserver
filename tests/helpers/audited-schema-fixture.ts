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

/** Current audited source, including the additive 0050/0051 workflow tables
 * and 0052 termination intent. */
export function copyCurrentSchemaFixture(directory: string): string {
  if (
    MIGRATIONS.length !== 52 ||
    MIGRATIONS.at(-1)?.name !== "0052_workflow_termination_intent.sql"
  ) {
    throw new Error("current schema fixture requires the audited 0001-0052 lineage");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const { name } of MIGRATIONS) {
    copyFileSync(resolve(import.meta.dir, "../../migrations", name), join(directory, name));
  }
  return directory;
}
