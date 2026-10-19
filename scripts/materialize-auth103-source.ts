import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  compileAuth103NativeSourceCatalog,
  createAuth103CanonicalSourceArtifacts,
} from "./deploy/auth103-native-source.ts";
import { preflightError } from "./deploy/errors.ts";
import { readCurrentAuditedMigrationSourceArtifact } from "./deploy/schema.ts";
import { renderSchemaModule } from "./write-schema.ts";

/**
 * Explicit SOURCE writer only. No database, target, provider, credential or
 * migration apply. Formal101/102/103 stay fixed and Financial104 is separate.
 * This entrypoint is not called by check, deploy, or a request constructor.
 */
export function materializeAuth103CanonicalSource(): void {
  const root = resolve(import.meta.dir, "..");
  const directory = join(root, "migrations");
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (
    names.length !== 100 ||
    names.some(
      (name, index) =>
        !/^\d{4}_[a-z0-9_]+\.sql$/u.test(name) || Number(name.slice(0, 4)) !== index + 1,
    )
  )
    throw preflightError(
      "Auth103 source registration requires the unchanged canonical100 predecessor",
    );
  const artifacts = createAuth103CanonicalSourceArtifacts(root);
  const audited = readCurrentAuditedMigrationSourceArtifact();
  if (audited.files.length !== 100)
    throw preflightError("Auth103 registration requires the audited canonical100 source");
  compileAuth103NativeSourceCatalog([
    ...audited.files.map(({ path }) => readFileSync(path, "utf8")),
    ...artifacts.files.map(({ sql }) => sql),
  ]);
  for (const { name } of artifacts.files) {
    if (existsSync(join(directory, name)))
      throw preflightError("Auth103 source registration refuses an existing destination");
  }
  // Exclusive creation preserves every existing historical byte. A partial IO
  // failure stays visible; it is not retried, adopted or silently overwritten.
  for (const { name, sql } of artifacts.files)
    writeFileSync(join(directory, name), sql, { flag: "wx", mode: 0o644 });
  // The existing owning projection remains the only generated-module writer.
  writeFileSync(join(root, "src/db-schema.ts"), renderSchemaModule());
}

if (import.meta.main) materializeAuth103CanonicalSource();
