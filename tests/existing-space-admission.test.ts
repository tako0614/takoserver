import { describe, expect, test } from "bun:test";
import { takoformCoreVerifierArtifactDigest } from "../scripts/deploy/form-authority.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { canonicalJson } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createAdmissionHandleIssuer } from "../src/takoform/admission.ts";
import { createFormAdmissionStore } from "../src/takoform/admission-store.ts";
import { createExistingSpaceAdmissionAuthority } from "../src/takoform/existing-space-admission.ts";
import { createReleasedCoreFormAuthorityEvidenceVerifier } from "../src/takoform/form-authority-verification.ts";
import { createFormPackageStore } from "../src/takoform/form-packages.ts";
import {
  createHostAdmissionCoordinator,
  type FormAuthorityIdentity,
  type FormAuthorityPlanRequest,
} from "../src/takoform/host-admission-coordinator.ts";
import { loadPublisherSetClosure } from "../src/takoform/publisher-set-closure.ts";
import {
  type SpaceAdmissionPolicyV1,
  spaceAdmissionPolicyDigest,
} from "../src/takoform/space-admission-policy.ts";
import { createSyntheticPublisherSetVerifier } from "./helpers/synthetic-publisher-set-verifier.ts";

const digest = (letter: string) => `sha256:${letter.repeat(64)}` as const;

async function fixture() {
  const closure = await loadPublisherSetClosure();
  const selected = closure.packageSet.slice(0, 2);
  const first = selected[0];
  if (selected.length !== 2 || !first) throw new Error("fixture needs two packages");
  const policy: SpaceAdmissionPolicyV1 = {
    kind: "takoserver.space-form-admission-policy@v1",
    organizationId: "org-update",
    forms: [first],
  };
  const identity: { -readonly [K in keyof FormAuthorityIdentity]: FormAuthorityIdentity[K] } = {
    environment: "integration",
    hostId: "host-update",
    workerArtifactDigest: digest("a"),
    publicWorkerVersionId: "00000000-0000-4000-8000-000000000001",
    capabilityDigest: digest("b"),
    implementationDigest: digest("c"),
  };
  const storedPackages = createFormPackageStore(createMemoryObjectStore());
  const handles = createAdmissionHandleIssuer();
  const durable = createFormAdmissionStore({
    sql: createEphemeralSql(),
    packages: storedPackages,
    handles,
  });
  // Real package bytes, coordinator and durable store; only the external Core
  // response is synthetic. This is not live signature/authenticity proof.
  const synthetic = createSyntheticPublisherSetVerifier();
  const verifier = createReleasedCoreFormAuthorityEvidenceVerifier({
    artifactDigest: takoformCoreVerifierArtifactDigest(),
    containerName: "test-existing-space",
    containers: {
      idFromName: (name) => ({ toString: () => name, equals: () => true }),
      get: () => ({ fetch: (input, init) => synthetic.fetch(input, init) }),
    },
  });
  let failSpace: string | undefined;
  const make = (activationPolicy?: SpaceAdmissionPolicyV1) =>
    createHostAdmissionCoordinator({
      identity: { ...identity },
      catalog: {
        kind: "takoserver.form-implementation-catalog@v1",
        capabilityDigest: identity.capabilityDigest,
        implementationDigest: identity.implementationDigest,
        entries: selected.map((entry) => ({ ...entry, operations: ["create"] as const })),
      },
      packageSet: closure.packageSet,
      ...(activationPolicy ? { activationPolicy } : {}),
      packages: closure.packages,
      storedPackages,
      handles,
      verifier,
      admission: {
        inspect: (query) => durable.inspect(query),
        async execute(command) {
          if (
            command.kind === "SetActivation" &&
            failSpace &&
            command.audience.value.includes(failSpace)
          ) {
            throw new Error("injected durable activation failure");
          }
          return await durable.execute(command);
        },
      },
      assertMutationAuthority: async () => {},
    });
  const request = (
    space: string,
    desiredActive = true,
    tenantId = policy.organizationId,
  ): FormAuthorityPlanRequest => ({
    ...identity,
    kind: "takoserver.form-authority-plan-request@v2",
    activation: { kind: "space", tenantId, space, desiredActive },
    evidence: closure.evidence,
    actor: "test-operator",
    reason: "test software update convergence",
  });
  const apply = async (space: string, active = true, tenantId = policy.organizationId) => {
    const endpoint = make();
    return await endpoint.apply(await endpoint.plan(request(space, active, tenantId)));
  };
  const controls = {
    beforePlan: async (_space: string) => {},
    beforeApply: async (_space: string) => {},
    afterApply: async (_space: string) => {},
    applyCount: 0,
    composePolicy: (value: SpaceAdmissionPolicyV1) => value,
  };
  const authority = createExistingSpaceAdmissionAuthority({
    policy,
    async compose(selectedPolicy) {
      const endpoint = make(controls.composePolicy(selectedPolicy));
      return {
        identity: { ...identity },
        evidence: closure.evidence,
        endpoint: {
          async plan(input) {
            await controls.beforePlan(input.activation.space);
            return await endpoint.plan(input);
          },
          async apply(plan) {
            controls.applyCount++;
            await controls.beforeApply(plan.request.activation.space);
            const result = await endpoint.apply(plan);
            await controls.afterApply(plan.request.activation.space);
            return result;
          },
          readback: (input) => endpoint.readback(input),
        },
      };
    },
  });
  const read = (space: string, tenantId = policy.organizationId) =>
    make().readback(request(space, true, tenantId));
  const history = async () =>
    (await durable.inspect({ kind: "History", chain: "activation", limit: 1_000 })).events;
  return {
    policy,
    identity,
    controls,
    make,
    request,
    apply,
    read,
    history,
    synthetic,
    fail: (space: string | undefined) => {
      failSpace = space;
    },
    rotate: () => {
      identity.implementationDigest = digest("d");
    },
    run: async (spaces: string[]) =>
      authority.reconcileExistingSpaces({
        policyDigest: await spaceAdmissionPolicyDigest(policy),
        spaces,
      }),
    raw: (input: unknown) => authority.reconcileExistingSpaces(input),
  };
}

