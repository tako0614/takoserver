import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createForwardWorkerNative106Recipe } from "../../src/takoform-v2/forward-worker-native-schema.ts";
import { preflightError } from "./errors.ts";
import type { MigrationFile } from "./migrations.ts";
import { ROOT0105_MIGRATION_NAME, root0105Recipe } from "./root0105-recipe.ts";

/** Exact Root registration of Core's reviewed 0106 physical successor. */
export const ROOT0106_MIGRATION_NAME = "0106_forward_worker_native_custody.sql";
export const ROOT0106_RECIPE_DIGEST =
  "sha256:1ccf6f88ebddac1f54b7f73a1dfa6ac8a05a5962bf8b649f040b20e4f88320e5";

const digest = (value: string | Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function root0106Recipe(): {
  readonly name: typeof ROOT0106_MIGRATION_NAME;
  readonly sql: string;
  readonly digest: typeof ROOT0106_RECIPE_DIGEST;
} {
  const source = createForwardWorkerNative106Recipe();
  const sql = `${source.steps.flatMap((step) => step.statements).join("\n")}\n`;
  if (
    root0105Recipe().name !== ROOT0105_MIGRATION_NAME ||
    source.name !== ROOT0106_MIGRATION_NAME ||
    source.transaction !== "owning-single-transaction-with-rollback-on-every-error" ||
    source.steps.map((step) => step.name).join(",") !==
      "precondition,replace-guards,postcondition" ||
    digest(sql) !== ROOT0106_RECIPE_DIGEST
  )
    throw preflightError("Root0106 recipe differs from its pinned registration");
  return Object.freeze({ name: ROOT0106_MIGRATION_NAME, sql, digest: ROOT0106_RECIPE_DIGEST });
}

export function isRoot0106RecipeFile(file: MigrationFile | undefined): boolean {
  if (file === undefined) return false;
  const recipe = root0106Recipe();
  return (
    file.name === recipe.name &&
    file.digest === recipe.digest &&
    readFileSync(file.path, "utf8") === recipe.sql
  );
}
