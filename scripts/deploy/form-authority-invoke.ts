import { INTEGRATION_FORM_PACKAGES } from "../../src/generated/takoform-integration-form-packages.ts";
import { canonicalDigest, canonicalJson, isSha256Digest } from "../../src/json.ts";
import { signOperatorAssertion } from "../../src/operator-key.ts";
import { parseStrictJson } from "../../src/strict-json.ts";
import {
  TAKOFORM_REVOCATION_V1,
  TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
  TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
} from "../../src/takoform/admission.ts";
import {
  CURRENT_PUBLISHER_COMMIT,
  CURRENT_PUBLISHER_REPOSITORY,
} from "../../src/takoform/current-publisher-catalog.ts";
import type { FormAuthorityVerificationEvidence } from "../../src/takoform/form-authority-verification.ts";
import {
  canonicalFormAuthorityPlanDigest,
  type FormAuthorityActivationHead,
  type FormAuthorityApplyResult,
  type FormAuthorityIdentity,
  type FormAuthorityPlan,
  type FormAuthorityPlanRequest,
  type FormAuthorityReadback,
} from "../../src/takoform/host-admission-coordinator.ts";
import { deriveFormAuthorityIdentity } from "../../src/takoform/host-admission-endpoint.ts";
import { type DeployPhase, mutationError, preflightError, verificationError } from "./errors.ts";
import {
  type FormAuthorityDeployOptions,
  publicFormCapabilityManifest,
  runFormAuthority,
} from "./form-authority.ts";
import {
  assertLoadedFormAuthorityScopeTransition,
  type LoadedFormAuthorityScopeTransition,
} from "./form-authority-scope-transition.ts";
import { provePrivateMatchesPublic, readPrivateJwk } from "./identity.ts";
import { type CommandResult, requireEnvironment, runCommand } from "./process.ts";
import { type DeployEnvironment, qualifySource } from "./qualification.ts";
import type { DeployTarget } from "./target.ts";

const MAX_RESPONSE_BYTES = 8 * 1_024 * 1_024;
const ASSERTION_LIFETIME_SECONDS = 60;
const READ_REQUEST_TIMEOUT_MS = 30_000;
const APPLY_REQUEST_TIMEOUT_MS = 55_000;
const FORM_OPERATION_ORDER = ["create", "read", "update", "delete", "import", "observe"] as const;
const ADMISSION_STATES = new Set([
  "allow",
  "rotate",
  "deny",
  "checkpoint",
  "install",
  "replace",
  "uninstall",
  "purge-pending",
  "purged",
  "supported",
  "unsupported",
  "active",
  "inactive",
  "pending",
  "settled",
]);

export interface FormAuthorityInvokeInvocation {
  readonly surface:
    | "takoserver-integration-form-authority"
    | "takoserver-integration-form-authority-deactivation";
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly scopeTransition?: LoadedFormAuthorityScopeTransition;
}

export interface FormAuthorityInvokeOptions {
  readonly inspectGateway?: () => Promise<unknown>;
  readonly privateJwkPath?: string;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
  readonly run?: (
    command: readonly string[],
    options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
  ) => Promise<CommandResult>;
  readonly review?: string;
  readonly gatewayDeployOptions?: FormAuthorityDeployOptions;
}

export function formAuthorityRequestTimeoutMs(action: "plan" | "apply" | "readback"): number {
  return action === "apply" ? APPLY_REQUEST_TIMEOUT_MS : READ_REQUEST_TIMEOUT_MS;
}

interface GatewayIdentity {
  readonly origin: string;
  readonly identity: FormAuthorityIdentity & { readonly environment: "integration" };
}

/**
 * Owner-only signed integration invocation. It never binds or calls D1/R2.
 * Apply obtains one fresh plan, sends that exact digest-bearing object once,
 * then performs one independently signed readback. Partial results are
 * returned with their receipts and are never retried inside this command.
 */
