import { describe, expect, test } from "bun:test";
import type { Row } from "../src/ports.ts";
import type {
  FormAuthorityApplyResult,
  FormAuthorityIdentity,
  FormAuthorityPlan,
  FormAuthorityPlanRequest,
  FormAuthorityReadback,
  HostAdmissionCoordinator,
} from "../src/takoform/host-admission-coordinator.ts";
import { loadPublisherSetClosure } from "../src/takoform/publisher-set-closure.ts";
import {
  createTenantSpaceAdmissionAuthority,
  TenantSpaceAdmissionError,
} from "../src/takoform/tenant-space-admission.ts";

const digest = (value: string) => `sha256:${value.repeat(64)}` as const;
const identity: FormAuthorityIdentity = {
  environment: "integration",
  hostId: "host-test",
  workerArtifactDigest: digest("a"),
  publicWorkerVersionId: "11111111-1111-4111-8111-111111111111",
  capabilityDigest: digest("b"),
  implementationDigest: digest("c"),
};

async function fixture() {
  const closure = await loadPublisherSetClosure();
  const selected = closure.packageSet[0];
  if (!selected) throw new Error("publisher closure is empty");
  const policy = {
    kind: "takoserver.space-form-admission-policy@v1",
    organizationId: "org-test",
    forms: [selected],
  } as const;
  const calls = { ownership: 0, compose: 0, plan: 0, apply: 0, readback: 0 };
  const requests: FormAuthorityPlanRequest[] = [];
  const tenants: unknown[] = [];
  const controls = {
    owner: (_call: number): readonly Row[] => [{ org_id: "org-test" }],
    result: (result: FormAuthorityApplyResult) => result,
    readback: (readback: FormAuthorityReadback) => readback,
    plan: (plan: FormAuthorityPlan) => plan,
  };
  const ready = (request: FormAuthorityPlanRequest): FormAuthorityReadback => ({
    kind: "takoserver.form-authority-readback@v2",
    identity,
    activation: request.activation,
    currentHeads: [],
    currentHeadDigest: digest("d"),
    forms: [
      {
        ...selected,
        operations: ["create", "read"],
        installed: true,
        supported: true,
        activationHead: {
          present: true,
          active: true,
          implementationDigest: identity.implementationDigest,
          eventDigest: digest("e"),
        },
      },
    ],
  });
  const endpoint: HostAdmissionCoordinator = {
    async plan(request) {
      calls.plan++;
      requests.push(structuredClone(request));
      return controls.plan({
        kind: "takoserver.form-authority-plan@v2",
        request,
        activationPolicy: policy,
        packages: [],
        currentHeads: [],
        currentHeadDigest: digest("d"),
        commands: [],
        planDigest: digest("f"),
      });
    },
    async apply(plan) {
      calls.apply++;
      return controls.result({
        kind: "takoserver.form-authority-apply@v2",
        status: "converged",
        planDigest: plan.planDigest,
        receipts: [],
        policyAuthority: "takoserver-host",
        verificationMode: "released-core",
        productionEligible: false,
        readback: ready(plan.request),
        nextPlan: plan,
        replanRequired: false,
      });
    },
    async readback(request) {
      calls.readback++;
      return controls.readback(ready(request));
    },
  };
  const authority = createTenantSpaceAdmissionAuthority({
    policy,
    sql: {
      async query(sql, parameters) {
        expect(sql).toContain("sponsorship_tenants");
        expect(sql).toContain("LIMIT 2");
        calls.ownership++;
        tenants.push(parameters?.[0]);
        return controls.owner(calls.ownership);
      },
    },
    async compose(received) {
      calls.compose++;
      expect(received).toEqual(policy);
      return { identity, evidence: closure.evidence, endpoint };
    },
  });
  return { authority, calls, controls, requests, tenants, selected };
}

