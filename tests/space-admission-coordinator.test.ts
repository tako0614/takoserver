import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { canonicalJson } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { FormAdmissionHost } from "../src/takoform/admission.ts";
import { createAdmissionHandleIssuer } from "../src/takoform/admission.ts";
import { createFormAdmissionStore } from "../src/takoform/admission-store.ts";
import { createIntegrationFixtureEvidenceVerifier } from "../src/takoform/form-authority-verification.ts";
import { createFormPackageStore } from "../src/takoform/form-packages.ts";
import {
  canonicalFormAuthorityPlanDigest,
  createHostAdmissionCoordinator,
  type FormAuthorityIdentity,
  type FormAuthorityPlanRequest,
} from "../src/takoform/host-admission-coordinator.ts";
import { takoformActivationAudience } from "../src/takoform/host-authority.ts";
import type { TakoformImplementationCatalog } from "../src/takoform/implementation-catalog.ts";
import { loadPublisherSetClosure } from "../src/takoform/publisher-set-closure.ts";

const digest = (value: string) => `sha256:${value.repeat(64)}` as const;
const PUBLIC_VERSION_ID = "00000000-0000-4000-8000-000000000021";

async function fixture(input: { readonly failActivation?: boolean } = {}) {
  const closure = await loadPublisherSetClosure();
  const packageSet = closure.packageSet.slice(0, 2);
  const firstPackage = packageSet[0];
  const secondPackage = packageSet[1];
  if (!firstPackage || !secondPackage) throw new Error("publisher closure fixture is too small");
  const entries = packageSet.map((entry, index) => ({
    formRef: entry.formRef,
    packageDigest: entry.packageDigest,
    operations: index === 0 ? (["create"] as const) : (["read"] as const),
  }));
  const catalog: TakoformImplementationCatalog = {
    kind: "takoserver.form-implementation-catalog@v1",
    capabilityDigest: digest("a"),
    implementationDigest: digest("b"),
    entries,
  };
  const identity: FormAuthorityIdentity = {
    environment: "integration",
    hostId: "host-space-admission-test",
    workerArtifactDigest: digest("c"),
    publicWorkerVersionId: PUBLIC_VERSION_ID,
    capabilityDigest: catalog.capabilityDigest,
    implementationDigest: catalog.implementationDigest,
  };
  const evidence = {
    ...structuredClone(closure.evidence),
    packageBundleDigests: closure.evidence.packageBundleDigests.filter((bundle) =>
      packageSet.some(
        (entry) =>
          entry.packageDigest === bundle.packageDigest &&
          canonicalJson(entry.formRef) === canonicalJson(bundle.formRef),
      ),
    ),
  };
  const verifier = createIntegrationFixtureEvidenceVerifier({ packages: packageSet });
  const objects = createMemoryObjectStore();
  const storedPackages = createFormPackageStore(objects);
  const handles = createAdmissionHandleIssuer();
  const durable = createFormAdmissionStore({
    sql: createEphemeralSql(),
    packages: storedPackages,
    handles,
  });
  let failActivation = input.failActivation ?? false;
  const admission: FormAdmissionHost = {
    inspect: (query) => durable.inspect(query),
    async execute(command) {
      if (failActivation && command.kind === "SetActivation" && command.active) {
        failActivation = false;
        throw new Error("test partial activation failure");
      }
      return await durable.execute(command);
    },
  };
  const source = {
    async load(input: {
      readonly formRef: (typeof packageSet)[number]["formRef"];
      readonly packageDigest: `sha256:${string}`;
    }) {
      return await closure.packages.load(input);
    },
  };
  const makeCoordinator = (
    policy?: unknown,
    host = admission,
    catalogOverride: TakoformImplementationCatalog = catalog,
  ) =>
    createHostAdmissionCoordinator({
      identity,
      catalog: catalogOverride,
      packageSet,
      ...(policy === undefined ? {} : { activationPolicy: policy as never }),
      packages: source,
      storedPackages,
      admission: host,
      handles,
      verifier,
      assertMutationAuthority: async () => {},
    });
  const request = (space: string, desiredActive = true): FormAuthorityPlanRequest => ({
    kind: "takoserver.form-authority-plan-request@v2",
    ...identity,
    activation: {
      kind: "space",
      tenantId: "org-space-test",
      space,
      desiredActive,
    },
    evidence,
    actor: "space-admission-test",
    reason: "test the pinned positive activation scope",
  });
  return {
    closure,
    packageSet,
    firstPackage,
    secondPackage,
    catalog,
    identity,
    evidence,
    storedPackages,
    durable,
    admission,
    makeCoordinator,
    request,
    policy: {
      kind: "takoserver.space-form-admission-policy@v1" as const,
      organizationId: "org-space-test",
      forms: [{ formRef: firstPackage.formRef, packageDigest: firstPackage.packageDigest }],
    },
    broadPolicy: {
      kind: "takoserver.space-form-admission-policy@v1" as const,
      organizationId: "org-space-test",
      forms: entries.map(({ formRef, packageDigest }) => ({ formRef, packageDigest })),
    },
  };
}

