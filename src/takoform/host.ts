import type { Clock, ObjectStore, Sql } from "../ports.ts";
import { createTakoformArtifacts, type TakoformArtifactTransport } from "./artifacts.ts";
import { installedBindings } from "./bindings.ts";
import type { WorkerModuleInspector } from "./engine.ts";
import { createTakoformEngine } from "./engine.ts";
import { installedForms } from "./forms.ts";
import { createTakoformRoutes, type ProvisionLanePorts } from "./routes.ts";
import { createTakoformStore } from "./store.ts";
import type {
  InstalledTakoformBinding,
  InstalledTakoformForm,
  TakoformHost,
  TakoformHostPrincipal,
  TakoformResourceDriver,
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
  readonly objects: ObjectStore;
  readonly authenticate: (request: Request) => Promise<TakoformHostPrincipal | null>;
  readonly forms: readonly InstalledTakoformForm[];
  readonly bindings?: readonly InstalledTakoformBinding[];
  readonly driver: TakoformResourceDriver;
  readonly artifacts?: TakoformArtifactTransport;
  readonly clock?: Clock;
  readonly randomId?: () => string;
  readonly workerModuleInspector?: WorkerModuleInspector;
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
  const forms = installedForms(options.forms);
  const bindings = installedBindings(options.bindings ?? []);
  const store = createTakoformStore(options.sql, clock);
  const artifacts =
    options.artifacts ??
    createTakoformArtifacts({ sql: options.sql, objects: options.objects, clock, randomId });
  const engine = createTakoformEngine({
    store,
    forms,
    bindings,
    driver: options.driver,
    artifacts,
    clock,
    randomId,
    ...(options.workerModuleInspector
      ? { workerModuleInspector: options.workerModuleInspector }
      : {}),
    ...(options.blockingRelations ? { blockingRelations: options.blockingRelations } : {}),
  });
  return createTakoformRoutes({
    authenticate: options.authenticate,
    engine,
    store,
    forms,
    bindings,
    artifacts,
    ...(options.provision ? { provision: options.provision } : {}),
  });
}
