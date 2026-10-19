import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ROOT_0105_DDL,
  ROOT_0105_MIGRATION,
  ROOT_0105_PREDECESSOR,
} from "../../src/root-0105-org-capture-triggers.ts";
import { preflightError } from "./errors.ts";
import { FINANCIAL0104_MIGRATION_NAME, financial0104RootRecipe } from "./financial0104-recipe.ts";
import type { MigrationFile } from "./migrations.ts";

/** Root's reviewed pin over its own exact 0105 body (Org capture triggers,
 * trace indexes and raw-birth backfill). Any byte change is a new review. */
export const ROOT0105_RECIPE_DIGEST =
  "sha256:50ae66494770140343e196572b2235bdca43516eb4b388e96ffc1e72cd53ce27";
export const ROOT0105_MIGRATION_NAME = "0105_root_org_history_capture.sql";

const digest = (value: string | Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** The ONE Root 0105 successor of the Root-registered Financial0104 recipe. */
export function root0105Recipe(): {
  readonly name: typeof ROOT0105_MIGRATION_NAME;
  readonly sql: string;
  readonly digest: typeof ROOT0105_RECIPE_DIGEST;
} {
  if (
    ROOT_0105_MIGRATION !== ROOT0105_MIGRATION_NAME ||
    ROOT_0105_PREDECESSOR !== FINANCIAL0104_MIGRATION_NAME ||
    financial0104RootRecipe().name !== ROOT_0105_PREDECESSOR ||
    digest(ROOT_0105_DDL) !== ROOT0105_RECIPE_DIGEST
  )
    throw preflightError("Root0105 recipe differs from its pinned registration");
  return Object.freeze({
    name: ROOT0105_MIGRATION_NAME,
    sql: ROOT_0105_DDL,
    digest: ROOT0105_RECIPE_DIGEST,
  });
}

/** True only for the exact Root 0105 file bytes. */
export function isRoot0105RecipeFile(file: MigrationFile | undefined): boolean {
  if (file === undefined) return false;
  const recipe = root0105Recipe();
  return (
    file.name === recipe.name &&
    file.digest === recipe.digest &&
    readFileSync(file.path, "utf8") === recipe.sql
  );
}
