import { canonicalJson, isSha256Digest } from "../json.ts";
import type { FormAuthorityVerificationEvidence } from "./form-authority-verification.ts";
import type {
  FormAuthorityActivationHead,
  FormAuthorityIdentity,
  FormAuthorityPlanRequest,
  FormAuthorityReadback,
  HostAdmissionCoordinator,
} from "./host-admission-coordinator.ts";
import {
  parseSpaceAdmissionPolicy,
  type SpaceAdmissionPolicyV1,
  spaceAdmissionPolicyDigest,
} from "./space-admission-policy.ts";
import { isSpaceId } from "./space-id.ts";

export interface ExistingSpaceAdmissionRequest {
  readonly policyDigest: `sha256:${string}`;
  readonly spaces: readonly string[];
}

export interface ExistingSpaceAdmissionResult {
  readonly policyDigest: `sha256:${string}`;
  readonly identity: FormAuthorityIdentity;
  readonly spaces: readonly {
    readonly space: string;
    /** Only retained-positive policy intersections, never whole-Space readiness. */
    readonly forms: readonly (SpaceAdmissionPolicyV1["forms"][number] & {
      readonly activationHead: FormAuthorityActivationHead;
    })[];
  }[];
}

export class ExistingSpaceAdmissionError extends Error {
  constructor(readonly code: "invalid_input" | "policy_mismatch" | "admission_not_ready") {
    super(code);
    this.name = "ExistingSpaceAdmissionError";
  }
}

/**
 * Operator-only software-update convergence, not a credential-issuer capability.
 * The policy selects an organization and exact packages; the operator selects
 * existing Spaces. Only their retained positive heads can receive successors.
 * An exception can follow durable writes: never retry or roll back implicitly.
 */
export function createExistingSpaceAdmissionAuthority(options: {
  readonly policy: unknown;
  readonly compose: (policy: SpaceAdmissionPolicyV1) => Promise<{
    readonly identity: FormAuthorityIdentity;
    readonly evidence: FormAuthorityVerificationEvidence;
    readonly endpoint: HostAdmissionCoordinator;
  }>;
}) {
  const policy = parseSpaceAdmissionPolicy(options.policy);

  return {
    async reconcileExistingSpaces(input: unknown): Promise<ExistingSpaceAdmissionResult> {
      const selection = parseSelection(input);
      const policyDigest = await spaceAdmissionPolicyDigest(policy);
      if (selection.policyDigest !== policyDigest) {
        throw new ExistingSpaceAdmissionError("policy_mismatch");
      }
      const composition = await options.compose(policy);
      const { identity, evidence } = composition;
      const snapshots = [];
      // Capture the whole explicit selection before the first mutation.
      for (const space of selection.spaces) {
        const request: FormAuthorityPlanRequest = {
          ...identity,
          kind: "takoserver.form-authority-plan-request@v2",
          activation: {
            kind: "space",
            tenantId: policy.organizationId,
            space,
            desiredActive: true,
          },
          evidence,
          actor: "operator-existing-space-admission",
          reason: `Refresh retained positive admission (${policyDigest})`,
        };
        const before = await composition.endpoint.readback(request);
        assertIdentity(before, request);
        const forms = policy.forms.filter((selected) => {
          const form = exactForm(before, selected);
          return form.activationHead.present && form.activationHead.active;
        });
        snapshots.push({ request, before, forms, expected: before });
      }

      for (const snapshot of snapshots) {
        const { request, before, forms } = snapshot;
        if (forms.length === 0) continue;
        const selectedPolicy = { ...policy, forms };
        const scoped = await options.compose(selectedPolicy);
        if (canonicalJson(scoped.identity) !== canonicalJson(identity)) notReady();
        const plan = await scoped.endpoint.plan(request);
        if (
          canonicalJson(plan.request) !== canonicalJson(request) ||
          canonicalJson(plan.activationPolicy) !== canonicalJson(selectedPolicy) ||
          canonicalJson(activationHeads(plan)) !== canonicalJson(activationHeads(before))
        )
          notReady();
        // Comparing captured activation heads prevents a deactivation between
        // capture and planning from being resurrected. Coordinator apply then
        // fences every command against the exact planned durable predecessor.
        const result = await scoped.endpoint.apply(plan);
        if (
          result.status !== "converged" ||
          result.replanRequired ||
          result.failure !== undefined ||
          result.planDigest !== plan.planDigest ||
          result.verificationMode !== "released-core" ||
          canonicalJson(result.nextPlan.request) !== canonicalJson(request) ||
          canonicalJson(result.nextPlan.activationPolicy) !== canonicalJson(selectedPolicy) ||
          result.nextPlan.commands.length !== 0
        )
          notReady();
        assertIdentity(result.readback, request);
        snapshot.expected = result.readback;
      }

      const spaces = [];
      // A later Space's failure or identity/head drift must not be hidden by
      // an earlier successful apply. Freshly check the complete selection.
      for (const { request, before, forms, expected } of snapshots) {
        const after = await composition.endpoint.readback(request);
        assertIdentity(after, request);
        for (const previous of before.forms) {
          const current = exactForm(after, previous);
          const selected = forms.some((form) => samePackage(form, previous));
          if (selected) {
            if (
              !current.installed ||
              !current.supported ||
              !current.activationHead.present ||
              !current.activationHead.active ||
              !isSha256Digest(current.activationHead.eventDigest) ||
              current.activationHead.implementationDigest !== identity.implementationDigest ||
              canonicalJson(current.activationHead) !==
                canonicalJson(exactForm(expected, previous).activationHead)
            )
              notReady();
          } else if (
            canonicalJson(current.activationHead) !== canonicalJson(previous.activationHead)
          ) {
            notReady();
          }
        }
        spaces.push({
          space: request.activation.space,
          forms: forms.map((selected) => {
            const form = exactForm(after, selected);
            return { ...selected, activationHead: form.activationHead };
          }),
        });
      }
      // Empty forms means no retained positive selection, not Space readiness.
      return { policyDigest, identity, spaces };
    },
  };
}

