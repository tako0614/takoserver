import { type DeployPhase, mutationError, preflightError, verificationError } from "./errors.ts";
import { expectedWorkerSecrets } from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";
import {
  assertExactSecretInventory,
  assertExactVersionBindingClosure,
  expectedExactBindingClosure,
  parseWorkerDeploymentHistory,
  type WorkerDeploymentHistory,
} from "./worker-state.ts";

const WORKER_MESSAGE = /^takoserver-worker:([0-9a-f]{40}):([0-9a-f]{64})$/u;

export interface WorkerState {
  workerDomains(): Promise<readonly { readonly hostname: string; readonly service: string }[]>;
  workerDeployments(workerName: string): Promise<readonly unknown[]>;
  workerVersion(workerName: string, versionId: string): Promise<unknown>;
  workerSecrets(workerName: string): Promise<readonly unknown[]>;
}

export interface LiveWorkerVersion {
  readonly history: WorkerDeploymentHistory;
  readonly commit: string;
  readonly bundleDigestHex: string;
}

/** Exact authoritative code/config/secret/domain state for one served Version. */
export async function inspectLiveWorkerVersion(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
  input: {
    readonly hostedTopology: "desired" | "absent";
    readonly signingKeyId?: string;
    readonly expectedSecrets?: readonly string[];
  },
): Promise<LiveWorkerVersion> {
  const history = parseWorkerDeploymentHistory(await state.workerDeployments(target.workerName));
  if (history === null) throw phaseError(phase, "Worker has no authoritative current deployment");
  const version = await state.workerVersion(target.workerName, history.versionId);
  assertExactVersionBindingClosure(
    phase,
    history.versionId,
    version,
    expectedExactBindingClosure(target, {
      hostedTopology: input.hostedTopology,
      ...(input.signingKeyId === undefined ? {} : { signingKeyId: input.signingKeyId }),
      ...(input.expectedSecrets === undefined ? {} : { expectedSecrets: input.expectedSecrets }),
    }),
  );
  assertExactSecretInventory(
    await state.workerSecrets(target.workerName),
    input.expectedSecrets ?? expectedWorkerSecrets(target),
    phase,
  );
  assertDomainClosure(phase, target, await state.workerDomains());
  const identity = workerVersionIdentity(phase, version);
  return { history, ...identity };
}

export function workerVersionIdentity(
  phase: DeployPhase,
  value: unknown,
): { readonly commit: string; readonly bundleDigestHex: string } {
  if (!isRecord(value) || !isRecord(value.annotations)) {
    throw phaseError(phase, "Worker version has no canonical annotation inventory");
  }
  const message = value.annotations["workers/message"];
  const match = typeof message === "string" ? WORKER_MESSAGE.exec(message) : null;
  if (!match?.[1] || !match[2]) {
    throw phaseError(phase, "Worker version has no exact commit and artifact annotation");
  }
  return { commit: match[1], bundleDigestHex: match[2] };
}

export function assertDomainClosure(
  phase: DeployPhase,
  target: DeployTarget,
  entries: readonly { readonly hostname: string; readonly service: string }[],
): void {
  const canonical = new URL(target.publicOrigin).hostname;
  const expected = canonical.endsWith(".workers.dev")
    ? []
    : [canonical, ...(target.aliases ?? [])].sort();
  const actual: string[] = [];
  const ownerByHost = new Map<string, string[]>();
  for (const entry of entries) {
    if (!isHostname(entry.hostname) || entry.service.length === 0) {
      throw phaseError(phase, "Worker domain inventory contains a malformed entry");
    }
    const owners = ownerByHost.get(entry.hostname) ?? [];
    owners.push(entry.service);
    ownerByHost.set(entry.hostname, owners);
    if (entry.service === target.workerName) actual.push(entry.hostname);
  }
  for (const hostname of expected) {
    const owners = ownerByHost.get(hostname) ?? [];
    if (owners.length !== 1 || owners[0] !== target.workerName) {
      throw phaseError(
        phase,
        `Worker domain ${hostname} is not owned exactly once by ${target.workerName}`,
      );
    }
  }
  if (JSON.stringify([...new Set(actual)].sort()) !== JSON.stringify(expected)) {
    throw phaseError(
      phase,
      "Worker custom-domain inventory differs from the selected target",
      `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual.sort())}`,
    );
  }
}

function phaseError(phase: DeployPhase, message: string, detail?: string) {
  if (phase === "preflight") return preflightError(message, detail);
  if (phase === "mutation") return mutationError(message, detail);
  return verificationError(message, detail);
}

function isHostname(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(
    value,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