export async function runFormAuthorityInvoke(
  invocation: FormAuthorityInvokeInvocation,
  target: DeployTarget,
  options: FormAuthorityInvokeOptions = {},
): Promise<Record<string, unknown>> {
  assertIntegrationInvocation(invocation, target);
  if (invocation.scopeTransition) {
    if (invocation.surface !== "takoserver-integration-form-authority-deactivation") {
      throw preflightError("normal Form authority activation never accepts a scope transition");
    }
    assertLoadedFormAuthorityScopeTransition(invocation.scopeTransition, target);
  }
  const formAuthority = target.formAuthority;
  const publicJwk = formAuthority?.operatorPublicJwk;
  const targetScope = formAuthority?.integrationOperatorScope;
  if (
    !formAuthority?.integrationOperatorWorkerName ||
    !formAuthority.integrationOperatorOrigin ||
    !formAuthority.integrationWorkerName ||
    !publicJwk ||
    !targetScope
  ) {
    throw preflightError("integration Form authority invocation target is incomplete");
  }
  const scope = invocation.scopeTransition?.value.predecessorScope ?? targetScope;

  const status = await inspectGateway(invocation, target, options);
  const gateway = await exactGatewayIdentity(status, invocation, target);
  const qualification =
    invocation.action === "apply"
      ? {
          source: await qualifySource({
            environment: "integration",
            commit: invocation.commit,
            run: options.run ?? runCommand,
          }),
          reviewer: exactReviewer(
            options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
          ),
        }
      : undefined;
  const privateInput = readPrivateJwk(
    options.privateJwkPath ??
      requireEnvironment("TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH"),
  );
  await provePrivateMatchesPublic(privateInput, publicJwk);
  const now = options.now ?? (() => new Date());
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const request = await integrationPlanRequest({
    identity: gateway.identity,
    scope,
    desiredActive: invocation.surface === "takoserver-integration-form-authority",
  });
  const client = formAuthorityClient({
    gateway,
    privateJwk: privateInput.jwk,
    now,
    fetcher,
  });

  if (invocation.action === "status") {
    const readback = parseExactReadback(
      await client.call("readback", request, "preflight"),
      request,
      false,
      "preflight",
    );
    return invocationResult({
      invocation,
      gateway,
      scope,
      readback,
      ready: readbackConverged(readback),
    });
  }

  if (!qualification) throw preflightError("Form authority apply qualification is absent");
  const plan = await exactPlan(await client.call("plan", request, "preflight"), request);
  const applied = await exactApplyResult(await client.call("apply", plan, "mutation"), plan);
  const readbackValue = await client.call("readback", request, "verification");
  const readback =
    applied.status === "partial"
      ? parseExactReadback(readbackValue, request, false, "verification")
      : exactReadback(readbackValue, request, "verification");
  if (applied.status === "partial") {
    throw verificationError(
      "Form authority apply acknowledged partial convergence",
      canonicalJson({
        kind: "takoserver.form-authority-partial-diagnostics@v2",
        planDigest: applied.planDigest,
        receipts: applied.receipts.map((receipt) => ({
          index: receipt.index,
          commandDigest: receipt.commandDigest,
          kind: receipt.kind,
          eventDigest: receipt.eventDigest,
          state: receipt.state,
          changed: receipt.changed,
          policyAuthority: receipt.policyAuthority,
          verificationMode: receipt.verificationMode,
          productionEligible: receipt.productionEligible,
        })),
        ...(applied.failure === undefined ? {} : { failure: applied.failure }),
        nextPlanDigest: applied.nextPlan.planDigest,
        nextCommandCount: applied.nextPlan.commands.length,
        readbackHeadDigest: readback.currentHeadDigest,
      }),
    );
  }
  const converged =
    applied.status === "converged" &&
    applied.replanRequired === false &&
    applied.nextPlan.commands.length === 0 &&
    readbackConverged(readback);
  return invocationResult({
    invocation,
    gateway,
    scope,
    readback,
    ready: converged,
    source: {
      dirty: qualification.source.dirty,
      remoteRef: qualification.source.remoteRef,
    },
    reviewer: qualification.reviewer,
    plan: {
      planDigest: plan.planDigest,
      currentHeadDigest: plan.currentHeadDigest,
      commandCount: plan.commands.length,
    },
    applied: {
      status: applied.status,
      planDigest: applied.planDigest,
      receipts: structuredClone(applied.receipts),
      policyAuthority: applied.policyAuthority,
      verificationMode: applied.verificationMode,
      productionEligible: applied.productionEligible,
      replanRequired: applied.replanRequired,
      nextPlanDigest: applied.nextPlan.planDigest,
      nextCommandCount: applied.nextPlan.commands.length,
      ...(applied.failure === undefined ? {} : { failure: structuredClone(applied.failure) }),
    },
  });
}

