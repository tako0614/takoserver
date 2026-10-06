import type { Accounts } from "../auth.ts";
import type { Clock, ObjectStoreAccess, Sql } from "../ports.ts";
import { createTakoformV2AccountAccess } from "./accounts.ts";
import type { V2ApplicationConfig } from "./config.ts";
import { createV2HeldArtifactSource } from "./forms/artifact-source.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "./forms/sqlite-migration-set.ts";
import { createSQLiteMigrationSetForm } from "./forms/sqlite-migration-set-backend.ts";
import { createTakoformV2Host } from "./host.ts";
import type { V2Form } from "./types.ts";

/** Compose only Forms whose complete v2 backend is available at this entry. */
export function createTakoformV2Application(options: {
  readonly sql: Sql;
  readonly objects: ObjectStoreAccess;
  readonly accounts: Pick<Accounts, "authenticate" | "requireOwner">;
  readonly publicOrigin: string;
  readonly config: V2ApplicationConfig;
  readonly clock: Clock;
}) {
  const { sql, objects, accounts, publicOrigin, config, clock } = options;
  const access = createTakoformV2AccountAccess(accounts);
  const forms: Record<string, V2Form> = {};
  if (config.sqliteMigrationSet) {
    const source = createV2HeldArtifactSource({
      objects,
      entries: config.sqliteMigrationSet.heldArtifacts,
    });
    forms[SQLITE_MIGRATION_SET_FORM_URL] = createSQLiteMigrationSetForm({
      sql,
      source,
      targetKey: config.sqliteMigrationSet.targetKey,
    });
  }
  return createTakoformV2Host({
    sql,
    now: clock,
    authorize: access.authorize,
    forms,
    baseUrl: `${publicOrigin}/apis/forms.takoform.com/v2`,
    documentation: config.documentation,
    authenticationDocumentation: config.authenticationDocumentation,
    authenticationSchemes: ["Bearer"],
    maxRequestBytes: 1_048_576,
    maxPageSize: 100,
    replayWindowSeconds: 86_400,
    cursorSigningKey: config.cursorSigningKey,
    authenticate: access.authenticate,
  });
}
