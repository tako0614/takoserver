import { canonicalJson } from "../json.ts";
import type { Sql } from "../ports.ts";
import type { FormAuthorityVerificationEvidence } from "./form-authority-verification.ts";
import type {
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

export interface TenantSpaceAdmissionReady {
  readonly organizationId: string;
  readonly tenantRef: string;
  readonly spaceRef: string;
  readonly policyDigest: `sha256:${string}`;
  readonly ready: true;
}

export class TenantSpaceAdmissionError extends Error {
  constructor(readonly code: "invalid_input" | "tenant_not_owned" | "admission_not_ready") {
    super(code);
    this.name = "TenantSpaceAdmissionError";
  }
}

/**
 * Positive-only managed admission. The operator selects the policy; the
 * authenticated caller can name only an already-owned opaque tenant. This
 * composition explicitly uses that tenant reference as its Space reference.
 * It does not change the general credential API's independent Space field.
 *
 * compose must bind the supplied policy to a released-Core Form authority
 * composition. Neither raw plans nor publisher evidence cross this narrow
 * caller boundary. Partial application is retained for a subsequent fresh
 * invocation; this method never retries, deactivates, or issues credentials.
 */
export function createTenantSpaceAdmissionAuthority(options: {
  readonly policy: unknown;
  readonly sql: Pick<Sql, "query">;
  readonly compose: (policy: SpaceAdmissionPolicyV1) => Promise<{
    readonly identity: FormAuthorityIdentity;
    readonly evidence: FormAuthorityVerificationEvidence;
    readonly endpoint: HostAdmissionCoordinator;
  }>;
}) {
  const policy = parseSpaceAdmissionPolicy(options.policy);

  async function assertOwnership(tenantRef: string): Promise<void> {
    const rows = await options.sql.query(
      "SELECT org_id FROM sponsorship_tenants WHERE tenant_ref = ? LIMIT 2",
      [tenantRef],
    );
    if (rows.length !== 1 || rows[0]?.org_id !== policy.organizationId) {
      throw new TenantSpaceAdmissionError("tenant_not_owned");
    }
  }

  return {
    async ensureTenantSpaceAdmission(value: unknown): Promise<TenantSpaceAdmissionReady> {
      const tenantRef = tenantReference(value);
      await assertOwnership(tenantRef);
      const policyDigest = await spaceAdmissionPolicyDigest(policy);
      const { identity, evidence, endpoint } = await options.compose(policy);
      const request: FormAuthorityPlanRequest = {
        ...identity,
        kind: "takoserver.form-authority-plan-request@v2",
        activation: {
          kind: "space",
          tenantId: policy.organizationId,
          space: tenantRef,
          desiredActive: true,
        },
        evidence,
        actor: "operator-managed-space-admission",
        reason: `Ensure operator-approved Forms (${policyDigest})`,
      };
      const plan = await endpoint.plan(request);
      if (
        canonicalJson(plan.request) !== canonicalJson(request) ||
        canonicalJson(plan.activationPolicy ?? null) !== canonicalJson(policy)
      ) {
        notReady();
      }
      // Ownership is checked again after planning, before durable mutation.
      await assertOwnership(tenantRef);
      const result = await endpoint.apply(plan);
      if (
        result.status !== "converged" ||
        result.replanRequired ||
        result.failure !== undefined ||
        result.planDigest !== plan.planDigest ||
        result.verificationMode !== "released-core" ||
        canonicalJson(result.nextPlan.activationPolicy ?? null) !== canonicalJson(policy) ||
        canonicalJson(result.nextPlan.request) !== canonicalJson(request) ||
        result.nextPlan.commands.length !== 0
      ) {
        notReady();
      }
      // Do not trust a cached apply response as current readiness.
      const readback = await endpoint.readback(request);
      assertReady(readback, request, policy);
      await assertOwnership(tenantRef);
      return {
        organizationId: policy.organizationId,
        tenantRef,
        spaceRef: tenantRef,
        policyDigest,
        ready: true,
      };
    },
  };
}

function tenantReference(value: unknown): string {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join("\0") !== "tenantRef" ||
    !("tenantRef" in value) ||
    typeof value.tenantRef !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,254}$/u.test(value.tenantRef) ||
    !isSpaceId(value.tenantRef)
  ) {
    throw new TenantSpaceAdmissionError("invalid_input");
  }
  return value.tenantRef;
}

function assertReady(
  readback: FormAuthorityReadback,
  request: FormAuthorityPlanRequest,
  policy: SpaceAdmissionPolicyV1,
): void {
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
  ) {
    notReady();
  }
  for (const selected of policy.forms) {
    const matches = readback.forms.filter(
      (form) =>
        canonicalJson(form.formRef) === canonicalJson(selected.formRef) &&
        form.packageDigest === selected.packageDigest,
    );
    const form = matches[0];
    if (
      matches.length !== 1 ||
      !form?.installed ||
      !form.supported ||
      !form.activationHead.present ||
      !form.activationHead.active ||
      form.activationHead.eventDigest === null ||
      form.activationHead.implementationDigest !== identity.implementationDigest
    ) {
      notReady();
    }
  }
}

function notReady(): never {
  throw new TenantSpaceAdmissionError("admission_not_ready");
}