describe("operator existing-Space software update convergence", () => {
  test("two retained Spaces converge across I rotation while all other heads remain intact; repeat is a noop", async () => {
    const f = await fixture();
    for (const space of ["space-a", "space-b", "inactive", "unselected"]) await f.apply(space);
    await f.apply("inactive", false);
    await f.apply("space-a", true, "org-other");
    const before = await f.history();
    f.rotate();
    expect(
      (await f.read("space-a")).forms.find((form) => form.activationHead.active)?.supported,
    ).toBe(false);
    const result = await f.run(["space-a", "space-b", "inactive", "absent"]);
    expect(result.spaces.map((space) => space.forms.length)).toEqual([1, 1, 0, 0]);
    expect(
      result.spaces
        .slice(0, 2)
        .every(
          (space) =>
            space.forms[0]?.activationHead.implementationDigest === f.identity.implementationDigest,
        ),
    ).toBe(true);
    const after = await f.history();
    expect(after).toHaveLength((before?.length ?? 0) + 2);
    for (const row of before ?? []) expect(after).toContainEqual(row);
    for (const space of ["space-a", "space-b"]) {
      const head = result.spaces.find((item) => item.space === space)?.forms[0]?.activationHead
        .eventDigest;
      const successor = after?.find((event) => event.event_digest === head);
      expect(before?.some((event) => event.event_digest === successor?.predecessor_digest)).toBe(
        true,
      );
    }
    expect(await f.run(["space-a", "space-b", "inactive", "absent"])).toEqual(result);
    expect(await f.history()).toEqual(after);
    expect(f.synthetic.calls.filter((path) => path === "/v1/verify-set").length).toBeGreaterThan(0);
  }, 60_000);

  test("policy mismatch and malformed or broadened selection refuse before any apply", async () => {
    const f = await fixture();
    const policyDigest = await spaceAdmissionPolicyDigest(f.policy);
    for (const input of [
      null,
      {},
      { policyDigest, spaces: [] },
      { policyDigest, spaces: ["a", "a"] },
      { policyDigest, spaces: ["bad/space"] },
      { policyDigest, spaces: ["a"], organizationId: "other" },
    ]) {
      await expect(f.raw(input)).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(f.raw({ policyDigest: digest("0"), spaces: ["space-a"] })).rejects.toMatchObject({
      code: "policy_mismatch",
    });
    expect(f.controls.applyCount).toBe(0);
    expect(await f.history()).toEqual([]);
  });

  test("a changed composition policy or organization cannot substitute for the pinned owner", async () => {
    const f = await fixture();
    await f.apply("space-a");
    f.rotate();
    const before = await f.history();
    f.controls.composePolicy = (policy) => ({ ...policy, organizationId: "org-other" });
    await expect(f.run(["space-a"])).rejects.toMatchObject({ code: "invalid_request" });
    expect(await f.history()).toEqual(before);
  });

  test("a deactivation between captured positive head and fresh plan is never resurrected", async () => {
    const f = await fixture();
    await f.apply("space-a");
    f.rotate();
    f.controls.beforePlan = async () => {
      await f.apply("space-a", false);
    };
    await expect(f.run(["space-a"])).rejects.toMatchObject({ code: "admission_not_ready" });
    expect(f.controls.applyCount).toBe(0);
    expect((await f.read("space-a")).forms.every((form) => !form.activationHead.active)).toBe(true);
  });

  test("a deactivation after planning is refused by the coordinator predecessor fence", async () => {
    const f = await fixture();
    await f.apply("space-a");
    f.rotate();
    f.controls.beforeApply = async () => {
      await f.apply("space-a", false);
    };
    await expect(f.run(["space-a"])).rejects.toMatchObject({ code: "head_drift" });
    expect((await f.read("space-a")).forms.every((form) => !form.activationHead.active)).toBe(true);
  });

  test("a same-organization broader Form policy cannot replace the captured selection", async () => {
    const f = await fixture();
    await f.apply("space-a");
    f.rotate();
    const before = await f.history();
    const forms = (await f.read("space-a")).forms
      .filter((form) => form.activationHead.active)
      .map(({ formRef, packageDigest }) => ({ formRef, packageDigest }));
    f.controls.composePolicy = (policy) => ({ ...policy, forms });
    await expect(f.run(["space-a"])).rejects.toMatchObject({ code: "admission_not_ready" });
    expect(f.controls.applyCount).toBe(0);
    expect(await f.history()).toEqual(before);
  });

  test("partial failure leaves earlier durable progress but never returns batch success; explicit fresh invocation converges", async () => {
    const f = await fixture();
    await f.apply("space-a");
    await f.apply("space-b");
    f.rotate();
    f.fail("space-b");
    await expect(f.run(["space-a", "space-b"])).rejects.toMatchObject({
      code: "admission_not_ready",
    });
    expect(f.controls.applyCount).toBe(2);
    const first = (await f.read("space-a")).forms.find(
      (form) => canonicalJson(form.formRef) === canonicalJson(f.policy.forms[0]?.formRef),
    );
    expect(first?.activationHead.implementationDigest).toBe(f.identity.implementationDigest);
    f.fail(undefined);
    const result = await f.run(["space-a", "space-b"]);
    expect(result.spaces[0]?.forms[0]?.activationHead).toEqual(first?.activationHead);
    expect(result.spaces[1]?.forms[0]?.activationHead.implementationDigest).toBe(
      f.identity.implementationDigest,
    );
  }, 60_000);

  test("final batch readback detects an earlier Space revoked while a later Space was applying", async () => {
    const f = await fixture();
    await f.apply("space-a");
    await f.apply("space-b");
    f.rotate();
    f.controls.afterApply = async (space) => {
      if (space === "space-b") await f.apply("space-a", false);
    };
    await expect(f.run(["space-a", "space-b"])).rejects.toMatchObject({
      code: "admission_not_ready",
    });
    expect((await f.read("space-a")).forms.every((form) => !form.activationHead.active)).toBe(true);
  }, 60_000);
});
