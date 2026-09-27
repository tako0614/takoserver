import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { boundedOperatorBody } from "../../src/existing-space-operator.ts";
import {
  type ExistingSpaceOperatorIdentity,
  existingSpaceOperatorClaims,
  existingSpaceOperatorPath,
} from "../../src/existing-space-operator-proof.ts";
import { canonicalJson, isSha256Digest } from "../../src/json.ts";
import { signOperatorAssertion } from "../../src/operator-key.ts";
import { parseStrictJson } from "../../src/strict-json.ts";
import type {
  FormAuthorityIdentity,
  FormAuthorityPlanRequest,
  FormAuthorityReadback,
} from "../../src/takoform/host-admission-coordinator.ts";
import { loadPublisherSetClosure } from "../../src/takoform/publisher-set-closure.ts";
import { spaceAdmissionPolicyDigest } from "../../src/takoform/space-admission-policy.ts";
import { isSpaceId } from "../../src/takoform/space-id.ts";
import { mutationError, preflightError, verificationError } from "./errors.ts";
import { type FormAuthorityDeployOptions, runFormAuthority } from "./form-authority.ts";
import { provePrivateMatchesPublic, readPrivateJwk } from "./identity.ts";
import { type DeployProcess, requireEnvironment, runCommand } from "./process.ts";
import { type DeployEnvironment, qualifySource } from "./qualification.ts";
import type { DeployTarget } from "./target.ts";

export interface ExistingSpaceOperatorInvocation {
  readonly surface: "takoserver-existing-space-reconciliation";
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
}
export interface ExistingSpaceOperatorOptions {
  readonly requestPath?: string;
  readonly privateJwkPath?: string;
  readonly inspect?: () => Promise<unknown>;
  readonly publisherOptions?: FormAuthorityDeployOptions;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
  readonly review?: string;
  readonly run?: DeployProcess;
}

/** One signed mutation, then read-only observation. No provider writer or retry path. */
export async function runExistingSpaceOperator(
  invocation: ExistingSpaceOperatorInvocation,
  target: DeployTarget,
  options: ExistingSpaceOperatorOptions = {},
): Promise<Record<string, unknown>> {
  if (invocation.environment !== target.environment || !/^[0-9a-f]{40}$/u.test(invocation.commit)) {
    throw preflightError("existing-Space operator target or source mismatch");
  }
  const authority = target.formAuthority;
  const operator = authority?.existingSpaceOperator;
  const policy = authority?.managedSpaceAdmissionPolicy;
  if (!authority || !operator || !policy)
    throw preflightError("explicit existing-Space operator and policy are required");
  const request = loadRequest(
    options.requestPath ?? requireEnvironment("TAKOSERVER_EXISTING_SPACE_REQUEST_PATH"),
  );
  const policyDigest = await spaceAdmissionPolicyDigest(policy);
  if (request.policyDigest !== policyDigest)
    throw preflightError("existing-Space request policy mismatch");
  const inspect =
    options.inspect ??
    (() =>
      runFormAuthority(
        {
          surface: "takoserver-existing-space-operator-worker",
          action: "status",
          environment: invocation.environment,
          commit: invocation.commit,
        },
        target,
        options.publisherOptions,
      ));
  const status = await inspect();
  const identity = exactIdentity(status, invocation, target, policyDigest);
  const source =
    invocation.action === "apply"
      ? await qualifySource({
          environment: invocation.environment,
          commit: invocation.commit,
          run: options.run ?? runCommand,
        })
      : undefined;
  if (invocation.action === "apply") {
    const review = options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW");
    if (!review || review.trim() !== review || review.length > 256 || /[\r\n]/u.test(review))
      throw preflightError("independent review must name one reviewer");
  }
  const key = readPrivateJwk(
    options.privateJwkPath ??
      requireEnvironment("TAKOSERVER_EXISTING_SPACE_OPERATOR_PRIVATE_JWK_PATH"),
  );
  await provePrivateMatchesPublic(key, operator.publicJwk);
  const now = options.now ?? (() => new Date());
  const fetcher = options.fetcher ?? fetch;
  const { evidence, packageSet } = await loadPublisherSetClosure();
  const {
    origin: _origin,
    policyDigest: _policyDigest,
    authorityWorkerVersionId: _authorityVersion,
    ...formIdentity
  } = identity;
  const requests: FormAuthorityPlanRequest[] = request.spaces.map((space) => ({
    ...formIdentity,
    kind: "takoserver.form-authority-plan-request@v2",
    evidence,
    activation: { kind: "space", tenantId: policy.organizationId, space, desiredActive: true },
    actor: "operator-existing-space-reconciliation",
    reason: `Read existing positive heads (${policyDigest})`,
  }));
  const call = async (action: "reconcile" | "readback", body: unknown): Promise<unknown> => {
    const assertion = await signOperatorAssertion({
      privateJwk: JSON.stringify(key.jwk),
      nowSeconds: Math.floor(now().getTime() / 1000),
      lifetimeSeconds: 60,
      claims: await existingSpaceOperatorClaims({ action, body, identity }),
    });
    const response = await fetcher(`${operator.origin}${existingSpaceOperatorPath(action)}`, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(action === "reconcile" ? 55000 : 30000),
      headers: { authorization: `Bearer ${assertion}`, "content-type": "application/json" },
      body: canonicalJson(body),
    });
    if (!response.ok) throw new Error(`existing-Space ${action} returned HTTP ${response.status}`);
    return parseStrictJson(await boundedOperatorBody(response, 8 * 1024 * 1024), 8 * 1024 * 1024);
  };
  // Reinspect after local source/key/evidence work. Never sign against a stale
  // authority/policy/Host proof after a slow qualification step.
  if (
    canonicalJson(exactIdentity(await inspect(), invocation, target, policyDigest)) !==
    canonicalJson(identity)
  ) {
    throw preflightError("existing-Space operator changed during qualification");
  }
  let result: unknown;
  if (invocation.action === "apply") {
    try {
      result = await call("reconcile", request);
    } catch {
      throw mutationError(
        "existing-Space reconciliation is indeterminate; do not retry; run --status for readback",
      );
    }
  }
  const readbacks: FormAuthorityReadback[] = [];
  try {
    for (const readRequest of requests)
      readbacks.push(exactReadback(await call("readback", readRequest), readRequest, packageSet));
    if (
      canonicalJson(exactIdentity(await inspect(), invocation, target, policyDigest)) !==
      canonicalJson(identity)
    )
      throw new Error("identity drift");
    if (invocation.action === "apply")
      assertResult(result, request, formIdentity, readbacks, policy.forms);
  } catch {
    if (invocation.action === "apply")
      throw verificationError(
        "existing-Space reconciliation acknowledged but exact readback failed; no retry or rollback",
      );
    throw preflightError("existing-Space readback failed; no reconciliation was invoked");
  }
  return {
    kind: "takoserver.existing-space-reconciliation-status@v1",
    action: invocation.action,
    environment: invocation.environment,
    selectedCommit: invocation.commit,
    identity,
    policyDigest,
    spaces: request.spaces,
    readbacks,
    ...(invocation.action === "apply" ? { result, source: { dirty: source?.dirty } } : {}),
    // Positive head refresh is deliberately not an application/Space readiness claim.
  };
}