type PackageIdentity = SpaceAdmissionPolicyV1["forms"][number];

function samePackage(left: PackageIdentity, right: PackageIdentity): boolean {
  return (
    left.packageDigest === right.packageDigest &&
    canonicalJson(left.formRef) === canonicalJson(right.formRef)
  );
}

function exactForm(readback: FormAuthorityReadback, selected: PackageIdentity) {
  const matches = readback.forms.filter((form) => samePackage(form, selected));
  const form = matches[0];
  if (matches.length !== 1 || !form) notReady();
  return form;
}

function activationHeads(value: Pick<FormAuthorityReadback, "currentHeads">) {
  return value.currentHeads.filter((head) => head.kind === "activation");
}

function assertIdentity(readback: FormAuthorityReadback, request: FormAuthorityPlanRequest): void {
  const {
    kind: _kind,
    activation,
    evidence: _evidence,
    actor: _actor,
    reason: _reason,
    ...identity
  } = request;
  if (
    readback.kind !== "takoserver.form-authority-readback@v2" ||
    canonicalJson(readback.identity) !== canonicalJson(identity) ||
    canonicalJson(readback.activation) !== canonicalJson(activation)
  )
    notReady();
}

function parseSelection(input: unknown): { policyDigest: string; spaces: string[] } {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join("\0") !== "policyDigest\0spaces" ||
    !("policyDigest" in input) ||
    !isSha256Digest(input.policyDigest) ||
    !("spaces" in input) ||
    !Array.isArray(input.spaces) ||
    input.spaces.length === 0 ||
    input.spaces.length > 100 ||
    !input.spaces.every(
      (space): space is string => typeof space === "string" && isSpaceId(space),
    ) ||
    new Set(input.spaces).size !== input.spaces.length
  )
    throw new ExistingSpaceAdmissionError("invalid_input");
  return { policyDigest: input.policyDigest, spaces: [...input.spaces] };
}

function notReady(): never {
  throw new ExistingSpaceAdmissionError("admission_not_ready");
}
