import { createEphemeralSql } from "../../src/compat.ts";
import { createMemoryObjectStore } from "../../src/objects-mem.ts";
import type { ObjectStoreAccess, Sql } from "../../src/ports.ts";
import { createTakoformArtifacts } from "../../src/takoform/artifacts.ts";
import { installedBindings } from "../../src/takoform/bindings.ts";
import { createTakoformEngine } from "../../src/takoform/engine.ts";
import { installedForms } from "../../src/takoform/forms.ts";
import type { CreateTakoformHostOptions } from "../../src/takoform/host.ts";
import { InMemoryTakoformResourceDriver } from "../../src/takoform/memory-driver.ts";
import { createDeferredOperations } from "../../src/takoform/operations.ts";
import {
  createTakoformRoutes,
  DEFAULT_TAKOFORM_ROUTES,
  type TakoformRouteConfiguration,
} from "../../src/takoform/routes.ts";
import { createTakoformStore } from "../../src/takoform/store.ts";
import type {
  TakoformHost,
  TakoformHostPrincipal,
  TakoformResourceDriver,
} from "../../src/takoform/types.ts";

/**
 * Test-only assembly for immutable alpha/beta engine regressions.
 *
 * Production and the public package constructor are stable-v1-only. Keeping
 * this configurable assembly under `tests/` prevents a historical fixture
 * from becoming a shipped route-selection capability again.
 */
export interface ConfiguredHistoricalHostOptions
  extends Omit<CreateTakoformHostOptions, "authority"> {
  readonly routes: TakoformRouteConfiguration;
}

export function createConfiguredHistoricalTakoformHost(
  options: ConfiguredHistoricalHostOptions,
): TakoformHost {
  const clock = options.clock ?? (() => new Date());
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const forms = installedForms(options.forms, options.routes.hostApiVersion);
  const resourceQueryIncludesPathIdentity =
    options.routes.hostApiVersion !== "forms.takoform.com/v1";
  const bindings = installedBindings(options.bindings ?? []);
  const store = createTakoformStore(options.sql, clock);
  const artifacts =
    options.artifacts ??
    createTakoformArtifacts({
      sql: options.sql,
      objects: options.objects,
      clock,
      randomId,
      artifactPrefix: `${options.routes.apiPath}/artifacts`,
    });
  const engine = createTakoformEngine({
    store,
    forms,
    bindings,
    driver: options.driver,
    artifacts,
    ...(options.routes.bodyGenerationFence ? { allowBodyGenerationFence: true } : {}),
    ...(options.routes.reviewSpecDigest ? { allowReviewSpecDigest: true } : {}),
    ...(options.routes.hostApiVersion === "forms.takoform.com/v1"
      ? { stableReviewConstraintPhases: true }
      : {}),
    ...(resourceQueryIncludesPathIdentity ? { resourceQueryIncludesPathIdentity: true } : {}),
    clock,
    randomId,
    ...(options.deferredOperations?.leaseMilliseconds
      ? { providerMutationLeaseMilliseconds: options.deferredOperations.leaseMilliseconds }
      : {}),
    ...(options.workerModuleInspector
      ? { workerModuleInspector: options.workerModuleInspector }
      : {}),
    ...(options.blockingRelations ? { blockingRelations: options.blockingRelations } : {}),
    ...(options.standardServiceResolver
      ? { standardServiceResolver: options.standardServiceResolver }
      : {}),
    ...(options.availability ? { availability: options.availability } : {}),
  });
  const deferredOperations = options.deferredOperations
    ? createDeferredOperations({
        configuration: options.deferredOperations,
        engine,
        store,
        forms,
        clock,
        randomId,
        ...(resourceQueryIncludesPathIdentity ? { resourceQueryIncludesPathIdentity: true } : {}),
        ...(options.routes.omitObservedStatus ? { omitObservedStatus: true } : {}),
      })
    : undefined;
  return createTakoformRoutes({
    authenticate: options.authenticate,
    engine,
    store,
    forms,
    bindings,
    artifacts,
    routes: options.routes,
    ...(deferredOperations ? { deferredOperations } : {}),
    ...(options.standardServiceResolver
      ? { standardServiceResolver: options.standardServiceResolver }
      : {}),
    ...(options.provision ? { provision: options.provision } : {}),
    ...(options.availability ? { availability: options.availability } : {}),
  });
}

/** Explicit static stable-lane harness. It is test source and never reachable from product entries. */
export function createStaticStableTestTakoformHost(
  options: Omit<ConfiguredHistoricalHostOptions, "routes">,
): TakoformHost {
  return createConfiguredHistoricalTakoformHost({
    ...options,
    routes: DEFAULT_TAKOFORM_ROUTES,
  });
}

export interface HistoricalEphemeralHostOptions
  extends Omit<ConfiguredHistoricalHostOptions, "authenticate" | "driver" | "objects" | "sql"> {
  readonly authenticate: (authorization: string | null) => Promise<TakoformHostPrincipal | null>;
  readonly driver: TakoformResourceDriver;
  readonly sql?: Sql;
  readonly objects?: ObjectStoreAccess;
}

export function createHistoricalTakoformHost(
  options: HistoricalEphemeralHostOptions,
): TakoformHost {
  return createConfiguredHistoricalTakoformHost({
    ...options,
    sql: options.sql ?? createEphemeralSql(),
    objects: options.objects ?? createMemoryObjectStore(),
    authenticate: (request) => options.authenticate(request.headers.get("authorization")),
  });
}

export function createHistoricalInMemoryTakoformHost(
  options: Omit<HistoricalEphemeralHostOptions, "driver">,
): TakoformHost {
  return createHistoricalTakoformHost({
    ...options,
    driver: new InMemoryTakoformResourceDriver(),
  });
}

export function createStaticStableEphemeralTakoformHost(
  options: Omit<HistoricalEphemeralHostOptions, "routes">,
): TakoformHost {
  return createHistoricalTakoformHost({
    ...options,
    routes: DEFAULT_TAKOFORM_ROUTES,
  });
}

export function createStaticStableInMemoryTakoformHost(
  options: Omit<HistoricalEphemeralHostOptions, "routes" | "driver">,
): TakoformHost {
  return createStaticStableEphemeralTakoformHost({
    ...options,
    driver: new InMemoryTakoformResourceDriver(),
  });
}