function exactIdentity(
  value: unknown,
  invocation: ExistingSpaceOperatorInvocation,
  target: DeployTarget,
  policyDigest: `sha256:${string}`,
): ExistingSpaceOperatorIdentity {
  const authority = target.formAuthority;
  const operator = authority?.existingSpaceOperator;
  if (
    !record(value) ||
    !authority ||
    !operator ||
    value.kind !== "takoserver.form-authority-worker-status@v1" ||
    value.surface !== "takoserver-existing-space-operator-worker" ||
    value.environment !== invocation.environment ||
    value.workerName !== operator.workerName ||
    value.operatorOrigin !== operator.origin ||
    value.hostId !== authority.hostId ||
    value.selectedCommit !== invocation.commit ||
    value.deployedCommit !== invocation.commit ||
    value.commitMatches !== true ||
    value.publicWorkerCommit !== invocation.commit ||
    value.publicWorkerCommitMatches !== true ||
    value.authorityWorkerName !== authority.workerName ||
    value.authorityDeployedCommit !== invocation.commit ||
    value.authorityCommitMatches !== true ||
    value.publicIdentityRpcReady !== true ||
    value.coreVerifierRpcReady !== true ||
    value.verificationMode !== "released-core" ||
    value.scopeBindingProfile !== "exact-target" ||
    value.authorityScopeBindingProfile !== "exact-target" ||
    value.publicWorkerBindingProfile !== "dynamic-public-rpc" ||
    value.authorityPublicWorkerBindingProfile !== "dynamic-public-rpc" ||
    value.ready !== true ||
    !isSha256Digest(value.workerArtifactDigest) ||
    !isSha256Digest(value.capabilityDigest) ||
    !isSha256Digest(value.implementationDigest) ||
    typeof value.publicWorkerVersionId !== "string" ||
    typeof value.authorityVersionId !== "string"
  ) {
    throw preflightError("existing-Space operator is not at the exact released-Core target");
  }
  return {
    environment: invocation.environment,
    hostId: authority.hostId,
    origin: operator.origin,
    policyDigest,
    workerArtifactDigest: value.workerArtifactDigest,
    capabilityDigest: value.capabilityDigest,
    implementationDigest: value.implementationDigest,
    publicWorkerVersionId: value.publicWorkerVersionId,
    authorityWorkerVersionId: value.authorityVersionId,
  };
}

