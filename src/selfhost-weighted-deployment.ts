/**
 * One immutable Worker Version selected by a self-hosted Worker Deployment.
 *
 * The UID is the resolved Resource incarnation, while `versionId` is the
 * provider-native immutable materialization. Both are retained because either
 * one alone can be reused under a different portable or native identity.
 */
export interface SelfhostWeightedVersion {
  readonly versionId: string;
  readonly workerVersionUid: string;
  /** Basis points. Every complete deployment sums to exactly 10,000. */
  readonly weight: number;
}

export interface SelfhostWeightedDeployment {
  readonly versions: readonly SelfhostWeightedVersion[];
}

const VERSION_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const RESOURCE_UID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$/u;
const TOTAL_WEIGHT = 10_000;
const MAX_VERSIONS = 8;
const UINT32_RANGE = 0x1_0000_0000;
const UINT32_ACCEPTED_RANGE = Math.floor(UINT32_RANGE / TOTAL_WEIGHT) * TOTAL_WEIGHT;

/** The sole canonical order for durable state, generation identity, and routing. */
export function compareSelfhostWeightedVersions(
  left: Pick<SelfhostWeightedVersion, "workerVersionUid">,
  right: Pick<SelfhostWeightedVersion, "workerVersionUid">,
): number {
  return left.workerVersionUid < right.workerVersionUid
    ? -1
    : left.workerVersionUid > right.workerVersionUid
      ? 1
      : 0;
}

/**
 * Validates and canonicalizes one complete deployment version set.
 *
 * Callers may accept declaration order at their boundary. Everything durable
 * and executable uses the returned UID order, so a reordered desired list is
 * the same deployment rather than a new routing graph.
 */
export function canonicalSelfhostWeightedVersions(
  value: unknown,
): readonly SelfhostWeightedVersion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_VERSIONS) {
    throw new TypeError("invalid self-host Worker Deployment versions");
  }
  const versions = value.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      Object.keys(candidate).sort().join(",") !== "versionId,weight,workerVersionUid"
    ) {
      throw new TypeError("invalid self-host Worker Deployment version");
    }
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.versionId !== "string" ||
      !VERSION_ID.test(record.versionId) ||
      typeof record.workerVersionUid !== "string" ||
      !RESOURCE_UID.test(record.workerVersionUid) ||
      typeof record.weight !== "number" ||
      !Number.isSafeInteger(record.weight) ||
      record.weight < 1 ||
      record.weight > TOTAL_WEIGHT
    ) {
      throw new TypeError("invalid self-host Worker Deployment version");
    }
    return {
      versionId: record.versionId,
      workerVersionUid: record.workerVersionUid,
      weight: record.weight,
    };
  });
  const versionIds = versions.map(({ versionId }) => versionId);
  const versionUids = versions.map(({ workerVersionUid }) => workerVersionUid);
  const total = versions.reduce((sum, { weight }) => sum + weight, 0);
  if (
    new Set(versionIds).size !== versions.length ||
    new Set(versionUids).size !== versions.length ||
    total !== TOTAL_WEIGHT
  ) {
    throw new TypeError("invalid self-host Worker Deployment versions");
  }
  return [...versions].sort(compareSelfhostWeightedVersions);
}

/** A persisted canonical deployment is rejected, rather than silently reordered. */
export function persistedSelfhostWeightedDeployment(value: unknown): SelfhostWeightedDeployment {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).join(",") !== "versions"
  ) {
    throw new TypeError("invalid persisted self-host Worker Deployment");
  }
  const declared = (value as Record<string, unknown>).versions;
  const versions = canonicalSelfhostWeightedVersions(declared);
  const original = declared as readonly Record<string, unknown>[];
  if (
    versions.some(
      (version, index) => version.workerVersionUid !== original[index]?.workerVersionUid,
    )
  ) {
    throw new TypeError("non-canonical persisted self-host Worker Deployment");
  }
  return { versions };
}

/** Selects exactly one Version for a basis point in the closed range 0..9999. */
export function selectSelfhostWeightedVersion(
  versions: readonly SelfhostWeightedVersion[],
  basisPoint: number,
): SelfhostWeightedVersion {
  const canonical = canonicalSelfhostWeightedVersions(versions);
  if (!Number.isSafeInteger(basisPoint) || basisPoint < 0 || basisPoint >= TOTAL_WEIGHT) {
    throw new RangeError("self-host deployment basis point is out of range");
  }
  let ceiling = 0;
  for (const version of canonical) {
    ceiling += version.weight;
    if (basisPoint < ceiling) return version;
  }
  // The canonical validator proved a total of 10,000, so this is unreachable.
  throw new TypeError("invalid self-host Worker Deployment weights");
}

/**
 * Draws an unbiased basis point from private runtime entropy.
 *
 * Rejection avoids the small modulo bias caused by 2^32 not being divisible
 * by 10,000. The injected source exists only for deterministic unit tests.
 */
export function randomSelfhostDeploymentBasisPoint(
  randomUint32: () => number = cryptoUint32,
): number {
  for (;;) {
    const value = randomUint32();
    if (!Number.isSafeInteger(value) || value < 0 || value >= UINT32_RANGE) {
      throw new TypeError("invalid self-host deployment entropy");
    }
    if (value < UINT32_ACCEPTED_RANGE) return value % TOTAL_WEIGHT;
  }
}

function cryptoUint32(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] as number;
}
