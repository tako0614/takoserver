import type { Clock, ObjectStoreAccess, Sql } from "../ports.ts";
import { createTakoformArtifacts, type TakoformArtifactTransport } from "./artifacts.ts";
import { installedBindings } from "./bindings.ts";
import type { WorkerModuleInspector } from "./engine.ts";
import { createTakoformEngine } from "./engine.ts";
import { installedForms } from "./forms.ts";
import type { TakoformHostAuthority } from "./host-authority.ts";
import { createDeferredOperations, type DeferredOperationsConfiguration } from "./operations.ts";
import {
  createTakoformRoutes,
  DEFAULT_TAKOFORM_ROUTES,
  type ProvisionLanePorts,
} from "./routes.ts";
import { createTakoformStore } from "./store.ts";
import type {
  InstalledTakoformBinding,
  InstalledTakoformForm,
  TakoformFormAvailabilityResolver,
  TakoformHost,
  TakoformHostPrincipal,
  TakoformResourceDriver,
  TakoformStandardServiceResolver,
} from "./types.ts";

/**
 * Assembles a Takoform Host from its parts.
 *
 * This is the only place that knows the Host is made of a store, an engine, an
 * artifact transport, and a router — every one of which is separately testable
 * without the others.
 */
export interface CreateTakoformHostOptions {
  readonly sql: Sql;
  readonly objects: ObjectStoreAccess;
  readonly authenticate: (request: Request) => Promise<TakoformHostPrincipal | null>;
  readonly forms: readonly InstalledTakoformForm[];
  readonly bindings?: readonly InstalledTakoformBinding[];
  readonly driver: TakoformResourceDriver;
  readonly artifacts?: TakoformArtifactTransport;
  readonly clock?: Clock;
  readonly randomId?: () => string;
  readonly workerModuleInspector?: WorkerModuleInspector;
  /** Optional asynchronous lifecycle policy; production may compose durable operations. */
  readonly deferredOperations?: DeferredOperationsConfiguration;
  /** Exact Host-owned standard-service resolver, scoped by tenant and Space. */
  readonly standardServiceResolver?: TakoformStandardServiceResolver;
  /** Runtime/activation truth for exact installed Definitions. Defaults to fully available. */
  readonly availability?: TakoformFormAvailabilityResolver;
  /** Durable public authority. Static composition exists only under tests/helpers. */
  readonly authority: TakoformHostAuthority;
  /** When present, the single-use provision-token redemption lane is served. */
  readonly provision?: ProvisionLanePorts;
  readonly blockingRelations?: (
    tenantId: string,
    resourceUid: string,
  ) => Promise<readonly string[]>;
}

export function createTakoformHost(options: CreateTakoformHostOptions): TakoformHost {
  const clock = options.clock ?? (() => new Date());
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  // Public and production assembly has exactly one route identity. Historical
  // engine regressions use a test-only assembler under `tests/helpers` rather
  // than turning old lanes back into a shipped configuration capability.
  const routes = DEFAULT_TAKOFORM_ROUTES;
  const forms = installedForms(options.forms, routes.hostApiVersion);
  const bindings = installedBindings(options.bindings ?? []);
  const store = createTakoformStore(options.sql, clock);
  const artifacts =
    options.artifacts ??
    createTakoformArtifacts({
      sql: options.sql,
      objects: options.objects,
      clock,
      randomId,
    });
  const engine = createTakoformEngine({
    store,
    forms,
    bindings,
    driver: options.driver,
    artifacts,
    ...(routes.bodyGenerationFence ? { allowBodyGenerationFence: true } : {}),
    ...(routes.reviewSpecDigest ? { allowReviewSpecDigest: true } : {}),
    stableReviewConstraintPhases: true,
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
    authority: options.authority,
  });
  const deferredOperations = options.deferredOperations
    ? createDeferredOperations({
        configuration: options.deferredOperations,
        engine,
        store,
        forms,
        authority: options.authority,
        clock,
        randomId,
        ...(routes.omitObservedStatus ? { omitObservedStatus: true } : {}),
      })
    : undefined;
  return createTakoformRoutes({
    authenticate: options.authenticate,
    engine,
    store,
    forms,
    bindings,
    artifacts,
    ...(deferredOperations ? { deferredOperations } : {}),
    ...(options.standardServiceResolver
      ? { standardServiceResolver: options.standardServiceResolver }
      : {}),
    ...(options.availability ? { availability: options.availability } : {}),
    ...(options.driver.runtimeInputPolicy
      ? { runtimeInputPolicy: options.driver.runtimeInputPolicy }
      : {}),
    authority: options.authority,
    ...(options.provision ? { provision: options.provision } : {}),
  });
}