async function inspectGateway(
  invocation: FormAuthorityInvokeInvocation,
  target: DeployTarget,
  options: FormAuthorityInvokeOptions,
): Promise<unknown> {
  if (options.inspectGateway) return await options.inspectGateway();
  return await runFormAuthority(
    {
      surface: "takoserver-integration-form-authority-operator-worker",
      action: "status",
      environment: "integration",
      commit: invocation.commit,
      ...(invocation.scopeTransition === undefined
        ? {}
        : { scopeTransition: invocation.scopeTransition }),
    },
    target,
    options.gatewayDeployOptions,
  );
}

async function exactGatewayIdentity(
  value: unknown,
  invocation: FormAuthorityInvokeInvocation,
  target: DeployTarget,
): Promise<GatewayIdentity> {
  const authority = target.formAuthority;
  if (!isRecord(value) || !authority?.integrationOperatorOrigin) {
    throw preflightError("Form authority operator gateway status is invalid");
  }
  const workerArtifactDigest = value.workerArtifactDigest;
  const publicWorkerVersionId = value.publicWorkerVersionId;
  const implementationPayloadDigest = value.implementationPayloadDigest;
  const transition = invocation.scopeTransition;
  const expectedScopeProfile = transition ? "exact-transition-predecessor" : "exact-target";
  if (
    value.kind !== "takoserver.form-authority-worker-status@v1" ||
    value.surface !== "takoserver-integration-form-authority-operator-worker" ||
    value.environment !== "integration" ||
    value.workerName !== authority.integrationOperatorWorkerName ||
    value.hostId !== authority.hostId ||
    value.selectedCommit !== invocation.commit ||
    value.deployedCommit !== invocation.commit ||
    value.commitMatches !== true ||
    value.publicWorkerCommit !== invocation.commit ||
    value.publicWorkerCommitMatches !== true ||
    value.publicIdentityRpcReady !== true ||
    value.authorityDeployedCommit !== invocation.commit ||
    value.authorityCommitMatches !== true ||
    value.publicWorkerBindingProfile !== "dynamic-public-rpc" ||
    value.authorityPublicWorkerBindingProfile !== "dynamic-public-rpc" ||
    value.scopeBindingProfile !== expectedScopeProfile ||
    value.authorityScopeBindingProfile !== expectedScopeProfile ||
    (transition
      ? value.scopeTransitionDigest !== transition.digest || value.ready !== false
      : value.scopeTransitionDigest !== undefined || value.ready !== true) ||
    value.operatorOrigin !== authority.integrationOperatorOrigin ||
    value.authorityWorkerName !== authority.integrationWorkerName ||
    value.routeMode !== "authenticated-integration-custom-domain" ||
    value.policyAuthority !== "takoserver-host" ||
    value.verificationMode !== "integration-fixture" ||
    value.verificationAvailable !== true ||
    value.productionEligible !== false ||
    !workerVersion(value.versionId) ||
    !workerVersion(value.authorityVersionId) ||
    !isSha256Digest(value.authorityArtifactDigest) ||
    !isSha256Digest(workerArtifactDigest) ||
    !workerVersion(publicWorkerVersionId) ||
    !isSha256Digest(implementationPayloadDigest) ||
    !isSha256Digest(value.capabilityDigest) ||
    !isSha256Digest(value.implementationDigest)
  ) {
    throw preflightError("Form authority operator gateway is not ready at the exact commit");
  }
  const identity = await deriveFormAuthorityIdentity({
    environment: "integration",
    hostId: authority.hostId,
    workerArtifactDigest,
    publicWorkerVersionId,
    implementationPayloadDigest,
    implementationDigest: value.implementationDigest,
    capabilities: publicFormCapabilityManifest(),
  });
  if (
    identity.capabilityDigest !== value.capabilityDigest ||
    identity.implementationDigest !== value.implementationDigest
  ) {
    throw preflightError("Form authority gateway implementation identity is inconsistent");
  }
  return {
    origin: authority.integrationOperatorOrigin,
    identity: { ...identity, environment: "integration" },
  };
}

