import type { RuntimeInputSealKeyRing } from "./runtime-input-seal-keyring.ts";
import { createSelfhostLinuxContainerNodeSelection } from "./selfhost-linux-container-node-selection.ts";
import type { SelfhostLinuxDockerCoreSelection } from "./selfhost-linux-docker-core.ts";

/** Existing Host code choices, before binding the already-imported local keys.
 * The legacy Docker environment profile does not supply these Linux choices.
 */
export type SelfhostLinuxDockerNodeSelectionSource = Omit<
  SelfhostLinuxDockerCoreSelection,
  "configuredInputs"
> & {
  readonly configuredInputs: Pick<
    SelfhostLinuxDockerCoreSelection["configuredInputs"],
    "maxSecretBytes"
  >;
};

/** Compatibility entry for the original Docker Host code choice. */
export function createSelfhostLinuxDockerNodeSelection(input: {
  readonly selection: SelfhostLinuxDockerNodeSelectionSource | undefined;
  readonly sealKeys: RuntimeInputSealKeyRing | undefined;
}): SelfhostLinuxDockerCoreSelection | undefined {
  const selection = input.selection;
  if (selection === undefined) return undefined;
  const selected = createSelfhostLinuxContainerNodeSelection({
    selection: { kind: "docker", selection },
    get sealKeys() {
      return input.sealKeys;
    },
  });
  if (selected?.kind !== "docker") throw new TypeError("invalid Linux Docker code selection");
  return selected.selection;
}
