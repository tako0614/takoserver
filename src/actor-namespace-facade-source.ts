import { ACTOR_NAMESPACE_FACADE_SOURCE } from "./generated/actor-namespace-facade-source.ts";

/** Host-only, self-contained namespace facade module for new Worker wrappers. */
export function renderActorNamespaceFacadeModuleSource(): string {
  return ACTOR_NAMESPACE_FACADE_SOURCE;
}