function formAuthorityClient(input: {
  readonly gateway: GatewayIdentity;
  readonly privateJwk: JsonWebKey;
  readonly now: () => Date;
  readonly fetcher: (input: string, init?: RequestInit) => Promise<Response>;
}): {
  call(action: "plan" | "apply" | "readback", body: unknown, phase: DeployPhase): Promise<unknown>;
} {
  return {
    async call(action, body, phase) {
      const nowSeconds = Math.floor(input.now().getTime() / 1_000);
      if (!Number.isSafeInteger(nowSeconds)) throw phaseError(phase, "operator clock is invalid");
      const path = `/v1/${action}` as const;
      let assertion: string;
      try {
        assertion = await signOperatorAssertion({
          privateJwk: JSON.stringify(input.privateJwk),
          claims: {
            purpose: "form-authority",
            action,
            method: "POST",
            path,
            bodyDigest: await canonicalDigest(body),
            environment: "integration",
            hostId: input.gateway.identity.hostId,
            workerArtifactDigest: input.gateway.identity.workerArtifactDigest,
            publicWorkerVersionId: input.gateway.identity.publicWorkerVersionId,
            implementationDigest: input.gateway.identity.implementationDigest,
          },
          nowSeconds,
          lifetimeSeconds: ASSERTION_LIFETIME_SECONDS,
        });
      } catch {
        throw phaseError(phase, "Form authority assertion signing failed; private key redacted");
      }
      let response: Response;
      try {
        response = await input.fetcher(`${input.gateway.origin}${path}`, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${assertion}`,
            "cache-control": "no-store",
            "content-type": "application/json",
          },
          body: canonicalJson(body),
          redirect: "error",
          signal: AbortSignal.timeout(formAuthorityRequestTimeoutMs(action)),
        });
      } catch {
        throw phaseError(
          phase,
          `Form authority ${action} transport failed; assertion and private key redacted`,
        );
      }
      let parsed: unknown;
      try {
        const bytes = await boundedResponse(response);
        parsed = parseStrictJson(bytes, MAX_RESPONSE_BYTES);
      } catch {
        throw phaseError(
          phase,
          `Form authority ${action} returned an invalid bounded response; credentials redacted`,
          `status=${response.status}`,
        );
      }
      if (
        response.status !== 200 ||
        !jsonResponseContentType(response.headers.get("content-type"))
      ) {
        throw phaseError(
          phase,
          `Form authority ${action} was refused; credentials redacted`,
          `status=${response.status} code=${responseErrorCode(parsed)}`,
        );
      }
      return parsed;
    },
  };
}

async function integrationPlanRequest(input: {
  readonly identity: FormAuthorityIdentity & { readonly environment: "integration" };
  readonly scope: { readonly tenantId: string; readonly space: string };
  readonly desiredActive: boolean;
}): Promise<FormAuthorityPlanRequest> {
  const packageClosure = INTEGRATION_FORM_PACKAGES.map(({ formRef, packageDigest }) => ({
    formRef,
    packageDigest,
  }));
  const policy = {
    apiVersion: "takoserver.integration-form-authority-policy@v1",
    mode: "integration-fixture",
    fixtureOnly: true,
    packageClosure,
  } as const;
  const policyDigest = await canonicalDigest(policy);
  const trustedRootDigest = await canonicalDigest({
    kind: "takoserver.integration-fixture-root@v1",
    packageClosure,
  });
  const bundleDigest = await canonicalDigest({
    kind: "takoserver.integration-fixture-bundle@v1",
    packageClosure,
  });
  const namespaceGrantDigest = await canonicalDigest({
    kind: "takoserver.integration-fixture-namespace@v1",
    group: "edge.forms.takoform.com",
    packageClosure,
  });
  const publisherPins = {
    oidcIssuer: "https://integration-fixture.invalid",
    sourceRepository: CURRENT_PUBLISHER_REPOSITORY,
    workflow: "takoform-forms:checked-in-corpus",
    ref: `git:${CURRENT_PUBLISHER_COMMIT}`,
    identity: "external-integration-fixture",
    trustedRootDigest,
    sourceCommit: CURRENT_PUBLISHER_COMMIT,
    workflowCommit: CURRENT_PUBLISHER_COMMIT,
    buildConfigCommit: CURRENT_PUBLISHER_COMMIT,
    repositoryIdentifier: "repo:tako0614/takoform-forms",
    ownerIdentifier: "owner:tako0614",
    group: "edge.forms.takoform.com",
    namespaceGrantDigest,
  } as const;
  const publisherGenerationDigest = await canonicalDigest({
    kind: "takoserver.integration-fixture-publisher-generation@v1",
    policyDigest,
    bundleDigest,
    ...publisherPins,
  });
  const evidence: FormAuthorityVerificationEvidence = {
    publisher: {
      publisherKey: `takoform-integration-fixture:${publisherGenerationDigest}`,
      policyDigest,
      policy,
      ...publisherPins,
    },
    checkpoint: {
      apiVersion: TAKOFORM_REVOCATION_V1,
      sequence: 0,
      digest: TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
      entriesDigest: TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
      previousDigest: null,
      revokedPackageDigests: [],
    },
    bundleDigest,
  };
  return {
    kind: "takoserver.form-authority-plan-request@v2",
    ...input.identity,
    activation: {
      kind: "space",
      tenantId: input.scope.tenantId,
      space: input.scope.space,
      desiredActive: input.desiredActive,
    },
    evidence,
    actor: input.desiredActive
      ? "takoserver-integration-form-authority-operator"
      : "takoserver-integration-form-authority-deactivation-operator",
    reason: input.desiredActive
      ? "install, support and Space-activate the exact Yurucommu integration fixture"
      : "deactivate the exact Yurucommu integration fixture at its current durable head",
  };
}

async function exactPlan(
  value: unknown,
  request: FormAuthorityPlanRequest,
): Promise<FormAuthorityPlan> {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "commands",
      "currentHeadDigest",
      "currentHeads",
      "kind",
      "packages",
      "planDigest",
      "request",
    ]) ||
    value.kind !== "takoserver.form-authority-plan@v2" ||
    !isSha256Digest(value.planDigest) ||
    !isSha256Digest(value.currentHeadDigest) ||
    canonicalJson(value.request) !== canonicalJson(request) ||
    !Array.isArray(value.packages) ||
    !Array.isArray(value.currentHeads) ||
    !Array.isArray(value.commands)
  ) {
    throw preflightError("Form authority plan response is invalid");
  }
  const plan = value as unknown as FormAuthorityPlan;
  const { planDigest, ...unsigned } = plan;
  if (
    (await canonicalFormAuthorityPlanDigest(unsigned)) !== planDigest ||
    !exactPackageClosure(plan.packages) ||
    !(await exactPlanCommands(plan.commands, request))
  ) {
    throw preflightError("Form authority plan digest or package closure is invalid");
  }
  return structuredClone(plan);
}

async function exactPlanCommands(
  commands: readonly unknown[],
  request: FormAuthorityPlanRequest,
): Promise<boolean> {
  for (const [index, value] of commands.entries()) {
    if (!isRecord(value) || value.index !== index || !isSha256Digest(value.commandDigest)) {
      return false;
    }
    const { commandDigest, ...unsigned } = value;
    if ((await canonicalDigest(unsigned)) !== commandDigest) return false;
    if (value.kind === "SetActivation") {
      if (
        typeof value.active !== "boolean" ||
        !isSha256Digest(value.implementationDigest) ||
        value.active !== request.activation.desiredActive
      ) {
        return false;
      }
    }
  }
  return true;
}

async function exactApplyResult(
  value: unknown,
  plan: FormAuthorityPlan,
): Promise<FormAuthorityApplyResult> {
  if (
    !isRecord(value) ||
    value.kind !== "takoserver.form-authority-apply@v2" ||
    (value.status !== "converged" && value.status !== "partial") ||
    value.planDigest !== plan.planDigest ||
    !Array.isArray(value.receipts) ||
    value.policyAuthority !== "takoserver-host" ||
    value.verificationMode !== "integration-fixture" ||
    value.productionEligible !== false ||
    typeof value.replanRequired !== "boolean" ||
    !isRecord(value.readback) ||
    !isRecord(value.nextPlan)
  ) {
    throw mutationError(
      "Form authority apply acknowledgement is invalid; do not retry before status",
    );
  }
  const result = value as unknown as FormAuthorityApplyResult;
  const { planDigest: nextPlanDigest, ...nextUnsigned } = result.nextPlan;
  if (
    !isSha256Digest(nextPlanDigest) ||
    (await canonicalFormAuthorityPlanDigest(nextUnsigned)) !== nextPlanDigest ||
    canonicalJson(result.nextPlan.request) !== canonicalJson(plan.request) ||
    !exactPackageClosure(result.nextPlan.packages) ||
    !(await exactPlanCommands(result.nextPlan.commands, plan.request)) ||
    result.receipts.some((receipt, index) => {
      const command = plan.commands[index];
      return (
        !isRecord(receipt) ||
        !exactKeys(receipt, [
          "changed",
          "commandDigest",
          "eventDigest",
          "index",
          "kind",
          "policyAuthority",
          "productionEligible",
          "state",
          "verificationMode",
        ]) ||
        !command ||
        !Number.isSafeInteger(receipt.index) ||
        receipt.index !== index ||
        !isSha256Digest(receipt.commandDigest) ||
        receipt.commandDigest !== command.commandDigest ||
        receipt.kind !== command.kind ||
        !isSha256Digest(receipt.eventDigest) ||
        typeof receipt.state !== "string" ||
        !ADMISSION_STATES.has(receipt.state) ||
        typeof receipt.changed !== "boolean" ||
        receipt.policyAuthority !== "takoserver-host" ||
        receipt.verificationMode !== "integration-fixture" ||
        receipt.productionEligible !== false
      );
    }) ||
    (result.status === "converged" &&
      (result.replanRequired ||
        result.receipts.length !== plan.commands.length ||
        result.nextPlan.commands.length !== 0 ||
        result.failure !== undefined)) ||
    (result.failure !== undefined &&
      (!isRecord(result.failure) ||
        !exactKeys(result.failure, ["code", "commandDigest", "index"]) ||
        !Number.isSafeInteger(result.failure.index) ||
        !isSha256Digest(result.failure.commandDigest) ||
        typeof result.failure.code !== "string" ||
        !/^[a-z][a-z0-9_]{0,63}$/u.test(result.failure.code))) ||
    (result.status === "partial" &&
      (!result.replanRequired ||
        (result.failure === undefined
          ? result.receipts.length !== plan.commands.length
          : result.failure.index !== result.receipts.length ||
            result.failure.commandDigest !== plan.commands[result.failure.index]?.commandDigest)))
  ) {
    throw mutationError("Form authority apply receipts are invalid; do not retry before status");
  }
  return structuredClone(result);
}

function exactReadback(
  value: unknown,
  request: FormAuthorityPlanRequest,
  phase: DeployPhase,
): FormAuthorityReadback {
  return parseExactReadback(value, request, true, phase);
}

function parseExactReadback(
  value: unknown,
  request: FormAuthorityPlanRequest,
  requireConverged: boolean,
  phase: DeployPhase,
): FormAuthorityReadback {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "activation",
      "currentHeadDigest",
      "currentHeads",
      "forms",
      "identity",
      "kind",
    ]) ||
    value.kind !== "takoserver.form-authority-readback@v2" ||
    canonicalJson(value.identity) !== canonicalJson(formAuthorityRequestIdentity(request)) ||
    canonicalJson(value.activation) !== canonicalJson(request.activation) ||
    !isSha256Digest(value.currentHeadDigest) ||
    !Array.isArray(value.currentHeads) ||
    !Array.isArray(value.forms) ||
    !exactPackageClosure(value.forms) ||
    value.forms.some(
      (form) =>
        !isRecord(form) ||
        !exactKeys(form, [
          "activationHead",
          "formRef",
          "installed",
          "operations",
          "packageDigest",
          "supported",
        ]) ||
        !Array.isArray(form.operations) ||
        form.operations.some(
          (operation) =>
            typeof operation !== "string" ||
            !FORM_OPERATION_ORDER.includes(operation as (typeof FORM_OPERATION_ORDER)[number]),
        ) ||
        new Set(form.operations).size !== form.operations.length ||
        typeof form.installed !== "boolean" ||
        typeof form.supported !== "boolean" ||
        !validActivationHead(form.activationHead) ||
        (requireConverged && !formReady(form, request)),
    )
  ) {
    throw phaseError(phase, "Form authority readback is invalid");
  }
  return structuredClone(value as unknown as FormAuthorityReadback);
}

function exactPackageClosure(values: readonly unknown[]): boolean {
  const actual = values.flatMap((value) => {
    if (!isRecord(value) || !isRecord(value.formRef) || !isSha256Digest(value.packageDigest)) {
      return [];
    }
    return [canonicalJson({ formRef: value.formRef, packageDigest: value.packageDigest })];
  });
  const expected = INTEGRATION_FORM_PACKAGES.map(({ formRef, packageDigest }) =>
    canonicalJson({ formRef, packageDigest }),
  );
  return (
    actual.length === expected.length &&
    [...actual].sort().every((entry, index) => entry === [...expected].sort()[index])
  );
}

function readbackConverged(readback: FormAuthorityReadback): boolean {
  if (readback.forms.length !== INTEGRATION_FORM_PACKAGES.length) return false;
  if (!readback.activation.desiredActive) {
    return readback.forms.every(
      ({ activationHead }) => !activationHead.present || !activationHead.active,
    );
  }
  return readback.forms.every(
    ({ installed, supported, activationHead }) =>
      installed &&
      supported &&
      activationHead.present &&
      activationHead.active &&
      activationHead.implementationDigest === readback.identity.implementationDigest,
  );
}

function validActivationHead(value: unknown): value is FormAuthorityActivationHead {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["active", "eventDigest", "implementationDigest", "present"]) ||
    typeof value.present !== "boolean" ||
    typeof value.active !== "boolean"
  ) {
    return false;
  }
  if (!value.present) {
    return (
      value.active === false && value.eventDigest === null && value.implementationDigest === null
    );
  }
  return (
    value.eventDigest !== null &&
    isSha256Digest(value.eventDigest) &&
    value.implementationDigest !== null &&
    isSha256Digest(value.implementationDigest)
  );
}

function formReady(
  form: Readonly<Record<string, unknown>>,
  request: FormAuthorityPlanRequest,
): boolean {
  const activationHead = form.activationHead;
  if (!validActivationHead(activationHead)) return false;
  if (!request.activation.desiredActive) {
    return !activationHead.present || !activationHead.active;
  }
  return (
    form.installed === true &&
    form.supported === true &&
    activationHead.present &&
    activationHead.active &&
    activationHead.implementationDigest === request.implementationDigest
  );
}

function formAuthorityRequestIdentity(request: FormAuthorityPlanRequest): FormAuthorityIdentity {
  return {
    environment: request.environment,
    hostId: request.hostId,
    workerArtifactDigest: request.workerArtifactDigest,
    publicWorkerVersionId: request.publicWorkerVersionId,
    capabilityDigest: request.capabilityDigest,
    implementationDigest: request.implementationDigest,
  };
}

function invocationResult(input: {
  readonly invocation: FormAuthorityInvokeInvocation;
  readonly gateway: GatewayIdentity;
  readonly scope: { readonly tenantId: string; readonly space: string };
  readonly readback: FormAuthorityReadback;
  readonly ready: boolean;
  readonly source?: { readonly dirty: boolean; readonly remoteRef: string | null };
  readonly reviewer?: string;
  readonly plan?: Record<string, unknown>;
  readonly applied?: Record<string, unknown>;
}): Record<string, unknown> {
  const transition = input.invocation.scopeTransition !== undefined;
  return {
    kind: "takoserver.integration-form-authority-invocation@v2",
    surface: input.invocation.surface,
    action: input.invocation.action,
    environment: "integration",
    commit: input.invocation.commit,
    operatorOrigin: input.gateway.origin,
    identity: structuredClone(input.gateway.identity),
    activation: transition
      ? {
          kind: "space",
          desiredActive: false,
          scopeRedacted: true,
        }
      : {
          kind: "space",
          ...input.scope,
          desiredActive: input.invocation.surface === "takoserver-integration-form-authority",
        },
    policyAuthority: "takoserver-host",
    verificationMode: "integration-fixture",
    productionEligible: false,
    scopeBindingProfile: input.invocation.scopeTransition
      ? "exact-transition-predecessor"
      : "exact-target",
    ...(input.invocation.scopeTransition === undefined
      ? {}
      : { scopeTransitionDigest: input.invocation.scopeTransition.digest }),
    ...(input.source === undefined ? {} : input.source),
    ...(input.reviewer === undefined ? {} : { reviewer: input.reviewer }),
    ...(input.plan === undefined ? {} : { plan: input.plan }),
    ...(input.applied === undefined ? {} : { apply: input.applied }),
    readback: transition
      ? {
          kind: "takoserver.form-authority-readback-summary@v1",
          currentHeadDigest: input.readback.currentHeadDigest,
          desiredActive: false,
          allInactive: input.readback.forms.every(
            ({ activationHead }) => !activationHead.present || !activationHead.active,
          ),
          scopeRedacted: true,
        }
      : structuredClone(input.readback),
    ready: input.ready,
    credentialsRedacted: true,
  };
}

async function boundedResponse(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw new TypeError("response too large");
  }
  if (!response.body) throw new TypeError("response body missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new TypeError("response too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function responseErrorCode(value: unknown): string {
  if (
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(value.error.code)
  ) {
    return value.error.code;
  }
  return "invalid_response";
}

function jsonResponseContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function assertIntegrationInvocation(
  invocation: FormAuthorityInvokeInvocation,
  target: DeployTarget,
): void {
  if (invocation.environment !== "integration" || target.environment !== "integration") {
    throw preflightError("Form authority operator invocation is integration-only");
  }
  if (target.environment !== invocation.environment) {
    throw preflightError("Form authority operator invocation and target environments differ");
  }
}

function exactReviewer(value: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 256 || value.includes("\n")) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW must name one reviewer");
  }
  return value;
}

function phaseError(phase: DeployPhase, message: string, detail?: string) {
  if (phase === "preflight") return preflightError(message, detail);
  if (phase === "mutation") return mutationError(message, detail);
  return verificationError(message, detail);
}

function workerVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  );
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
