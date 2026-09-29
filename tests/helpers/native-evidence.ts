/**
 * The configured artifact path for one native-evidence capability, for use as a
 * `skipIf` condition.
 *
 * Presence is all this reports. A configured artifact that does not hold fails
 * the gated test instead of skipping it — `selectClosedGraphWorkerd` refuses to
 * substitute other bytes — so a skip here always means "not configured", never
 * "configured but wrong". Validation of a configured artifact belongs to
 * `bun run check:native-evidence`.
 *
 * When the capability is not configured, this prints one line per capability per
 * process. A bare `bun test tests/workerd-native-facets.test.ts` then says why
 * its tests did not run instead of leaving an unexplained `(skip)`.
 */

import { NATIVE_EVIDENCE_CAPABILITIES } from "../../scripts/native-evidence.ts";

const noticed = new Set<string>();

export function nativeEvidenceBinary(
  capabilityId: string,
  environment?: string,
): string | undefined {
  const capability = NATIVE_EVIDENCE_CAPABILITIES.find((entry) => entry.id === capabilityId);
  if (capability === undefined) {
    throw new Error(`unknown native evidence capability: ${capabilityId}`);
  }
  const name = environment ?? capability.environment;
  const configured = process.env[name];
  if (configured === undefined || configured.trim() === "") {
    if (!noticed.has(name)) {
      noticed.add(name);
      process.stderr.write(
        `native evidence: ${name} is not configured, so ${capability.proves} stays unproven here. ` +
          `Enable it with ${capability.enable}, or read the state with ` +
          `\`bun run check:native-evidence\`.\n`,
      );
    }
    return undefined;
  }
  return configured;
}
