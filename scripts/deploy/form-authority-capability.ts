import {
  YURUCOMMU_IDENTITY_CAPABILITY_KINDS,
  type YurucommuIdentityCapabilityKind,
} from "../../src/takoform/implementation-catalog.ts";
import { preflightError } from "./errors.ts";
import type { DeployTarget } from "./target.ts";

/**
 * Identity capabilities realized by the reviewed edge supply, and the ones
 * realized by the separate private ObjectBucket supply composition.
 *
 * The split is not cosmetic: `edgeSupplies` prices a Form the tenant selects
 * directly, while a current ObjectBucket Offering exists only from an explicit
 * private Supply Contract with `embedded-binding` delivery (ADR 0005).
 */
const EDGE_SUPPLY_KINDS = [
  "AtLeastOnceQueue",
  "EdgeKVNamespace",
  "ModuleWorker",
  "SQLiteDatabase",
] as const satisfies readonly YurucommuIdentityCapabilityKind[];

const OBJECT_BUCKET_SUPPLY_KINDS = [
  "ObjectBucket",
] as const satisfies readonly YurucommuIdentityCapabilityKind[];

/**
 * Every code-owned identity capability belongs to exactly one supply proof.
 *
 * Both lists are written out rather than derived by a predicate, because a
 * predicate answers for a kind nobody has thought about yet: partitioning as
 * "edge, or else bucket" would silently tell a future identity Form that is
 * neither that it needs a Cloudflare *ObjectBucket* supply. This refuses to
 * guess, at import time, so the gap is a build failure and not a deploy that
 * proves the wrong thing.
 */
export function assertIdentityCapabilitySupplyPartition(
  kinds: readonly string[] = YURUCOMMU_IDENTITY_CAPABILITY_KINDS,
): void {
  const partition: readonly string[] = [...EDGE_SUPPLY_KINDS, ...OBJECT_BUCKET_SUPPLY_KINDS];
  const unplaced = kinds.filter((kind) => !partition.includes(kind));
  const absent = partition.filter((kind) => !kinds.includes(kind));
  if (unplaced.length > 0 || absent.length > 0) {
    throw new TypeError(
      "the deploy supply partition does not cover the code-owned identity capabilities: " +
        [...unplaced, ...absent].sort().join(", "),
    );
  }
}

assertIdentityCapabilitySupplyPartition();

/**
 * Proves a target has the provider supplies required by the one code-owned
 * public Form capability manifest. It is a guard only: target values never
 * become the manifest, so a target can never widen what this Host serves.
 */
export function assertPublicFormCapabilityTarget(target: DeployTarget): void {
  const actual = target.edgeSupplies?.offerings.map(({ formKind }) => formKind).sort() ?? [];
  const expected = [...EDGE_SUPPLY_KINDS].sort();
  if (actual.length !== expected.length || actual.some((kind, index) => kind !== expected[index])) {
    throw preflightError(
      `Form authority requires the exact realized edge identity capabilities: ${expected.join(", ")}`,
    );
  }
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
