import { installActorResponseRuntime } from "./actor-upgrade-handoff.ts";

export { createSelfhostActorForwardContext } from "./selfhost-actor-forward-runtime.ts";

// This Host-private entry evaluates after all Host intrinsic captures and before
// the next (tenant) module in the outer wrapper's static import list.
installActorResponseRuntime();
