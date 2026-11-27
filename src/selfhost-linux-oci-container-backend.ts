import type { Clock, Sql } from "./ports.ts";
import {
  createSelfhostLinuxOciCore,
  type SelfhostLinuxOciCoreSelection,
} from "./selfhost-linux-oci-core.ts";

/** Explicit internal Host selection of the ORIGINAL OCI creator and its
 * normal accepted execute/reconcile Form. No owner/runtime/ready callback is
 * injectable. This neither registers public support nor activates Node entry.
 * Namespace cleanup remains factual until a full retirement producer exists.
 */
export function createSelfhostLinuxOciContainerBackend(input: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly selection: SelfhostLinuxOciCoreSelection;
}): NonNullable<ReturnType<typeof createSelfhostLinuxOciCore>> {
  const core = createSelfhostLinuxOciCore(input);
  if (!core) throw new TypeError("selfhost_linux_oci_container_backend_selection_required");
  return core;
}