describe("narrow managed tenant Space admission", () => {
  test("only the opaque tenant crosses the caller boundary", async () => {
    const { authority, calls } = await fixture();
    for (const value of [
      null,
      [],
      {},
      { tenantRef: "" },
      { tenantRef: "tenant/a" },
      { tenantRef: "tenant:a", space: "other" },
      { tenantRef: "tenant:a", organizationId: "org-other" },
      { tenantRef: "tenant:a", forms: [] },
      { tenantRef: "tenant:a", desiredActive: false },
    ]) {
      await expect(authority.ensureTenantSpaceAdmission(value)).rejects.toEqual(
        new TenantSpaceAdmissionError("invalid_input"),
      );
    }
    expect(calls.ownership).toBe(0);
    expect(calls.compose).toBe(0);
  });

  test("missing, foreign or ambiguous ownership never reaches Form authority", async () => {
    for (const rows of [
      [],
      [{ org_id: "org-other" }],
      [{ org_id: "org-test" }, { org_id: "org-test" }],
    ]) {
      const { authority, calls, controls } = await fixture();
      controls.owner = () => rows;
      await expect(authority.ensureTenantSpaceAdmission({ tenantRef: "tenant:a" })).rejects.toEqual(
        new TenantSpaceAdmissionError("tenant_not_owned"),
      );
      expect(calls.compose).toBe(0);
      expect(calls.apply).toBe(0);
    }
  });

  test("constructs a pinned positive-only request for each tenant and freshly reads readiness", async () => {
    const { authority, calls, requests, tenants } = await fixture();
    for (const tenantRef of ["tenant:a", "tenant:b"]) {
      const result = await authority.ensureTenantSpaceAdmission({ tenantRef });
      expect(result).toMatchObject({
        organizationId: "org-test",
        tenantRef,
        spaceRef: tenantRef,
        ready: true,
      });
      expect(result.policyDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }
    expect(requests.map((request) => request.activation)).toEqual([
      { kind: "space", tenantId: "org-test", space: "tenant:a", desiredActive: true },
      { kind: "space", tenantId: "org-test", space: "tenant:b", desiredActive: true },
    ]);
    expect(calls).toEqual({ ownership: 6, compose: 2, plan: 2, apply: 2, readback: 2 });
    expect(tenants).toEqual([
      "tenant:a",
      "tenant:a",
      "tenant:a",
      "tenant:b",
      "tenant:b",
      "tenant:b",
    ]);
  });

  test("partial application is not readiness and is not retried inside the invocation", async () => {
    const { authority, calls, controls } = await fixture();
    controls.result = (result) => ({ ...result, status: "partial", replanRequired: true });
    await expect(authority.ensureTenantSpaceAdmission({ tenantRef: "tenant:a" })).rejects.toEqual(
      new TenantSpaceAdmissionError("admission_not_ready"),
    );
    expect(calls.apply).toBe(1);
    expect(calls.plan).toBe(1);
    expect(calls.readback).toBe(0);
  });

  test("integration-fixture verification cannot satisfy the managed authority", async () => {
    const { authority, controls } = await fixture();
    controls.result = (result) => ({ ...result, verificationMode: "integration-fixture" });
    await expect(authority.ensureTenantSpaceAdmission({ tenantRef: "tenant:a" })).rejects.toEqual(
      new TenantSpaceAdmissionError("admission_not_ready"),
    );
  });

  test("a plan for another Space is refused before apply", async () => {
    const { authority, calls, controls } = await fixture();
    controls.plan = (plan) => ({
      ...plan,
      request: {
        ...plan.request,
        activation: { ...plan.request.activation, space: "tenant:other" },
      },
    });
    await expect(authority.ensureTenantSpaceAdmission({ tenantRef: "tenant:a" })).rejects.toEqual(
      new TenantSpaceAdmissionError("admission_not_ready"),
    );
    expect(calls.apply).toBe(0);
  });

  test("an unscoped composition cannot substitute the full operator authority", async () => {
    const { authority, calls, controls } = await fixture();
    controls.plan = (plan) => {
      const { activationPolicy: _policy, ...unscoped } = plan;
      return unscoped;
    };
    await expect(authority.ensureTenantSpaceAdmission({ tenantRef: "tenant:a" })).rejects.toEqual(
      new TenantSpaceAdmissionError("admission_not_ready"),
    );
    expect(calls.apply).toBe(0);
  });

  test("ownership is rechecked before mutation and before readiness", async () => {
    for (const conflictAt of [2, 3]) {
      const { authority, calls, controls } = await fixture();
      controls.owner = (call) => [{ org_id: call < conflictAt ? "org-test" : "org-other" }];
      await expect(authority.ensureTenantSpaceAdmission({ tenantRef: "tenant:a" })).rejects.toEqual(
        new TenantSpaceAdmissionError("tenant_not_owned"),
      );
      expect(calls.apply).toBe(conflictAt === 2 ? 0 : 1);
    }
  });

  test("fresh readback must prove exact selected package, active head and current implementation", async () => {
    const failures: ((value: FormAuthorityReadback) => FormAuthorityReadback)[] = [
      (value) => ({ ...value, identity: { ...identity, implementationDigest: digest("0") } }),
      (value) => ({ ...value, activation: { ...value.activation, space: "tenant:other" } }),
      (value) => ({ ...value, forms: [] }),
      (value) => ({ ...value, forms: [...value.forms, ...value.forms] }),
      ...["installed", "supported"].map((key) => (value: FormAuthorityReadback) => ({
        ...value,
        forms: value.forms.map((form) => ({ ...form, [key]: false })),
      })),
      (value) => ({
        ...value,
        forms: value.forms.map((form) => ({
          ...form,
          activationHead: { ...form.activationHead, active: false },
        })),
      }),
      (value) => ({
        ...value,
        forms: value.forms.map((form) => ({
          ...form,
          activationHead: { ...form.activationHead, implementationDigest: digest("0") },
        })),
      }),
      (value) => ({
        ...value,
        forms: value.forms.map((form) => ({ ...form, packageDigest: digest("0") })),
      }),
    ];
    for (const failure of failures) {
      const { authority, controls } = await fixture();
      controls.readback = failure;
      await expect(authority.ensureTenantSpaceAdmission({ tenantRef: "tenant:a" })).rejects.toEqual(
        new TenantSpaceAdmissionError("admission_not_ready"),
      );
    }
  });
});
