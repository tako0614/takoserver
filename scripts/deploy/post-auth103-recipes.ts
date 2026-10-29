import { isFinancial0104RecipeFile } from "./financial0104-recipe.ts";
import type { MigrationFile } from "./migrations.ts";
import { isRoot0105RecipeFile } from "./root0105-recipe.ts";
import { isRoot0106RecipeFile } from "./root0106-recipe.ts";
import { isRoot0107RecipeFile } from "./root0107-recipe.ts";
import { isRoot0108RecipeFile } from "./root0108-recipe.ts";

/** Ledger counts reachable after the unchanged Auth103 artifact: 104 adds the
 * Root-registered Financial0104 recipe, 105 adds Root's 0105 and 106 adds
 * the pinned Forward native custody recipe; 107 adds shared staging physical source,
 * and 108 adds predecessor-origin metadata and non-reuse fences without route authority. */
export type PostAuth103Count = 104 | 105 | 106 | 107 | 108;
export const POST_AUTH103_COUNTS: readonly PostAuth103Count[] = Object.freeze([
  104, 105, 106, 107, 108,
]);

/** True only when the files after the 103rd are an exact prefix of the
 * post-Auth103 chain through the exact 0104/0105/0106/0107/0108 recipes. */
export function isPostAuth103RecipeSuffix(files: readonly MigrationFile[]): boolean {
  if (files.length > 5) return false;
  return (
    (files.length < 1 || isFinancial0104RecipeFile(files[0])) &&
    (files.length < 2 || isRoot0105RecipeFile(files[1])) &&
    (files.length < 3 || isRoot0106RecipeFile(files[2])) &&
    (files.length < 4 || isRoot0107RecipeFile(files[3])) &&
    (files.length < 5 || isRoot0108RecipeFile(files[4]))
  );
}
