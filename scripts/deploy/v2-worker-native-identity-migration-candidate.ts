import { createV2WorkerNativeIdentityMigrationRecipe } from "../../src/takoform-v2/worker-native-identity-schema.ts";

/**
 * Pure, unregistered physical-schema candidate. Actual final predecessor source,
 * canonical registration and D1 import qualification belong to the schema owner.
 * No caller SQL, native receipt, apply entrypoint or SDK capability is accepted.
 */
export function buildUnregisteredV2WorkerNativeIdentityMigrationCandidate() {
  const recipe = createV2WorkerNativeIdentityMigrationRecipe();
  return Object.freeze({
    kind: "unregistered-v2-worker-native-identity-candidate",
    predecessor: "actual-final-owner-schema-must-be-requalified-before-materialization",
    transaction: recipe.transaction,
    steps: recipe.steps,
    // No BEGIN/COMMIT: the existing owning importer supplies its atomic boundary.
    // It must stop on every error, roll back, and preserve the original error.
    statements: Object.freeze(recipe.steps.flatMap((step) => step.statements)),
  });
}
