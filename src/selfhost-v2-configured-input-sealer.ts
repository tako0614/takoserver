import type { RuntimeInputSealKeyRing } from "./runtime-input-seal-keyring.ts";
import { createV2WorkerVersionConfiguredInputSealer } from "./takoform-v2/worker-version-configured-inputs.ts";

/**
 * Adapt the already-parsed operator ring to the v2 Resource-identity sealer.
 * The AES keys are shared, but v1 preparations and v2 configured inputs keep
 * their independent authenticated data and never share ciphertext authority.
 */
export function createSelfhostV2ConfiguredInputSealer(ring: RuntimeInputSealKeyRing) {
  const current = Object.freeze({ ...ring.current });
  const previous = (ring.previous ?? []).map((key) => Object.freeze({ ...key }));
  const keys = new Map([current, ...previous].map((key) => [key.keyId, key.key]));
  if (keys.size !== previous.length + 1) {
    throw new TypeError("v2 Worker configured input keyring has duplicate key IDs");
  }
  return createV2WorkerVersionConfiguredInputSealer({
    current,
    keyForDecryption(keyId) {
      return keys.get(keyId);
    },
  });
}
