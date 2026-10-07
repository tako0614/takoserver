import { bytesDigest } from "../json.ts";
import type { WorkerVersionBinding } from "./forms/worker-specs.ts";

/** Host-private routing facts. SQL reference/lease authority stays with publication-state. */
export interface V2ResolvedServiceBinding {
  readonly name: string;
  readonly target: string;
  readonly targetResourceUid: string;
  readonly unavailableToken: string;
}

const tokenPattern = /^[0-9a-f]{64}$/u;

export async function v2ServiceTargetName(resourceUid: string): Promise<string> {
  const digest = await bytesDigest(new TextEncoder().encode(resourceUid));
  return `v2-worker-${digest.slice("sha256:".length)}`;
}

/** Only call after a current SQL capture proved every exact accepted reference. */
export async function projectV2ResolvedServiceBindings(
  bindings: readonly WorkerVersionBinding[],
): Promise<readonly V2ResolvedServiceBinding[]> {
  const declared = bindings.map((binding) => ({
    name: binding.name,
    targetResourceUid: binding.resource.resourceUid,
  }));
  const resolved: V2ResolvedServiceBinding[] = [];
  for (const binding of declared) {
    const token = crypto.getRandomValues(new Uint8Array(32));
    resolved.push({
      name: binding.name,
      target: await v2ServiceTargetName(binding.targetResourceUid),
      targetResourceUid: binding.targetResourceUid,
      unavailableToken: [...token].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    });
  }
  return resolved;
}

/** Prevent a caller from substituting a native target behind an accepted UID. */
export async function exactV2ResolvedServiceBindings(
  declared: readonly WorkerVersionBinding[],
  resolved: readonly V2ResolvedServiceBinding[] | undefined,
): Promise<boolean> {
  if (declared.length === 0) return resolved === undefined || resolved.length === 0;
  if (!Array.isArray(resolved) || resolved.length !== declared.length) return false;
  let copied: readonly V2ResolvedServiceBinding[];
  try {
    copied = resolved.map((binding) => ({ ...binding }));
  } catch {
    return false;
  }
  const tokens = new Set<string>();
  for (let index = 0; index < declared.length; index += 1) {
    const expected = declared[index];
    const actual = copied[index];
    if (
      !expected ||
      !actual ||
      Object.keys(actual).sort().join(",") !== "name,target,targetResourceUid,unavailableToken" ||
      actual.name !== expected.name ||
      actual.targetResourceUid !== expected.resource.resourceUid ||
      actual.target !== (await v2ServiceTargetName(expected.resource.resourceUid)) ||
      !tokenPattern.test(actual.unavailableToken) ||
      tokens.has(actual.unavailableToken)
    ) {
      return false;
    }
    tokens.add(actual.unavailableToken);
  }
  return true;
}
