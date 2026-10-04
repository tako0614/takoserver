import { SELFHOST_WORKFLOW_BINDING_RUNTIME_SOURCE } from "./generated/selfhost-workflow-binding-runtime-source.ts";

const MODULE_NAME = /^[A-Za-z0-9_.][A-Za-z0-9._-]*$/u;
const PUBLIC_BINDING = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const PRIVATE_SERVICE = /^__TAKOSERVER_WORKFLOW_BINDING_[0-9]{5}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const SELFHOST_WORKER_PROJECT_ENV_EXPORT = "__takoserverSelfhostProjectEnv" as const;

export const SELFHOST_WORKFLOW_BINDING_RUNTIME_MODULE =
  "__takoserver-selfhost-workflow-binding-runtime.js" as const;
export const SELFHOST_WORKFLOW_BINDING_ENTRYPOINT_MODULE =
  "__takoserver-selfhost-workflow-binding-entrypoint.js" as const;

export interface SelfhostWorkflowBindingWorkerBinding {
  readonly publicName: string;
  readonly serviceName: string;
  readonly token: string;
}

export function renderSelfhostWorkflowBindingRuntimeModuleSource(): string {
  return SELFHOST_WORKFLOW_BINDING_RUNTIME_SOURCE;
}

/** Outer Host wrapper for the private nested Workflow Binding facade. */
export function selfhostWorkflowBindingEntrypointSource(input: {
  readonly runtimeModule: string;
  readonly innerModule: string;
  readonly bindings: readonly SelfhostWorkflowBindingWorkerBinding[];
  readonly queue?: boolean;
  readonly scheduled?: boolean;
  readonly events?: boolean;
}): string {
  if (
    !input ||
    !MODULE_NAME.test(input.runtimeModule) ||
    !MODULE_NAME.test(input.innerModule) ||
    input.runtimeModule === input.innerModule ||
    !Array.isArray(input.bindings) ||
    input.bindings.length === 0 ||
    input.bindings.length > 64 ||
    (input.queue !== undefined && typeof input.queue !== "boolean") ||
    (input.scheduled !== undefined && typeof input.scheduled !== "boolean") ||
    (input.events !== undefined && typeof input.events !== "boolean")
  ) {
    throw new TypeError("Workflow Binding wrapper configuration invalid");
  }

  const names = new Set<string>();
  const services = new Set<string>();
  const bindings = input.bindings.map((binding) => {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      throw new TypeError("Workflow Binding wrapper configuration invalid");
    }
    const descriptors = Object.getOwnPropertyDescriptors(binding);
    const keys = Reflect.ownKeys(binding);
    if (keys.length !== 3) throw new TypeError("Workflow Binding wrapper configuration invalid");
    const values = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (
        typeof key !== "string" ||
        (key !== "publicName" && key !== "serviceName" && key !== "token")
      ) {
        throw new TypeError("Workflow Binding wrapper configuration invalid");
      }
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError("Workflow Binding wrapper configuration invalid");
      }
      values[key] = descriptor.value;
    }
    const publicName = values.publicName;
    const serviceName = values.serviceName;
    const token = values.token;
    if (
      typeof publicName !== "string" ||
      !PUBLIC_BINDING.test(publicName) ||
      names.has(publicName) ||
      typeof serviceName !== "string" ||
      !PRIVATE_SERVICE.test(serviceName) ||
      services.has(serviceName) ||
      typeof token !== "string" ||
      !TOKEN.test(token)
    ) {
      throw new TypeError("Workflow Binding wrapper configuration invalid");
    }
    names.add(publicName);
    services.add(serviceName);
    return { publicName, serviceName, token };
  });

  const eventMethods = [
    ...(input.queue
      ? [
          `  async queue(event, rawEnv, rawContext) {
    const context = createSelfhostWorkflowBindingContext({rawEnv, bindings:BINDINGS});
    return await Inner.default.queue(event, context.rawEnv, rawContext);
  },`,
        ]
      : []),
    ...(input.scheduled
      ? [
          `  async scheduled(event, rawEnv, rawContext) {
    const context = createSelfhostWorkflowBindingContext({rawEnv, bindings:BINDINGS});
    return await Inner.default.scheduled(event, context.rawEnv, rawContext);
  },`,
        ]
      : []),
  ].join("\n");
  const projectEnvironmentExport = `\nexport function ${SELFHOST_WORKER_PROJECT_ENV_EXPORT}(rawEnv) {
  const context = createSelfhostWorkflowBindingContext({rawEnv, bindings:BINDINGS});
  const projectEnv = Inner.${SELFHOST_WORKER_PROJECT_ENV_EXPORT};
  if (typeof projectEnv !== "function") throw new Error("Workflow project environment unavailable");
  return projectEnv(context.rawEnv);
}`;
  return `import { createSelfhostWorkflowBindingContext } from ${JSON.stringify(`./${input.runtimeModule}`)};
import * as Inner from ${JSON.stringify(`./${input.innerModule}`)};
const BINDINGS = ${JSON.stringify(bindings)};
export default {
  async fetch(request, rawEnv, rawContext) {
    const context = createSelfhostWorkflowBindingContext({rawEnv, bindings:BINDINGS});
    return await Inner.default.fetch(request, context.rawEnv, rawContext);
  },
${eventMethods}
};
${projectEnvironmentExport}
${
  input.events
    ? `export const takoserverSelfhostEvents = {
  async fetch(request, rawEnv, rawContext) {
    const context = createSelfhostWorkflowBindingContext({rawEnv, bindings:BINDINGS});
    return await Inner.takoserverSelfhostEvents.fetch(request, context.rawEnv, rawContext);
  }
};`
    : ""
}
`;
}
