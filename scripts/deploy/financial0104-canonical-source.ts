import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH103_NATIVE_MIGRATIONS } from "../../src/auth103-native-source-contract.ts";
import { readAuth103CanonicalMigrationSource } from "./auth103-canonical-migration-source.ts";
import { preflightError } from "./errors.ts";
import { financial0104RootRecipe } from "./financial0104-recipe.ts";
import { type MigrationArtifact, readMigrationArtifact } from "./migrations.ts";
import type { PostAuth103Count } from "./post-auth103-recipes.ts";
import { root0105Recipe } from "./root0105-recipe.ts";
import { root0106Recipe } from "./root0106-recipe.ts";
import { root0107Recipe } from "./root0107-recipe.ts";

const immutableArtifact = (value: MigrationArtifact): MigrationArtifact =>
  Object.freeze({
    files: Object.freeze(value.files.map((file) => Object.freeze({ ...file }))),
    names: Object.freeze([...value.names]),
    digest: value.digest,
    bytes: value.bytes,
  });

/**
 * Materializes the Root post-Auth103 chain candidates: the UNCHANGED Auth103
 * artifact (audited100 + generated 0101/0102/0103) followed by the exact
 * Financial0104 recipe (the 104 artifact), Root's exact 0105, then the pinned
 * Forward native 0106 and shared staging 0107 recipes. The Auth103 artifact, digest and receipts remain;
 * each successor artifact is a distinct digest and never replaces it.
 */
export function readFinancial0104CanonicalMigrationSource(
  sourceRoot: string,
  scratchBase = tmpdir(),
) {
  const auth103 = readAuth103CanonicalMigrationSource(sourceRoot, scratchBase);
  let scratch: string | undefined;
  try {
    const recipe = financial0104RootRecipe();
    const recipe105 = root0105Recipe();
    const recipe106 = root0106Recipe();
    const recipe107 = root0107Recipe();
    if (
      auth103.artifact.files.length !== 103 ||
      JSON.stringify(auth103.artifact.names.slice(100)) !==
        JSON.stringify(AUTH103_NATIVE_MIGRATIONS)
    )
      throw preflightError("Financial0104 predecessor is not the exact Auth103 artifact");
    const owned = mkdtempSync(join(scratchBase, "financial0104-registered-"));
    scratch = owned;
    const generate = (label: string, successors: readonly { name: string; sql: string }[]) => {
      const directory = join(owned, label, "migrations");
      mkdirSync(directory, { recursive: true });
      for (const file of auth103.artifact.files)
        writeFileSync(join(directory, file.name), readFileSync(file.path), {
          mode: 0o600,
          flag: "wx",
        });
      for (const successor of successors)
        writeFileSync(join(directory, successor.name), successor.sql, { mode: 0o600, flag: "wx" });
      return { directory, artifact: immutableArtifact(readMigrationArtifact(directory)) };
    };
    const generated104 = generate("104", [recipe]);
    const generated105 = generate("105", [recipe, recipe105]);
    const generated106 = generate("106", [recipe, recipe105, recipe106]);
    const generated107 = generate("107", [recipe, recipe105, recipe106, recipe107]);
    const artifact = generated104.artifact;
    const artifact105 = generated105.artifact;
    const artifact106 = generated106.artifact;
    const artifact107 = generated107.artifact;
    const unchangedPrefix = (value: MigrationArtifact) =>
      value.files
        .slice(0, 103)
        .every(
          (file, index) =>
            file.digest === auth103.artifact.files[index]?.digest &&
            file.bytes === auth103.artifact.files[index]?.bytes,
        );
    const exact = () =>
      artifact.files.length === 104 &&
      JSON.stringify(artifact.names) === JSON.stringify([...auth103.artifact.names, recipe.name]) &&
      unchangedPrefix(artifact) &&
      artifact.files[103]?.digest === recipe.digest &&
      artifact105.files.length === 105 &&
      JSON.stringify(artifact105.names) === JSON.stringify([...artifact.names, recipe105.name]) &&
      unchangedPrefix(artifact105) &&
      artifact105.files[103]?.digest === recipe.digest &&
      artifact105.files[104]?.digest === recipe105.digest &&
      artifact106.files.length === 106 &&
      JSON.stringify(artifact106.names) ===
        JSON.stringify([...artifact105.names, recipe106.name]) &&
      unchangedPrefix(artifact106) &&
      artifact106.files
        .slice(0, 105)
        .every(
          (file, index) =>
            file.digest === artifact105.files[index]?.digest &&
            file.bytes === artifact105.files[index]?.bytes,
        ) &&
      artifact106.files[105]?.digest === recipe106.digest &&
      artifact107.files.length === 107 &&
      JSON.stringify(artifact107.names) ===
        JSON.stringify([...artifact106.names, recipe107.name]) &&
      unchangedPrefix(artifact107) &&
      artifact107.files
        .slice(0, 106)
        .every(
          (file, index) =>
            file.digest === artifact106.files[index]?.digest &&
            file.bytes === artifact106.files[index]?.bytes,
        ) &&
      artifact107.files[106]?.digest === recipe107.digest;
    if (!exact()) throw preflightError("post-Auth103 generated source differs from its recipes");
    const assertCurrent = () => {
      auth103.assertCurrent();
      financial0104RootRecipe();
      root0105Recipe();
      root0106Recipe();
      root0107Recipe();
      if (
        readMigrationArtifact(generated104.directory).digest !== artifact.digest ||
        readMigrationArtifact(generated105.directory).digest !== artifact105.digest ||
        readMigrationArtifact(generated106.directory).digest !== artifact106.digest ||
        readMigrationArtifact(generated107.directory).digest !== artifact107.digest
      )
        throw preflightError("post-Auth103 generated source changed during read");
    };
    assertCurrent();
    return {
      prefix: auth103.prefix,
      auth103: auth103.artifact,
      auth103Recipes: auth103.recipes,
      artifact,
      recipe,
      artifact105,
      recipe105,
      artifact106,
      recipe106,
      artifact107,
      recipe107,
      /** The generated chain artifact whose ledger has exactly `count` names. */
      artifactFor: (count: PostAuth103Count): MigrationArtifact =>
        count === 104
          ? artifact
          : count === 105
            ? artifact105
            : count === 106
              ? artifact106
              : artifact107,
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
