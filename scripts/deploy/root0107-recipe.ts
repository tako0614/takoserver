import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SHARED_APP_STAGING_PHYSICAL_DDL } from "../../src/shared-app-staging-adoption.ts";
import { preflightError } from "./errors.ts";
import type { MigrationFile } from "./migrations.ts";
import { ROOT0106_MIGRATION_NAME, root0106Recipe } from "./root0106-recipe.ts";

/** Exact Root registration of the existing staging-only physical source. */
export const ROOT0107_MIGRATION_NAME = "0107_shared_app_staging_physical_adoption.sql";
export const ROOT0107_RECIPE_DIGEST =
  "sha256:274fd5f006e2bc83a38deb3c48af853e5e329d0cf1b412c22a0e695e2b70ddb4";

const digest = (value: string | Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function root0107Recipe(): {
  readonly name: typeof ROOT0107_MIGRATION_NAME;
  readonly sql: string;
  readonly digest: typeof ROOT0107_RECIPE_DIGEST;
} {
  const sql = `${SHARED_APP_STAGING_PHYSICAL_DDL.join(";\n")};\n`;
  if (
    root0106Recipe().name !== ROOT0106_MIGRATION_NAME ||
    SHARED_APP_STAGING_PHYSICAL_DDL.length !== 18 ||
    digest(sql) !== ROOT0107_RECIPE_DIGEST
  )
    throw preflightError("Root0107 recipe differs from its pinned registration");
  return Object.freeze({ name: ROOT0107_MIGRATION_NAME, sql, digest: ROOT0107_RECIPE_DIGEST });
}

export function isRoot0107RecipeFile(file: MigrationFile | undefined): boolean {
  if (file === undefined) return false;
  const recipe = root0107Recipe();
  return (
    file.name === recipe.name &&
    file.digest === recipe.digest &&
    readFileSync(file.path, "utf8") === recipe.sql
  );
}
