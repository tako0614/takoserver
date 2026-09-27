import { SELFHOST_ACTOR_FORWARD_RUNTIME_SOURCE } from "./generated/selfhost-actor-forward-runtime-source.ts";
import type { SelfhostActorForwardBinding } from "./selfhost-actor-forward-runtime.ts";

const MODULE = /^[A-Za-z0-9_.][A-Za-z0-9._-]*$/u;
const BINDING = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const SERVICE = /^__TAKOSERVER_[A-Z0-9_]+$/u;
const TOKEN = /^[a-f0-9]{64}$/u;

export function renderSelfhostActorForwardRuntimeModuleSource(): string {
  return SELFHOST_ACTOR_FORWARD_RUNTIME_SOURCE;
}

/** New opt-in outer module; the ordinary released wrapper bytes are untouched. */
export function selfhostActorForwardEntrypointSource(input: {
  readonly runtimeModule: string;
  readonly innerModule: string;
  readonly bindings: readonly SelfhostActorForwardBinding[];
  readonly queue?: boolean;
  readonly scheduled?: boolean;
  readonly events?: boolean;
}): string {
  if (
    !MODULE.test(input.runtimeModule) ||
    !MODULE.test(input.innerModule) ||
    input.runtimeModule === input.innerModule ||
    !Array.isArray(input.bindings) ||
    input.bindings.length === 0 ||
    input.bindings.length > 32 ||
    (input.queue !== undefined && typeof input.queue !== "boolean") ||
    (input.scheduled !== undefined && typeof input.scheduled !== "boolean") ||
    (input.events !== undefined && typeof input.events !== "boolean")
  )
    throw new TypeError("Actor forward wrapper configuration invalid");
  const names = new Set<string>();
  const services = new Set<string>();
  for (const binding of input.bindings) {
    if (
      !BINDING.test(binding.publicName) ||
      names.has(binding.publicName) ||
      !SERVICE.test(binding.httpService) ||
      !SERVICE.test(binding.upgradeService) ||
      binding.httpService === binding.upgradeService ||
      services.has(binding.httpService) ||
      services.has(binding.upgradeService) ||
      !TOKEN.test(binding.token)
    )
      throw new TypeError("Actor forward wrapper configuration invalid");
    names.add(binding.publicName);
    services.add(binding.httpService);
    services.add(binding.upgradeService);
  }
  const bindings = input.bindings.map((binding) => ({
    publicName: binding.publicName,
    httpService: binding.httpService,
    upgradeService: binding.upgradeService,
    token: binding.token,
  }));
  const eventMethods = [
    ...(input.queue
      ? [
          `  async queue(event, rawEnv, rawContext) {
    const context = createSelfhostActorForwardContext({rawEnv, bindings: BINDINGS});
    return await Inner.queue(event, context.rawEnv, rawContext);
  },`,
        ]
      : []),
    ...(input.scheduled
      ? [
          `  async scheduled(event, rawEnv, rawContext) {
    const context = createSelfhostActorForwardContext({rawEnv, bindings: BINDINGS});
    return await Inner.scheduled(event, context.rawEnv, rawContext);
  },`,
        ]
      : []),
  ].join("\n");
  return `import { createSelfhostActorForwardContext } from ${JSON.stringify(`./${input.runtimeModule}`)};
import * as Inner from ${JSON.stringify(`./${input.innerModule}`)};
const BINDINGS = ${JSON.stringify(bindings)};
export default {
  async fetch(request, rawEnv, rawContext) {
    const context = createSelfhostActorForwardContext({original:request, rawEnv, bindings:BINDINGS});
    try {
      return await context.finish(await Inner.default.fetch(request, context.rawEnv, rawContext));
    } catch {
      await context.abandon();
      return context.failure();
    }
  },
${eventMethods}
};
${
  input.events
    ? `export const takoserverSelfhostEvents = {
  async fetch(request, rawEnv, rawContext) {
    const context = createSelfhostActorForwardContext({rawEnv, bindings:BINDINGS});
    return await Inner.takoserverSelfhostEvents.fetch(request, context.rawEnv, rawContext);
  }
};`
    : ""
}
`;
}
