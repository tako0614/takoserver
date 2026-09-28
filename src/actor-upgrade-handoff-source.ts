import { ACTOR_UPGRADE_HANDOFF_SOURCE } from "./generated/actor-upgrade-handoff-source.ts";

/** Host-only, self-contained module for a newly generated Worker wrapper. */
export function renderActorUpgradeHandoffModuleSource(): string {
  return ACTOR_UPGRADE_HANDOFF_SOURCE;
}
