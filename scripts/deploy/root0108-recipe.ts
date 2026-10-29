import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SHARED_APP_STAGING_ORIGIN_HISTORY_DDL } from "../../src/shared-app-staging-origin-history.ts";
import { preflightError } from "./errors.ts";
import type { MigrationFile } from "./migrations.ts";
import { ROOT0107_MIGRATION_NAME, root0107Recipe } from "./root0107-recipe.ts";

/** Additive metadata/non-reuse schema only; no predecessor import or physical cutover. */
export const ROOT0108_MIGRATION_NAME = "0108_shared_app_staging_origin_history.sql";
export const ROOT0108_RECIPE_DIGEST =
  "sha256:3e396843f7e9c507abe50449ee4fab4bbe425fbe3b5f08df6dfcb07338f785ba";
export function root0108Recipe() {
  const sql = `${SHARED_APP_STAGING_ORIGIN_HISTORY_DDL.join(";\n")};\n`;
  if (
    root0107Recipe().name !== ROOT0107_MIGRATION_NAME ||
    SHARED_APP_STAGING_ORIGIN_HISTORY_DDL.length !== 10 ||
    `sha256:${createHash("sha256").update(sql).digest("hex")}` !== ROOT0108_RECIPE_DIGEST
  )
    throw preflightError("Root0108 recipe differs from its pinned registration");
  return Object.freeze({ name: ROOT0108_MIGRATION_NAME, sql, digest: ROOT0108_RECIPE_DIGEST });
}
export function isRoot0108RecipeFile(file: MigrationFile | undefined): boolean {
  if (file === undefined) return false;
  const recipe = root0108Recipe();
  return (
    file.name === recipe.name &&
    file.digest === recipe.digest &&
    readFileSync(file.path, "utf8") === recipe.sql
  );
}
