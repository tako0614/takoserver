import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH103_NATIVE_MIGRATIONS } from "../../src/auth103-native-source-contract.ts";
import { readAuth103CanonicalMigrationSource } from "./auth103-canonical-migration-source.ts";
import { preflightError } from "./errors.ts";
import { financial0104RootRecipe } from "./financial0104-recipe.ts";
import { type MigrationArtifact, readMigrationArtifact } from "./migrations.ts";

const immutableArtifact = (value: MigrationArtifact): MigrationArtifact =>
  Object.freeze({
    files: Object.freeze(value.files.map((file) => Object.freeze({ ...file }))),
    names: Object.freeze([...value.names]),
    digest: value.digest,
    bytes: value.bytes,
  });

/**
 * Materializes the separate Root-registered 104 candidate: the UNCHANGED
 * Auth103 artifact (audited100 + generated 0101/0102/0103) followed by the
 * exact Financial0104 recipe. The Auth103 artifact, digest and receipts are
 * returned as-is; the 104 artifact is a distinct digest and never replaces it.
 */
export function readFinancial0104CanonicalMigrationSource(
  sourceRoot: string,
  scratchBase = tmpdir(),
) {
  const auth103 = readAuth103CanonicalMigrationSource(sourceRoot, scratchBase);
  let scratch: string | undefined;
  try {
    const recipe = financial0104RootRecipe();
    if (
      auth103.artifact.files.length !== 103 ||
      JSON.stringify(auth103.artifact.names.slice(100)) !==
        JSON.stringify(AUTH103_NATIVE_MIGRATIONS)
    )
      throw preflightError("Financial0104 predecessor is not the exact Auth103 artifact");
    scratch = mkdtempSync(join(scratchBase, "financial0104-registered-"));
    const generatedDirectory = join(scratch, "migrations");
    mkdirSync(generatedDirectory);
    for (const file of auth103.artifact.files)
      writeFileSync(join(generatedDirectory, file.name), readFileSync(file.path), {
        mode: 0o600,
        flag: "wx",
      });
    writeFileSync(join(generatedDirectory, recipe.name), recipe.sql, { mode: 0o600, flag: "wx" });
    const artifact = immutableArtifact(readMigrationArtifact(generatedDirectory));
    const exact = () =>
      artifact.files.length === 104 &&
      JSON.stringify(artifact.names) === JSON.stringify([...auth103.artifact.names, recipe.name]) &&
      artifact.files
        .slice(0, 103)
        .every(
          (file, index) =>
            file.digest === auth103.artifact.files[index]?.digest &&
            file.bytes === auth103.artifact.files[index]?.bytes,
        ) &&
      artifact.files[103]?.digest === recipe.digest;
    if (!exact()) throw preflightError("Financial0104 generated source differs from its recipe");
    const directory = generatedDirectory;
    const assertCurrent = () => {
      auth103.assertCurrent();
      financial0104RootRecipe();
      if (readMigrationArtifact(directory).digest !== artifact.digest)
        throw preflightError("Financial0104 generated source changed during read");
    };
    assertCurrent();
    const owned = scratch;
    return {
      prefix: auth103.prefix,
      auth103: auth103.artifact,
      auth103Recipes: auth103.recipes,
      artifact,
      recipe,
      physicalNames: auth103.physicalNames,
      physicalDigest: auth103.physicalDigest,
      assertCurrent,
      dispose: () => {
        rmSync(owned, { recursive: true, force: true });
        auth103.dispose();
      },
    };
  } catch (error) {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    auth103.dispose();
    throw error;
  }
}
