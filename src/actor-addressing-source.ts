import { ACTOR_ADDRESSING_SOURCE } from "./generated/actor-addressing-source.ts";

/** Host-only, self-contained Actor ID module for a newly generated wrapper. */
export function renderActorAddressingModuleSource(): string {
  return ACTOR_ADDRESSING_SOURCE;
}
