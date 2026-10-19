import { isFinancial0104RecipeFile } from "./financial0104-recipe.ts";
import type { MigrationFile } from "./migrations.ts";
import { isRoot0105RecipeFile } from "./root0105-recipe.ts";

/** Ledger counts reachable after the unchanged Auth103 artifact: 104 adds the
 * Root-registered Financial0104 recipe, 105 then adds Root's own 0105. */
export type PostAuth103Count = 104 | 105;
export const POST_AUTH103_COUNTS: readonly PostAuth103Count[] = Object.freeze([104, 105]);

/** True only when the files after the 103rd are an exact prefix of the
 * post-Auth103 chain (none, exact 0104, or exact 0104 then exact 0105). */
export function isPostAuth103RecipeSuffix(files: readonly MigrationFile[]): boolean {
  if (files.length > 2) return false;
  return (
    (files.length < 1 || isFinancial0104RecipeFile(files[0])) &&
    (files.length < 2 || isRoot0105RecipeFile(files[1]))
  );
}
