import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { AUTH103_NATIVE_MIGRATIONS } from "../../src/auth103-native-source-contract.ts";
import {
  FINANCIAL_0104_DDL,
  FINANCIAL_0104_MIGRATION,
  FINANCIAL_0104_PREDECESSOR,
} from "../../src/financial-0104-source-contract.ts";
import { preflightError } from "./errors.ts";
import type { MigrationFile } from "./migrations.ts";

/** Root's reviewed pin over the exact Financial-owned 0104 body. A Financial
 * recipe edit must be re-reviewed here before Root registers different bytes. */
export const FINANCIAL0104_ROOT_RECIPE_DIGEST =
  "sha256:189f56e787b0e147032de7432e05f23a9d152971d08534893f6bef161e1253f6";
export const FINANCIAL0104_MIGRATION_NAME = "0104_financial_custody.sql";

const digest = (value: string | Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** The ONE Root-registered Financial successor: name, predecessor and bytes are
 * fixed. It is appended after the unchanged Auth103 artifact and confers no
 * caller, payer, source or issuer authority by itself. */
export function financial0104RootRecipe(): {
  readonly name: typeof FINANCIAL0104_MIGRATION_NAME;
  readonly sql: string;
  readonly digest: typeof FINANCIAL0104_ROOT_RECIPE_DIGEST;
} {
  if (
    FINANCIAL_0104_MIGRATION !== FINANCIAL0104_MIGRATION_NAME ||
    FINANCIAL_0104_PREDECESSOR !== AUTH103_NATIVE_MIGRATIONS[2] ||
    AUTH103_NATIVE_MIGRATIONS.length !== 3 ||
    digest(FINANCIAL_0104_DDL) !== FINANCIAL0104_ROOT_RECIPE_DIGEST
  )
    throw preflightError("Financial0104 recipe differs from the Root-pinned registration");
  return Object.freeze({
    name: FINANCIAL0104_MIGRATION_NAME,
    sql: FINANCIAL_0104_DDL,
    digest: FINANCIAL0104_ROOT_RECIPE_DIGEST,
  });
}

/** True only for the exact Root-registered 0104 file bytes. */
export function isFinancial0104RecipeFile(file: MigrationFile | undefined): boolean {
  if (file === undefined) return false;
  const recipe = financial0104RootRecipe();
  return (
    file.name === recipe.name &&
    file.digest === recipe.digest &&
    readFileSync(file.path, "utf8") === recipe.sql
  );
}
