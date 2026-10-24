import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AUTH103_NATIVE_MIGRATIONS } from "../../src/auth103-native-source-contract.ts";
import { canonicalJson } from "../../src/json.ts";
import { createAuth103CanonicalSourceArtifacts } from "./auth103-canonical-recipes.ts";
import { preflightError } from "./errors.ts";
import { type MigrationArtifact, readMigrationArtifact } from "./migrations.ts";
import { isPostAuth103RecipeSuffix } from "./post-auth103-recipes.ts";
import { readAuditedMigrationSourcePrefix100 } from "./schema.ts";

const digest = (value: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const immutableArtifact = (value: MigrationArtifact): MigrationArtifact =>
  Object.freeze({
    files: Object.freeze(value.files.map((file) => Object.freeze({ ...file }))),
    names: Object.freeze([...value.names]),
    digest: value.digest,
    bytes: value.bytes,
  });

/**
 * Materializes one source-owned 103 candidate from immutable audited100 bytes
 * and the existing Auth/Container/Worker recipe owner. A physical checkout may
 * contain 100, the exact owner103 files or those plus an exact prefix of the
 * Root post-Auth103 chain (Financial0104, Root0105, Forward0106, Shared0107), but no path supplies foreign
 * successor SQL or treats scratch as native dispatch/history authority.
 */
export function readAuth103CanonicalMigrationSource(sourceRoot: string, scratchBase = tmpdir()) {
  const directory = resolve(sourceRoot, "migrations");
  const prefix = immutableArtifact(readAuditedMigrationSourcePrefix100(directory));
  const recipes = createAuth103CanonicalSourceArtifacts(sourceRoot);
  const physical = readMigrationArtifact(directory);
  const assertPhysical = () => {
    const current = readMigrationArtifact(directory);
    if (
      (current.files.length !== 100 &&
        current.files.length !== 103 &&
        current.files.length !== 104 &&
        current.files.length !== 105 &&
        current.files.length !== 106 &&
        current.files.length !== 107) ||
      current.digest !== physical.digest ||
      readAuditedMigrationSourcePrefix100(directory).digest !== prefix.digest ||
      JSON.stringify(current.names.slice(100, 103)) !==
        JSON.stringify(current.files.length === 100 ? [] : AUTH103_NATIVE_MIGRATIONS) ||
      (current.files.length > 103 && !isPostAuth103RecipeSuffix(current.files.slice(103)))
    )
      throw preflightError("Auth103 audited source inventory changed or has a foreign successor");
    // Physical 104th–107th files are only the exact Root post-Auth103 chain;
    // they never enter this Auth103 artifact, digest or receipt.
    for (const [index, file] of current.files.slice(100, 103).entries()) {
      const expected = recipes.files[index];
      if (
        expected === undefined ||
        file.name !== expected.name ||
        file.digest !== digest(expected.sql) ||
        readFileSync(file.path, "utf8") !== expected.sql
      )
        throw preflightError("Auth103 physical successor differs from the owner recipe");
    }
    if (canonicalJson(createAuth103CanonicalSourceArtifacts(sourceRoot)) !== canonicalJson(recipes))
      throw preflightError("Auth103 owner recipe changed during source read");
  };
  assertPhysical();
  const scratch = mkdtempSync(join(scratchBase, "auth103-registered-"));
  try {
    const generatedDirectory = join(scratch, "migrations");
    mkdirSync(generatedDirectory);
    for (const file of prefix.files)
      writeFileSync(join(generatedDirectory, file.name), readFileSync(file.path), {
        mode: 0o600,
        flag: "wx",
      });
    for (const file of recipes.files)
      writeFileSync(join(generatedDirectory, file.name), file.sql, {
        mode: 0o600,
        flag: "wx",
      });
    const artifact = immutableArtifact(readMigrationArtifact(generatedDirectory));
    if (
      artifact.files.length !== 103 ||
      readAuditedMigrationSourcePrefix100(generatedDirectory).digest !== prefix.digest ||
      JSON.stringify(artifact.names.slice(100)) !== JSON.stringify(AUTH103_NATIVE_MIGRATIONS)
    )
      throw preflightError("Auth103 owner-generated source differs from audited100");
    const assertCurrent = () => {
      assertPhysical();
      if (readMigrationArtifact(generatedDirectory).digest !== artifact.digest)
        throw preflightError("Auth103 owner-generated source changed during read");
    };
    assertCurrent();
    return {
      prefix,
      artifact,
      recipes,
      physicalNames: Object.freeze([...physical.names]),
      physicalDigest: physical.digest,
      assertCurrent,
      dispose: () => rmSync(scratch, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}
