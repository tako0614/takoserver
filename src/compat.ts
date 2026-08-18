import { Database } from "bun:sqlite";
import { MIGRATIONS } from "./db-schema.ts";
import { createMemoryObjectStore } from "./objects-mem.ts";
import type { Clock, ObjectStore, Sql } from "./ports.ts";
import { createSqliteSql } from "./sql-sqlite.ts";
import type { TakoformArtifactTransport } from "./takoform/artifacts.ts";
import { createTakoformHost as assembleTakoformHost } from "./takoform/host.ts";
import { InMemoryTakoformResourceDriver } from "./takoform/memory-driver.ts";
import type {
  InstalledTakoformForm,
  TakoformHost,
  TakoformHostPrincipal,
  TakoformResourceDriver,
} from "./takoform/types.ts";

/**
 * Convenience constructors for embedders and for tests about the protocol
 * rather than about durability.
 *
 * When no storage is supplied these create a private in-memory database with
 * the real migrations applied, so the Host under test is the same code path
 * that runs on D1 — only the storage engine differs. This module reaches for
 * concrete implementations on purpose and is therefore never part of the
 * Workers bundle; the import gate enforces that.
 */

export function createEphemeralSql(): Sql {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS) database.exec(migration.sql);
  return createSqliteSql(database);
}

export interface EphemeralTakoformHostOptions {
  readonly authenticate: (authorization: string | null) => Promise<TakoformHostPrincipal | null>;
  readonly forms: readonly InstalledTakoformForm[];
  readonly driver: TakoformResourceDriver;
  readonly sql?: Sql;
  readonly objects?: ObjectStore;
  readonly artifacts?: TakoformArtifactTransport;
  readonly clock?: Clock;
  readonly randomId?: () => string;
}

export function createTakoformHost(options: EphemeralTakoformHostOptions): TakoformHost {
  return assembleTakoformHost({
    sql: options.sql ?? createEphemeralSql(),
    objects: options.objects ?? createMemoryObjectStore(),
    // Tests and the conformance suite authenticate on the header alone; the
    // lane now hands over the whole request so a session can name the
    // organization it is acting for. Adapting here keeps every existing caller
    // spelled the way it was written.
    authenticate: (request: Request) => options.authenticate(request.headers.get("authorization")),
    forms: options.forms,
    driver: options.driver,
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.randomId ? { randomId: options.randomId } : {}),
  });
}

export function createInMemoryTakoformHost(
  options: Omit<EphemeralTakoformHostOptions, "driver">,
): TakoformHost {
  return createTakoformHost({ ...options, driver: new InMemoryTakoformResourceDriver() });
}