describe("space-scoped Host admission coordinator", () => {
  test("imports and verifies the full package set while activating only approved identities", async () => {
    const f = await fixture();
    const coordinator = f.makeCoordinator(f.policy);
    const selected = f.policy.forms[0];
    if (!selected) throw new Error("selected policy identity is missing");
    const plan = await coordinator.plan(f.request("space:new"));

    expect(plan.packages).toHaveLength(2);
    expect(plan.activationPolicy).toEqual(f.policy);
    expect(plan.commands.filter((command) => command.kind === "InstallPackage")).toHaveLength(2);
    expect(plan.commands.filter((command) => command.kind === "SetSupport")).toHaveLength(2);
    expect(plan.commands.filter((command) => command.kind === "SetActivation")).toEqual([
      expect.objectContaining({
        active: true,
        formRef: selected.formRef,
        packageDigest: selected.packageDigest,
      }),
    ]);

    const applied = await coordinator.apply(plan);
    expect(applied.status).toBe("converged");
    expect(applied.nextPlan.commands).toEqual([]);
    expect(applied.readback.forms).toHaveLength(2);
    expect(
      applied.readback.forms.find((form) => form.formRef.kind === f.firstPackage.formRef.kind),
    ).toMatchObject({ installed: true, supported: true, activationHead: { active: true } });
    expect(
      applied.readback.forms.find((form) => form.formRef.kind === f.secondPackage.formRef.kind),
    ).toMatchObject({ installed: true, supported: true, activationHead: { present: false } });
  });

  test("keeps an old Space activation head unchanged while admitting a second Space", async () => {
    const f = await fixture();
    const full = f.makeCoordinator();
    await full.apply(await full.plan(f.request("space:old")));
    const before = await f.durable.inspect({ kind: "History", chain: "activation", limit: 1_000 });
    const oldAudience = takoformActivationAudience("space", {
      tenantId: "org-space-test",
      space: "space:old",
    }).value;

    const scoped = f.makeCoordinator(f.policy);
    const applied = await scoped.apply(await scoped.plan(f.request("space:new")));
    expect(applied.status).toBe("converged");

    const after = await f.durable.inspect({ kind: "History", chain: "activation", limit: 1_000 });
    const oldBefore = (before.events ?? []).filter((row) => row.audience_value === oldAudience);
    const oldAfter = (after.events ?? []).filter((row) => row.audience_value === oldAudience);
    expect(oldAfter).toEqual(oldBefore);
  });

  test("fresh replan after partial apply contains only the approved remainder", async () => {
    const f = await fixture({ failActivation: true });
    const coordinator = f.makeCoordinator(f.policy);
    const selected = f.policy.forms[0];
    if (!selected) throw new Error("selected policy identity is missing");
    const first = await coordinator.plan(f.request("space:partial"));
    const partial = await coordinator.apply(first);
    expect(partial.status).toBe("partial");
    expect(partial.replanRequired).toBe(true);

    const fresh = await coordinator.plan(f.request("space:partial"));
    expect(fresh.commands).not.toHaveLength(0);
    expect(fresh.commands.filter((command) => command.kind === "SetActivation")).toEqual([
      expect.objectContaining({
        kind: "SetActivation",
        formRef: selected.formRef,
        packageDigest: selected.packageDigest,
        active: true,
      }),
    ]);
    expect(fresh.commands.filter((command) => command.kind === "SetActivation")).not.toContainEqual(
      expect.objectContaining({
        formRef: f.secondPackage.formRef,
        packageDigest: f.secondPackage.packageDigest,
        active: true,
      }),
    );
    expect(fresh.commands[0]).toBeDefined();
    expect(fresh.commands.find((command) => command.kind === "SetActivation")).toMatchObject({
      kind: "SetActivation",
      formRef: selected.formRef,
      packageDigest: selected.packageDigest,
      active: true,
    });
    expect((await coordinator.apply(fresh)).status).toBe("converged");
  });

  test("rejects malformed scope identities and policy-negative requests before mutation", async () => {
    const f = await fixture();
    const unknownPackage = f.closure.packageSet[2];
    if (!unknownPackage) throw new Error("publisher closure fixture has no unknown package");
    const selected = f.policy.forms[0];
    if (!selected) throw new Error("selected policy identity is missing");
    const firstEntry = f.catalog.entries[0];
    if (!firstEntry) throw new Error("implementation catalog fixture is empty");
    expect(() => f.makeCoordinator({ ...f.policy, forms: [] })).toThrow(/policy/i);
    expect(() =>
      f.makeCoordinator({
        ...f.policy,
        forms: [
          {
            formRef: unknownPackage.formRef,
            packageDigest: unknownPackage.packageDigest,
          },
        ],
      }),
    ).toThrow(/publisher package/i);
    expect(() =>
      f.makeCoordinator(
        {
          ...f.broadPolicy,
          forms: [f.broadPolicy.forms[1]],
        },
        f.admission,
        { ...f.catalog, entries: [firstEntry] },
      ),
    ).toThrow(/realized implementation/i);
    expect(() =>
      f.makeCoordinator({
        ...f.policy,
        forms: [{ formRef: selected.formRef, packageDigest: f.secondPackage.packageDigest }],
      }),
    ).toThrow(/publisher package/i);

    const coordinator = f.makeCoordinator(f.policy);
    await expect(
      coordinator.plan({
        ...f.request("space:negative", false),
        activation: { ...f.request("space:negative", false).activation, tenantId: "other-org" },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(coordinator.plan(f.request("space:negative", false))).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  test("binds a broader plan to its policy even when its digest is recomputed", async () => {
    const f = await fixture();
    const broad = f.makeCoordinator(f.broadPolicy);
    const narrow = f.makeCoordinator(f.policy);
    const broadPlan = await broad.plan(f.request("space:bound"));
    const { planDigest: _ignored, ...unsigned } = broadPlan;
    const recomputed = {
      ...broadPlan,
      planDigest: await canonicalFormAuthorityPlanDigest(unsigned),
    };

    await expect(narrow.apply(recomputed)).rejects.toMatchObject({
      code: "plan_digest_mismatch",
    });
    expect(await f.storedPackages.read({ packageDigest: f.firstPackage.packageDigest })).toBeNull();
  });
});