function exactReadback(
  value: unknown,
  request: FormAuthorityPlanRequest,
  packageSet: readonly { formRef: unknown; packageDigest: string }[],
): FormAuthorityReadback {
  const {
    kind: _kind,
    activation,
    evidence: _evidence,
    actor: _actor,
    reason: _reason,
    ...identity
  } = request;
  if (
    !record(value) ||
    value.kind !== "takoserver.form-authority-readback@v2" ||
    canonicalJson(value.identity) !== canonicalJson(identity) ||
    canonicalJson(value.activation) !== canonicalJson(activation) ||
    !Array.isArray(value.forms) ||
    !Array.isArray(value.currentHeads) ||
    !isSha256Digest(value.currentHeadDigest)
  )
    throw new Error("invalid readback");
  if (value.forms.length !== packageSet.length) throw new Error("incomplete readback");
  const seen = new Set<string>();
  for (const form of value.forms) {
    if (
      !record(form) ||
      typeof form.installed !== "boolean" ||
      typeof form.supported !== "boolean" ||
      !Array.isArray(form.operations) ||
      !form.operations.every((operation) =>
        ["create", "read", "update", "delete", "import", "observe"].includes(operation),
      ) ||
      !record(form.activationHead) ||
      typeof form.activationHead.present !== "boolean" ||
      typeof form.activationHead.active !== "boolean" ||
      !(
        form.activationHead.implementationDigest === null ||
        isSha256Digest(form.activationHead.implementationDigest)
      ) ||
      !(form.activationHead.eventDigest === null || isSha256Digest(form.activationHead.eventDigest))
    )
      throw new Error("invalid readback Form");
    const key = canonicalJson({ formRef: form.formRef, packageDigest: form.packageDigest });
    if (seen.has(key) || !packageSet.some((candidate) => canonicalJson(candidate) === key))
      throw new Error("invalid readback package set");
    seen.add(key);
    if (
      form.activationHead.present
        ? !isSha256Digest(form.activationHead.eventDigest)
        : form.activationHead.active ||
          form.activationHead.eventDigest !== null ||
          form.activationHead.implementationDigest !== null
    )
      throw new Error("invalid readback head");
  }
  for (const head of value.currentHeads) {
    if (
      !record(head) ||
      !["publisher", "checkpoint", "package", "install", "support", "activation"].includes(
        String(head.kind),
      ) ||
      typeof head.key !== "string" ||
      !(head.eventDigest === null || isSha256Digest(head.eventDigest))
    )
      throw new Error("invalid readback current head");
  }
  return value as unknown as FormAuthorityReadback;
}

function assertResult(
  value: unknown,
  request: { policyDigest: string; spaces: readonly string[] },
  identity: FormAuthorityIdentity,
  readbacks: readonly FormAuthorityReadback[],
  policyForms: readonly { formRef: unknown; packageDigest: string }[],
): void {
  if (
    !record(value) ||
    Object.keys(value).sort().join() !== "identity,policyDigest,spaces" ||
    value.policyDigest !== request.policyDigest ||
    canonicalJson(value.identity) !== canonicalJson(identity) ||
    !Array.isArray(value.spaces) ||
    value.spaces.length !== request.spaces.length
  )
    throw new Error("invalid result");
  for (let i = 0; i < request.spaces.length; i++) {
    const scope = value.spaces[i];
    if (!record(scope) || scope.space !== request.spaces[i] || !Array.isArray(scope.forms))
      throw new Error("invalid result scope");
    const seen = new Set<string>();
    for (const form of scope.forms) {
      if (
        !record(form) ||
        !record(form.activationHead) ||
        form.activationHead.present !== true ||
        form.activationHead.active !== true ||
        form.activationHead.implementationDigest !== identity.implementationDigest ||
        !isSha256Digest(form.activationHead.eventDigest)
      )
        throw new Error("invalid result head");
      const key = canonicalJson({ formRef: form.formRef, packageDigest: form.packageDigest });
      if (seen.has(key) || !policyForms.some((candidate) => canonicalJson(candidate) === key))
        throw new Error("invalid result policy");
      seen.add(key);
      const observed = readbacks[i]?.forms.find(
        (candidate) =>
          canonicalJson({ formRef: candidate.formRef, packageDigest: candidate.packageDigest }) ===
          key,
      );
      if (
        !observed?.installed ||
        !observed.supported ||
        canonicalJson(observed.activationHead) !== canonicalJson(form.activationHead)
      )
        throw new Error("result/readback mismatch");
    }
  }
}

function loadRequest(path: string): { policyDigest: string; spaces: string[] } {
  if (!isAbsolute(path))
    throw preflightError("existing-Space request requires an absolute file path");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.uid !== process.getuid?.() ||
      stat.size > 32768
    )
      throw new Error("unsafe");
    const value = parseStrictJson(readFileSync(fd), 32768);
    if (
      !record(value) ||
      Object.keys(value).sort().join() !== "policyDigest,spaces" ||
      !isSha256Digest(value.policyDigest) ||
      !Array.isArray(value.spaces) ||
      value.spaces.length < 1 ||
      value.spaces.length > 100 ||
      !value.spaces.every((space) => typeof space === "string" && isSpaceId(space)) ||
      new Set(value.spaces).size !== value.spaces.length
    )
      throw new Error("invalid");
    return { policyDigest: value.policyDigest, spaces: value.spaces };
  } catch {
    throw preflightError(
      "existing-Space request must be exact bounded JSON in an owned 0600 non-link file",
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
