import type { Clock } from "./ports.ts";
import {
  createSharedAppLedger,
  type SharedAppEnvironment,
  type SharedAppLedger,
} from "./shared-app-ledger.ts";
import { createD1Sql, type D1DatabaseLike } from "./sql-d1.ts";

export interface SharedAppPrimaryD1 {
  withSession(constraint: "first-primary"): D1DatabaseLike;
}

/** Trusted composition only; selects a NEW primary session for every operation/read fence. */
export function createSharedAppLedgerD1(options: {
  readonly database: SharedAppPrimaryD1;
  readonly environment: SharedAppEnvironment;
  readonly clock?: Clock;
}): SharedAppLedger {
  const database = options.database;
  if (!database || typeof database.withSession !== "function") {
    throw new TypeError("a session-capable primary D1 binding is required");
  }
  return createSharedAppLedger({
    environment: options.environment,
    primary: () => createD1Sql(database.withSession("first-primary")),
    ...(options.clock ? { clock: options.clock } : {}),
  });
}
