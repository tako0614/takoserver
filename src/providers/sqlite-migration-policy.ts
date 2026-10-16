// Compatibility entrypoint for existing provider and provider-extension imports.
// The sole runtime-agnostic parser lives below both Form and provider adapters.
export {
  assertSafeMigrationSql,
  MigrationSqlCapacityError,
  prepareMigrationSql,
} from "../sqlite-migration-policy.ts";
