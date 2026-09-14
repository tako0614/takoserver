import type { JsonObject } from "./ports.ts";
import { adoptTrustedWorkflowPromise } from "./workflow-driver.ts";
import {
  createWorkflowHttpWorker,
  type WorkflowHttpWorkerOptions,
} from "./workflow-http-worker.ts";

/*
 * This file is the Host-private entry that the generator bundles into the
 * short-lived workerd service.  It is evaluated before either dynamic tenant
 * module, so every intrinsic used after `load` begins is captured here.
 * `wrapperModule` and `applicationModule` are complete relative specifiers
 * rooted at this generated helper module; neither module is statically
 * reachable from this graph.
 */
const create = Object.create;
const isArray = Array.isArray;
const get = Reflect.get;
const trusted = adoptTrustedWorkflowPromise;
const createWorker = createWorkflowHttpWorker;

/* Keep this literal in sync with the generated wrapper's exact named export. */
const SELFHOST_WORKER_PROJECT_ENV_EXPORT = "__takoserverSelfhostProjectEnv" as const;

export interface WorkflowHttpBootstrapOptions {
  readonly token: string;
  readonly className: string;
  readonly instanceId: string;
  readonly params?: JsonObject;
  /** Complete relative module specifier for the Host-generated env wrapper. */
  readonly wrapperModule: string;
  /** Complete relative module specifier for the tenant application module. */
  readonly applicationModule: string;
}

type LoadedWorkflowModules = Awaited<ReturnType<WorkflowHttpWorkerOptions["load"]>>;

/**
 * Creates the Host-private Workflow HTTP worker.
 *
 * This factory itself never evaluates application code.  The wrapper is
 * loaded first, followed by the application, only when the worker's RUN
 * request enters `load`.  The returned object has a null prototype so the
 * application cannot influence the helper's `namespace`/`projectEnv` seam
 * through inherited properties.
 */
export function createWorkflowHttpBootstrap(
  options: WorkflowHttpBootstrapOptions,
): ReturnType<typeof createWorkflowHttpWorker> {
  const { token, className, instanceId, params, wrapperModule, applicationModule } = options;
  if (
    typeof wrapperModule !== "string" ||
    wrapperModule.length === 0 ||
    typeof applicationModule !== "string" ||
    applicationModule.length === 0
  ) {
    throw new TypeError("workflow HTTP bootstrap module specifier is invalid");
  }

  return createWorker({
    token,
    className,
    instanceId,
    ...(params === undefined ? {} : { params }),
    async load(): Promise<LoadedWorkflowModules> {
      // The generated helper is the root logical module, so complete `./...`
      // specifiers resolve in workerd's module namespace. Dynamic imports
      // remain outside the bundle and therefore cannot pull tenant source into
      // the Host-only artifact or evaluate it before RUN.
      const wrapper = (await trusted(import(wrapperModule))).value as Record<string, unknown>;
      const projectEnv = get(wrapper, SELFHOST_WORKER_PROJECT_ENV_EXPORT);
      if (typeof projectEnv !== "function") {
        throw new Error("workflow HTTP bootstrap project environment export is invalid");
      }

      const namespace = (await trusted(import(applicationModule))).value;
      if (typeof namespace !== "object" || namespace === null || isArray(namespace)) {
        throw new Error("workflow HTTP bootstrap application namespace is invalid");
      }

      const loaded = create(null) as {
        namespace: Readonly<Record<string, unknown>>;
        projectEnv: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown>;
      };
      loaded.namespace = namespace as Readonly<Record<string, unknown>>;
      loaded.projectEnv = projectEnv as (
        raw: Readonly<Record<string, unknown>>,
      ) => Record<string, unknown>;
      return loaded;
    },
  });
}
