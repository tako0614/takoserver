import { containerRecord, isContainerSecretKey } from "./providers/container-secret-codec.ts";
import type { RuntimeInputSealKeyRing } from "./runtime-input-seal-keyring.ts";
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

/** Join the explicit Host selection to the existing operator key authority.
 * This creates no owner, custody, native process or readiness assertion. The
 * original Core constructor still validates the complete selection on its Sql.
 */
export function createSelfhostLinuxDockerNodeSelection(input: {
  readonly selection: SelfhostLinuxDockerNodeSelectionSource | undefined;
  readonly sealKeys: RuntimeInputSealKeyRing | undefined;
}): SelfhostLinuxDockerCoreSelection | undefined {
  const selection = input.selection;
  if (selection === undefined) return undefined;
  // Preserve the original descriptor refusal before copying the configuration.
  containerRecord(selection);
  const configured = containerRecord(selection.configuredInputs);
  if (Object.keys(configured).join() !== "maxSecretBytes")
    throw new TypeError("invalid Linux Docker configured input selection");
  const ring = input.sealKeys;
  if (!ring) throw new TypeError("Linux Docker operator seal keys unavailable");
  const imported = [ring.current, ...(ring.previous ?? [])];
  const keys = new Map<string, CryptoKey>();
  for (const key of imported) {
    if (!isContainerSecretKey(key.key) || keys.has(key.keyId))
      throw new TypeError("invalid Linux Docker operator seal keys");
    keys.set(key.keyId, key.key);
  }
  const current = Object.freeze({ id: ring.current.keyId, key: ring.current.key });
  return Object.freeze({
    ...selection,
    configuredInputs: Object.freeze({
      maxSecretBytes: selection.configuredInputs.maxSecretBytes,
      keyring: Object.freeze({
        current,
        keyForDecryption(id: string) {
          return keys.get(id);
        },
      }),
    }),
  });
}
