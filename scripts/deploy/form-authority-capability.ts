import { HOSTED_EDGE_IDENTITY_CLASSES } from "../../src/hosted-edge-supplies.ts";
import { YURUCOMMU_IDENTITY_CAPABILITY_KINDS } from "../../src/takoform/implementation-catalog.ts";
import { preflightError } from "./errors.ts";
import type { DeployTarget } from "./target.ts";

/**
 * Identity capabilities realized by the reviewed edge supply, and the ones
 * realized by the separate private ObjectBucket supply composition.
 *
 * The split is not cosmetic: `edgeSupplies` prices a Form the tenant selects
 * directly, while a current ObjectBucket Offering exists only from an explicit
 * private Supply Contract with `embedded-binding` delivery (ADR 0005). Both
 * lists are derived from the one code-owned capability set, so a Form added
 * there cannot be silently left without a supply proof.
 */
const EDGE_SUPPLY_KINDS = YURUCOMMU_IDENTITY_CAPABILITY_KINDS.filter(
  (kind) => kind in HOSTED_EDGE_IDENTITY_CLASSES,
);
const OBJECT_BUCKET_SUPPLY_KINDS = YURUCOMMU_IDENTITY_CAPABILITY_KINDS.filter(
  (kind) => !(kind in HOSTED_EDGE_IDENTITY_CLASSES),
);

/**
 * Proves a target has the provider supplies required by the one code-owned
 * public Form capability manifest. It is a guard only: target values never
 * select or modify P, the capability manifest, or I.
 */
export function assertPublicFormCapabilityTarget(target: DeployTarget): void {
  const actual = target.edgeSupplies?.offerings.map(({ formKind }) => formKind).sort() ?? [];
  const expected = [...EDGE_SUPPLY_KINDS].sort();
  if (actual.length !== expected.length || actual.some((kind, index) => kind !== expected[index])) {
    throw preflightError(
      `Form authority requires the exact realized edge identity capabilities: ${expected.join(", ")}`,
    );
  }
  if (OBJECT_BUCKET_SUPPLY_KINDS.length === 0) return;
  // Only a Cloudflare ObjectBucket supply is executable: it is the one pack
  // whose runtime-binding materializer owns both the target export and the
  // consumer import of `module-worker.object-bucket`.
  const buckets = target.objectBucketSupplies?.supplies ?? [];
  if (!buckets.some((supply) => supply.provider.kind === "cloudflare")) {
    throw preflightError(
      `Form authority requires a realized Cloudflare supply for: ${OBJECT_BUCKET_SUPPLY_KINDS.join(", ")}`,
    );
  }
}
