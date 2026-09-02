import { describe, expect, test } from "bun:test";
import { buildEdgeForms, edgeProviderOffering } from "../src/edge-forms.ts";
import {
  buildApp,
  createCatalog,
  createEphemeralSql,
  createLedger,
  createMemoryObjectStore,
  createResourceDeploymentStore,
  type ExternalIdentityVerifier,
  type FundingSettlementVerifier,
  type InstalledTakoformForm,
  type Offering,
} from "../src/index.ts";
import { type Sql, SqlError } from "../src/ports.ts";
import { createProviderDriver, ProviderMutationRecoveryError } from "../src/provider-driver.ts";
import { failed, type Provider, type ProviderOffering, succeeded } from "../src/provider-port.ts";
import { createFakeProviderState, FakeProvider } from "../src/providers/fake.ts";
import { createTakoformStore } from "../src/takoform/store.ts";
import { createStaticStableTestTakoformHost } from "./helpers/historical-takoform-host.ts";

const fakeReadback = {
  createNativeReadbackDescriptor(input: {
    readonly offering: ProviderOffering;
    readonly nativeId: string;
    readonly identity: {
      readonly tenantRef: string;
      readonly space: string;
      readonly name: string;
    };
  }) {
    return {
      apiVersion: "providers.takoserver.com/readback/v1" as const,
      provider: "fake",
      kind: input.offering.kind,
      nativeId: input.nativeId,
      data: {
        tenantRef: input.identity.tenantRef,
        space: input.identity.space,
        name: input.identity.name,
      },
    };
  },
  async verifyNativeAbsence() {
    return { outcome: "absent" as const, evidence: {} };
  },
};

/**
 * The join the old design was missing: declaring a resource through Takoform
 * provisions it on a backend *and* moves money, in that order, settling once.
 */

const FORM_REF = {
  apiVersion: "edge.forms.takoform.com",
  kind: "ObjectBucket",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:3383a60c12bdc5a853868bd7ccab3670e1aff7b3eca889583b86d11ac0f90494",
} as const;

const FORM: InstalledTakoformForm = {
  identity: { formRef: FORM_REF },
  desiredSchema: {
    type: "object",
    properties: { location: { type: "string" } },
    additionalProperties: false,
  },
  observedSchema: { type: "object", additionalProperties: true },
  operations: ["create", "read", "update", "delete", "observe"],
};

const PROVIDER_OFFERING: ProviderOffering = {
  id: "storage.object.standard",
  kind: "object_bucket",
  displayName: "Object bucket",
  form: FORM_REF,
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["create", "update", "delete", "observe"],
};

const RETAINED_FORM_REF = {
  ...FORM_REF,
  apiVersion: "edge.forms.takoform.com/v1beta1",
  definitionVersion: "0.2.0",
  schemaDigest: `sha256:${"1".repeat(64)}`,
} as const;

const RETAINED_FORM: InstalledTakoformForm = {
  ...FORM,
  identity: { formRef: RETAINED_FORM_REF },
};

const RETAINED_PROVIDER_OFFERING: ProviderOffering = {
  ...PROVIDER_OFFERING,
  form: RETAINED_FORM_REF,
};

const SOLD: Offering = {
  id: PROVIDER_OFFERING.id,
  providerPackRef: "fake",
  providerInstallationRef: "fake.primary",
  supplyContractRef: "fake.test-contract",
  pricePlanRef: "storage.object.standard.price-v1",
  resourceClass: "storage.object",
  deliveryMode: "managed-endpoint",
  supportPolicyRef: "support:test",
  abusePolicyRef: "abuse:test",
  kind: PROVIDER_OFFERING.kind,
  displayName: PROVIDER_OFFERING.displayName,
  form: FORM_REF,
  pricePlan: {
    id: "storage.object.standard.price-v1",
    currency: "USD",
    provisioning: { meter: "resource.create", amountMinor: 500 },
    meters: [],
  },
  providedInterfaces: [],
  bindingRefs: [],
  regions: ["test"],
  portability: {
    api: "portable",
    exportFormats: [],
    importFormats: [],
    migrationModes: ["offline"],
  },
  isolation: "dedicated-resource",
  available: true,
};

const identity: ExternalIdentityVerifier = {
  async verify() {
    return { providerSubject: "subject", email: "owner@example.com", displayName: "Owner" };
  },
};

const settlement: FundingSettlementVerifier = {
  async verify() {
    return { fundingRef: "settlement_1", amountMinor: 2_000, currency: "USD" };
  },
};

function newApp(options: { failOn?: readonly string[]; usageOnly?: boolean } = {}) {
  const sql = createEphemeralSql();
  const provider = new FakeProvider({
    offerings: [PROVIDER_OFFERING],
    ...(options.failOn ? { failOn: options.failOn } : {}),
  });
  const app = buildApp({
    sql,
    objects: createMemoryObjectStore(),
    identity,
    settlement,
    publicOrigin: "https://api.takoserver.com",
    forms: [FORM],
    hostForms: [FORM],
    takoformHostFactory: createStaticStableTestTakoformHost,
    providers: [provider],
    offerings: [
      options.usageOnly
        ? {
            ...SOLD,
            pricePlan: {
              ...SOLD.pricePlan,
              provisioning: { meter: "resource.create", amountMinor: 0 },
              meters: [{ meter: "storage.gib-hour", amountMinor: 1, quantity: 1_000 }],
            },
          }
        : SOLD,
    ],
  });
  return { app, provider, ledger: createLedger(sql, () => new Date()), sql };
}

async function call(
  fetch: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(
    new Request(`https://api.takoserver.com${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

/** Signs in, creates an organization, funds it, and mints a provider key. */
async function tenant(fetch: (request: Request) => Promise<Response>) {
  const session = await call(fetch, "POST", "/v1/sessions", {
    provider: "google",
    assertion: "verified",
  });
  const owner = { authorization: `Bearer ${String(session.body.sessionToken)}` };
  const organization = await call(fetch, "POST", "/v1/organizations", { name: "Acme" }, owner);
  const organizationId = String((organization.body.organization as { id: string }).id);
  await call(
    fetch,
    "POST",
    `/v1/organizations/${organizationId}/wallet/funding`,
    { settlementProof: "proof-1" },
    owner,
  );
  const key = await call(
    fetch,
    "POST",
    `/v1/organizations/${organizationId}/api-keys`,
    { name: "takoform", scopes: ["resources:write"], expiresInSeconds: 3_600 },
    owner,
  );
  return {
    organizationId,
    owner,
    provider: { authorization: `Bearer ${String(key.body.secret)}` },
  };
}

const LANE = "/apis/forms.takoform.com/v1";
const QUERY =
  `space=default&definitionVersion=${FORM_REF.definitionVersion}` +
  `&schemaDigest=${encodeURIComponent(FORM_REF.schemaDigest)}`;

async function applyBucket(
  fetch: (request: Request) => Promise<Response>,
  auth: Record<string, string>,
  name: string,
  spec: Record<string, unknown>,
  idempotencyKey: string,
) {
  const resource = {
    apiVersion: FORM_REF.apiVersion,
    kind: FORM_REF.kind,
    form: { formRef: FORM_REF },
    metadata: { name, space: "default" },
    spec,
  };
  const prepared = await call(fetch, "POST", `${LANE}/resources/prepare`, resource, auth);
  const review = prepared.body.review as { prepareDigest: string } | undefined;
  if (!review) throw new Error(`prepare failed: ${JSON.stringify(prepared)}`);
  const path = `${LANE}/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/${name}?${QUERY}`;
  const body = { ...resource, review: { prepareDigest: review.prepareDigest } };
  const headers = { ...auth, "idempotency-key": idempotencyKey, "if-none-match": "*" };
  const response = await call(fetch, "PUT", path, body, headers);
  // The replay is the identical request, not a fresh review: a reviewed
  // prepare belongs to the state it was taken against.
  return { ...response, replay: () => call(fetch, "PUT", path, body, headers) };
}

describe("Takoform apply on a real backend", () => {
  test("keeps a priced hold while an async provider runs, then captures after restart", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-08-24T00:00:00.000Z");
    const ledger = createLedger(sql, clock);
    await ledger.fund({ organizationId: "org_priced", fundingRef: "paid", amountMinor: 2_000 });
    const state = createFakeProviderState();
    const provider = new FakeProvider({
      offerings: [PROVIDER_OFFERING],
      mode: "async",
      pollsToSettle: 2,
      state,
    });
    const input = {
      operationId: "op_priced_running",
      operationKey: "key_priced_running",
      tenantId: "org_priced",
      resourceUid: "uid_priced",
      form: FORM,
      name: "slow",
      space: "default",
      spec: { location: "apac" },
      relations: [],
    } as const;
    const makeDriver = () =>
      createProviderDriver({
        providers: [provider],
        catalog: createCatalog([SOLD]),
        ledger,
        deployments: createResourceDeploymentStore(sql, clock),
        inlinePollBudget: 1,
        sleep: async () => {},
      });

    let firstError: unknown;
    try {
      await makeDriver().apply(input);
    } catch (error) {
      firstError = error;
    }
    expect(firstError).toBeInstanceOf(ProviderMutationRecoveryError);
    if (!(firstError instanceof ProviderMutationRecoveryError)) {
      throw new Error("expected a provider recovery outcome");
    }
    expect(firstError.providerOutcome).toBe("running");
    const providerHandle = firstError.providerHandle;
    expect(providerHandle).toBe("handle_op_priced_running");
    if (!providerHandle) throw new Error("expected a provider recovery handle");
    expect(await ledger.wallet("org_priced")).toMatchObject({
      settledMinor: 2_000,
      heldMinor: 500,
      availableMinor: 1_500,
    });
    expect(provider.sideEffectCount).toBe(1);

    const restarted = makeDriver();
    const settled = await restarted.apply({
      ...input,
      operationMode: "recovery",
      providerHandle,
    });
    expect(settled.observed).toEqual({ location: "apac" });
    expect(provider.sideEffectCount).toBe(1);
    expect(await ledger.wallet("org_priced")).toMatchObject({
      settledMinor: 1_500,
      heldMinor: 0,
      availableMinor: 1_500,
    });
  });

  test("persists an initial running handle before any inline poll can fail", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-08-24T00:00:00.000Z");
    const ledger = createLedger(sql, clock);
    await ledger.fund({ organizationId: "org_poll_lost", fundingRef: "paid", amountMinor: 2_000 });
    const state = createFakeProviderState();
    const fake = new FakeProvider({
      offerings: [PROVIDER_OFFERING],
      mode: "async",
      pollsToSettle: 2,
      state,
    });
    let pollCalls = 0;
    let failNextPoll = true;
    const provider: Provider = {
      id: fake.id,
      offerings: fake.offerings,
      ...fakeReadback,
      apply: (input) => fake.apply(input),
      observe: (input) => fake.observe(input),
      delete: (input) => fake.delete(input),
      poll: async (input) => {
        pollCalls += 1;
        if (failNextPoll) {
          failNextPoll = false;
          throw new Error("poll transport closed");
        }
        return await fake.poll(input);
      },
    };
    const makeDriver = () =>
      createProviderDriver({
        providers: [provider],
        catalog: createCatalog([SOLD]),
        ledger,
        deployments: createResourceDeploymentStore(sql, clock),
        inlinePollBudget: 3,
        sleep: async () => {},
      });
    const input = {
      operationId: "op_poll_lost",
      operationKey: "key_poll_lost",
      tenantId: "org_poll_lost",
      resourceUid: "uid_poll_lost",
      form: FORM,
      name: "poll-lost",
      space: "default",
      spec: { location: "apac" },
      relations: [],
    } as const;

    await expect(makeDriver().apply(input)).rejects.toMatchObject({
      providerOutcome: "running",
      providerHandle: "handle_op_poll_lost",
    });
    // The handle must be returned before the first fallible poll. A restarted
    // executor can then carry it back through the recovery-only path.
    expect(pollCalls).toBe(0);
    failNextPoll = false;
    const recovered = await makeDriver().apply({
      ...input,
      operationMode: "recovery",
      providerHandle: "handle_op_poll_lost",
    });
    expect(recovered.observed).toEqual({ location: "apac" });
    expect(pollCalls).toBe(2);
    expect(fake.sideEffectCount).toBe(1);
  });

  test("keeps a priced hold when an indeterminate provider result has no handle", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-08-24T00:00:00.000Z");
    const ledger = createLedger(sql, clock);
    await ledger.fund({
      organizationId: "org_indeterminate",
      fundingRef: "paid",
      amountMinor: 2_000,
    });
    let attempts = 0;
    const provider: Provider = {
      id: "fake",
      offerings: [PROVIDER_OFFERING],
      ...fakeReadback,
      async apply(input) {
        attempts += 1;
        if (attempts === 1) return failed("timeout", "the acknowledgement was lost", true);
        return succeeded({
          nativeId: `fake:${input.identity.tenantRef}/${input.identity.space}/${input.identity.name}`,
          observed: structuredClone(input.spec),
          outputs: {},
        });
      },
      async observe() {
        return failed("not_found", "not found");
      },
      async delete() {
        return failed("not_found", "not found");
      },
    };
    const makeDriver = () =>
      createProviderDriver({
        providers: [provider],
        catalog: createCatalog([SOLD]),
        ledger,
        deployments: createResourceDeploymentStore(sql, clock),
      });
    const input = {
      operationId: "op_priced_indeterminate",
      operationKey: "key_priced_indeterminate",
      tenantId: "org_indeterminate",
      resourceUid: "uid_indeterminate",
      form: FORM,
      name: "uncertain",
      space: "default",
      spec: {},
      relations: [],
    } as const;

    await expect(makeDriver().apply(input)).rejects.toMatchObject({
      providerOutcome: "indeterminate",
    });
    expect(await ledger.wallet("org_indeterminate")).toMatchObject({
      settledMinor: 2_000,
      heldMinor: 500,
      availableMinor: 1_500,
    });
    await expect(makeDriver().apply({ ...input, operationMode: "recovery" })).rejects.toMatchObject(
      {
        providerOutcome: "indeterminate",
      },
    );
    expect(attempts).toBe(1);
    expect(await ledger.wallet("org_indeterminate")).toMatchObject({
      settledMinor: 2_000,
      heldMinor: 500,
      availableMinor: 1_500,
    });
  });

  test("converges a handle-less apply only through the provider's mutating resume seam", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-08-24T00:00:00.000Z");
    const ledger = createLedger(sql, clock);
    await ledger.fund({
      organizationId: "org_recover_apply",
      fundingRef: "paid",
      amountMinor: 2_000,
    });
    let applyCalls = 0;
    let readOnlyRecoverCalls = 0;
    let convergeCalls = 0;
    const provider: Provider = {
      id: "fake",
      offerings: [PROVIDER_OFFERING],
      ...fakeReadback,
      async apply() {
        applyCalls += 1;
        return failed("timeout", "the acknowledgement was lost", true);
      },
      async recoverApply(input) {
        readOnlyRecoverCalls += 1;
        return succeeded({
          nativeId: `recoverable:${input.identity.tenantRef}/${input.identity.space}/${input.identity.name}`,
          observed: structuredClone(input.spec),
          outputs: {},
        });
      },
      async convergeApply(input) {
        convergeCalls += 1;
        return succeeded({
          nativeId: `recoverable:${input.identity.tenantRef}/${input.identity.space}/${input.identity.name}`,
          observed: structuredClone(input.spec),
          outputs: {},
        });
      },
      async observe() {
        return failed("not_found", "not found");
      },
      async delete() {
        return failed("not_found", "not found");
      },
    };
    const makeDriver = () =>
      createProviderDriver({
        providers: [provider],
        catalog: createCatalog([SOLD]),
        ledger,
        deployments: createResourceDeploymentStore(sql, clock),
      });
    const input = {
      operationId: "op_recover_apply",
      operationKey: "key_recover_apply",
      tenantId: "org_recover_apply",
      resourceUid: "uid_recover_apply",
      form: FORM,
      name: "recoverable",
      space: "default",
      spec: { location: "apac" },
      relations: [],
    } as const;
    await expect(makeDriver().apply(input)).rejects.toMatchObject({
      providerOutcome: "indeterminate",
    });
    const recovered = await makeDriver().apply({ ...input, operationMode: "recovery" });
    expect(recovered.observed).toEqual(input.spec);
    expect(applyCalls).toBe(1);
    expect(readOnlyRecoverCalls).toBe(0);
    expect(convergeCalls).toBe(1);
    expect(await ledger.wallet("org_recover_apply")).toMatchObject({
      settledMinor: 1_500,
      heldMinor: 0,
    });
  });

  test("the app tick automatically drains a dispatched no-receipt provider command", async () => {
    const sql = createEphemeralSql();
    let applyCalls = 0;
    let convergeCalls = 0;
    const provider: Provider = {
      id: "fake",
      offerings: [PROVIDER_OFFERING],
      ...fakeReadback,
      async apply() {
        applyCalls += 1;
        return failed("unavailable", "provider acknowledgement was lost", true);
      },
      async convergeApply(input) {
        convergeCalls += 1;
        return succeeded({
          nativeId: `recovered:${input.identity.tenantRef}/${input.identity.name}`,
          observed: structuredClone(input.spec),
          outputs: {},
        });
      },
      async observe(input) {
        return succeeded({ nativeId: input.nativeId, observed: input.spec, outputs: {} });
      },
      async delete(input) {
        return succeeded({ nativeId: input.nativeId, observed: {}, outputs: {} });
      },
    };
    const app = buildApp({
      sql,
      objects: createMemoryObjectStore(),
      identity,
      settlement,
      publicOrigin: "https://api.takoserver.com",
      forms: [FORM],
      hostForms: [FORM],
      takoformHostFactory: createStaticStableTestTakoformHost,
      providers: [provider],
      offerings: [SOLD],
    });
    const { provider: auth } = await tenant(app.fetch);
    const initial = await applyBucket(app.fetch, auth, "tick-repair", {}, "tick-repair-0001");
    expect(initial.status).toBe(503);
    expect(applyCalls).toBe(1);
    expect(convergeCalls).toBe(0);

    expect((await app.tick()).providerRepairs).toEqual({
      candidates: 1,
      acquired: 1,
      settled: 1,
      pending: 0,
    });
    expect(convergeCalls).toBe(1);
    expect(await initial.replay()).toMatchObject({ status: 201 });
    expect((await app.tick()).providerRepairs).toEqual({
      candidates: 0,
      acquired: 0,
      settled: 0,
      pending: 0,
    });
    expect(applyCalls).toBe(1);
    expect(convergeCalls).toBe(1);
  });

  test("inherits one exact provider installation for a revision Form", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-08-19T00:00:00.000Z");
    const deployments = createResourceDeploymentStore(sql, clock);
    const bundle = await buildEdgeForms();
    const worker = bundle.forms.find(
      (candidate) => candidate.identity.formRef.kind === "ModuleWorker",
    );
    const version = bundle.forms.find(
      (candidate) => candidate.identity.formRef.kind === "WorkerVersion",
    );
    if (!worker || !version) throw new Error("released edge Forms missing");
    const versionOffering = edgeProviderOffering(version, {
      id: "cloudflare.worker-version",
    });
    const provider = new FakeProvider({ offerings: [versionOffering] });
    const driver = createProviderDriver({
      providers: [provider],
      catalog: createCatalog([]),
      ledger: createLedger(sql, clock),
      deployments,
    });
    await deployments.create({
      tenantId: "org_inherited",
      id: "dep_worker",
      resourceUid: "uid_worker",
      offeringId: "cloudflare.module-worker",
      providerPackRef: "fake",
      providerInstallationRef: "cloudflare.primary",
      nativeId: "worker:script-name",
      state: "active",
      observed: { allocated: true },
      outputs: { scriptName: "script-name" },
    });
    const result = await driver.apply({
      operationId: "op_version",
      operationKey: "key_version",
      tenantId: "org_inherited",
      resourceUid: "uid_version",
      form: version,
      name: "v1",
      space: "default",
      spec: {},
      relations: [
        {
          pointer: "/worker",
          relation: "/worker",
          targetUid: "uid_worker",
          resource: {
            apiVersion: worker.identity.formRef.apiVersion,
            kind: worker.identity.formRef.kind,
            form: worker.identity,
            metadata: {
              name: "api",
              space: "default",
              uid: "uid_worker",
              generation: "1",
              revision: "1",
            },
            spec: {},
            status: { observedGeneration: "1", conditions: [] },
          },
        },
      ],
    });
    expect(result.observed).toEqual({});
    expect(await deployments.active("org_inherited", "uid_version")).toMatchObject({
      offeringId: "cloudflare.worker-version",
      providerPackRef: "fake",
      providerInstallationRef: "cloudflare.primary",
    });
    expect(await createLedger(sql, clock).wallet("org_inherited")).toMatchObject({
      settledMinor: 0,
      heldMinor: 0,
    });
  });

  test("admits runtime inputs only for the exact inherited provider capability", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-08-24T00:00:00.000Z");
    const deployments = createResourceDeploymentStore(sql, clock);
    const bundle = await buildEdgeForms();
    const worker = bundle.forms.find(
      (candidate) => candidate.identity.formRef.kind === "ModuleWorker",
    );
    const version = bundle.forms.find(
      (candidate) => candidate.identity.formRef.kind === "WorkerVersion",
    );
    if (!worker || !version) throw new Error("released edge Forms missing");
    const versionOffering = edgeProviderOffering(version, {
      id: "cloudflare.worker-version",
    });
    const capable = Object.assign(
      new FakeProvider({ id: "capable", offerings: [versionOffering] }),
      { runtimeInputCapabilities: { maximumBindings: 64 } },
    );
    const incapable = new FakeProvider({ id: "incapable", offerings: [versionOffering] });
    const driver = createProviderDriver({
      providers: [capable, incapable],
      catalog: createCatalog([]),
      ledger: createLedger(sql, clock),
      deployments,
    });
    const tenantId = "org_runtime_inputs";
    const workerResource = (uid: string, name: string) => ({
      apiVersion: worker.identity.formRef.apiVersion,
      kind: worker.identity.formRef.kind,
      form: worker.identity,
      metadata: {
        name,
        space: "default",
        uid,
        generation: "1",
        revision: "1",
      },
      spec: {},
      status: { observedGeneration: "1", conditions: [] },
    });
    const relation = (uid: string, name: string) => ({
      pointer: "/worker",
      relation: "/worker",
      targetUid: uid,
      resource: workerResource(uid, name),
    });
    await deployments.create({
      tenantId,
      id: "dep_worker_capable",
      resourceUid: "uid_worker_capable",
      offeringId: "cloudflare.module-worker",
      providerPackRef: "capable",
      providerInstallationRef: "capable.primary",
      nativeId: "capable:worker",
      state: "active",
      observed: { allocated: true },
      outputs: { scriptName: "capable-worker" },
    });
    await deployments.create({
      tenantId,
      id: "dep_worker_incapable",
      resourceUid: "uid_worker_incapable",
      offeringId: "cloudflare.module-worker",
      providerPackRef: "incapable",
      providerInstallationRef: "incapable.primary",
      nativeId: "incapable:worker",
      state: "active",
      observed: { allocated: true },
      outputs: { scriptName: "incapable-worker" },
    });

    const capableResult = await driver.apply({
      operationId: "op_runtime_capable",
      operationKey: "key_runtime_capable",
      tenantId,
      resourceUid: "uid_version_capable",
      form: version,
      name: "version-capable",
      space: "default",
      spec: { handlers: ["fetch"], requiredSensitiveVars: ["ENCRYPTION_KEY"] },
      relations: [relation("uid_worker_capable", "capable-worker")],
    });
    expect(capableResult.observed).toEqual({
      handlers: ["fetch"],
      requiredSensitiveVars: ["ENCRYPTION_KEY"],
    });
    expect(capable.sideEffectCount).toBe(1);
    expect(await deployments.active(tenantId, "uid_version_capable")).toMatchObject({
      providerPackRef: "capable",
      providerInstallationRef: "capable.primary",
    });

    await expect(
      driver.apply({
        operationId: "op_runtime_incapable",
        operationKey: "key_runtime_incapable",
        tenantId,
        resourceUid: "uid_version_incapable",
        form: version,
        name: "version-incapable",
        space: "default",
        spec: { handlers: ["fetch"], requiredSensitiveVars: ["ENCRYPTION_KEY"] },
        relations: [relation("uid_worker_incapable", "incapable-worker")],
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });
    expect(incapable.sideEffectCount).toBe(0);
    expect(await deployments.active(tenantId, "uid_version_incapable")).toBeNull();
  });

  test("does not charge a reseller reservation a second time inside the provider driver", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-08-18T18:00:00.000Z");
    const ledger = createLedger(sql, clock);
    const catalog = createCatalog([SOLD]);
    const provider = new FakeProvider({ offerings: [PROVIDER_OFFERING] });
    const driver = createProviderDriver({
      providers: [provider],
      catalog,
      ledger,
      deployments: createResourceDeploymentStore(sql, clock),
    });
    await ledger.fund({ organizationId: "org_reseller", fundingRef: "paid", amountMinor: 2_000 });

    await driver.apply({
      operationId: "op_reseller_create",
      operationKey: "key_reseller_create",
      tenantId: "org_reseller",
      resourceUid: "uid_reseller_bucket",
      form: FORM,
      name: "media",
      space: "opaque-tenant",
      spec: { location: "apac" },
      relations: [],
      commercialAuthority: {
        reservationId: "rsv_paid",
        offeringId: SOLD.id,
        offeringDigest: await catalog.digest(SOLD),
      },
    });

    expect(await ledger.wallet("org_reseller")).toMatchObject({
      settledMinor: 2_000,
      heldMinor: 0,
    });
    expect(provider.listResources()).toEqual(["org_reseller/opaque-tenant/media"]);
  });

  test("provisions and charges the wallet exactly once", async () => {
    const { app, provider, ledger } = newApp();
    const { organizationId, provider: auth } = await tenant(app.fetch);

    const created = await applyBucket(app.fetch, auth, "assets", { location: "apac" }, "apply-001");
    expect(created.status).toBe(201);
    expect(provider.listResources()).toEqual([`${organizationId}/default/assets`]);

    const wallet = await ledger.wallet(organizationId);
    expect(wallet).toMatchObject({ settledMinor: 1_500, heldMinor: 0 });

    // Replaying the same idempotency key must not provision or charge again.
    const replayed = await created.replay();
    expect(replayed.status).toBe(201);
    expect(await ledger.wallet(organizationId)).toMatchObject({ settledMinor: 1_500 });
  });

  test("abandons a planned apply when its durable dispatch marker fails", async () => {
    const durable = createEphemeralSql();
    let failDispatch = true;
    const sql: Sql = {
      query: (statement, params) => durable.query(statement, params),
      run: (statement, params) => {
        if (
          failDispatch &&
          statement.includes("tf_resource_provider_effects") &&
          params?.[5] === "dispatched"
        ) {
          failDispatch = false;
          throw new SqlError("unavailable", "simulated dispatch marker failure");
        }
        return durable.run(statement, params);
      },
      batch: (statements) => durable.batch(statements),
    };
    const provider = new FakeProvider({ offerings: [PROVIDER_OFFERING] });
    const app = buildApp({
      sql,
      objects: createMemoryObjectStore(),
      identity,
      settlement,
      publicOrigin: "https://api.takoserver.com",
      forms: [FORM],
      hostForms: [FORM],
      takoformHostFactory: createStaticStableTestTakoformHost,
      providers: [provider],
      offerings: [SOLD],
    });
    const { organizationId, provider: auth } = await tenant(app.fetch);

    const failedApply = await applyBucket(
      app.fetch,
      auth,
      "dispatch-marker-fails",
      {},
      "marker-001",
    );
    expect(failedApply.status).not.toBe(201);
    expect(provider.sideEffectCount).toBe(0);
    // The attempt provably mutated nothing, so the incarnation it reserved is
    // not left on record: an attestation that no deletion can close and an
    // `apply` effect with no terminal event are what a later repair reads as
    // "this may still be there".
    expect(
      await sql.query(
        `SELECT phase FROM tf_resource_provider_effects
         WHERE tenant_id = ? AND effect_kind = 'apply'`,
        [organizationId],
      ),
    ).toEqual([]);
    expect(
      await sql.query(
        "SELECT resource_uid FROM tf_resource_deletion_attestations WHERE tenant_id = ?",
        [organizationId],
      ),
    ).toEqual([]);
    expect(
      await sql.query("SELECT operation_id FROM tf_provider_mutation_sagas WHERE tenant_id = ?", [
        organizationId,
      ]),
    ).toEqual([]);
  });

  test("resumes an executed provider receipt after the final atomic batch is lost", async () => {
    const durable = createEphemeralSql();
    let failFinalBatch = false;
    const sql: Sql = {
      query: (statement, params) => durable.query(statement, params),
      run: (statement, params) => durable.run(statement, params),
      async batch(statements) {
        if (
          failFinalBatch &&
          statements.some((statement) =>
            statement.sql.includes("DELETE FROM tf_provider_mutation_sagas"),
          )
        ) {
          failFinalBatch = false;
          throw new SqlError("unavailable", "simulated lost final commit acknowledgement");
        }
        return await durable.batch(statements);
      },
    };
    const provider = new FakeProvider({ offerings: [PROVIDER_OFFERING] });
    const clock = () => new Date("2026-08-24T00:00:00.000Z");
    const app = buildApp({
      sql,
      objects: createMemoryObjectStore(),
      identity,
      settlement,
      publicOrigin: "https://api.takoserver.com",
      forms: [FORM],
      hostForms: [FORM],
      takoformHostFactory: createStaticStableTestTakoformHost,
      providers: [provider],
      offerings: [SOLD],
      clock,
    });
    const { organizationId, provider: auth } = await tenant(app.fetch);
    failFinalBatch = true;

    const first = await applyBucket(app.fetch, auth, "lost-ack", { location: "apac" }, "lost-001");
    expect(first.status).toBe(500);
    expect(provider.listResources()).toEqual([`${organizationId}/default/lost-ack`]);
    expect(
      await sql.query("SELECT phase FROM tf_provider_mutation_sagas WHERE tenant_id = ?", [
        organizationId,
      ]),
    ).toEqual([{ phase: "executed" }]);
    expect(
      await sql.query("SELECT id FROM tf_resource_deployments WHERE tenant_id = ?", [
        organizationId,
      ]),
    ).toEqual([]);

    const resumed = await first.replay();
    expect(resumed.status).toBe(201);
    expect(provider.listResources()).toEqual([`${organizationId}/default/lost-ack`]);
    expect(
      await sql.query("SELECT operation_id FROM tf_provider_mutation_sagas WHERE tenant_id = ?", [
        organizationId,
      ]),
    ).toEqual([]);
    expect(
      await sql.query(
        "SELECT resource_uid, state FROM tf_resource_deployments WHERE tenant_id = ?",
        [organizationId],
      ),
    ).toEqual([{ resource_uid: expect.any(String), state: "active" }]);
  });

  test("does not repeat a provider delete after losing its final atomic commit", async () => {
    const durable = createEphemeralSql();
    let failFinalBatch = false;
    const sql: Sql = {
      query: (statement, params) => durable.query(statement, params),
      run: (statement, params) => durable.run(statement, params),
      async batch(statements) {
        if (
          failFinalBatch &&
          statements.some((statement) =>
            statement.sql.includes("DELETE FROM tf_provider_mutation_sagas"),
          )
        ) {
          failFinalBatch = false;
          throw new SqlError("unavailable", "simulated lost delete commit acknowledgement");
        }
        return await durable.batch(statements);
      },
    };
    const fake = new FakeProvider({ offerings: [PROVIDER_OFFERING] });
    let deleteCalls = 0;
    const provider: Provider = {
      id: fake.id,
      offerings: fake.offerings,
      apply: (input) => fake.apply(input),
      observe: (input) => fake.observe(input),
      delete: (input) => {
        deleteCalls += 1;
        return fake.delete(input);
      },
      adopt: (input) => fake.adopt(input),
    };
    const app = buildApp({
      sql,
      objects: createMemoryObjectStore(),
      identity,
      settlement,
      publicOrigin: "https://api.takoserver.com",
      forms: [FORM],
      hostForms: [FORM],
      takoformHostFactory: createStaticStableTestTakoformHost,
      providers: [provider],
      offerings: [SOLD],
    });
    const { provider: auth } = await tenant(app.fetch);
    const created = await applyBucket(app.fetch, auth, "delete-lost", {}, "create-delete-lost");
    expect(created.status).toBe(201);
    const resource = created.body as unknown as {
      metadata: { generation: string; revision: string };
    };
    const path = `${LANE}/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/delete-lost?${QUERY}`;
    const headers = {
      ...auth,
      "idempotency-key": "delete-lost-0001",
      "if-match": `"${resource.metadata.revision}"`,
      "takoform-expected-generation": resource.metadata.generation,
    };
    failFinalBatch = true;

    const first = await call(app.fetch, "DELETE", path, undefined, headers);
    expect(first.status).toBe(500);
    expect(deleteCalls).toBe(1);
    expect(await sql.query("SELECT state FROM tf_resource_deployments")).toEqual([
      { state: "active" },
    ]);

    const resumed = await call(app.fetch, "DELETE", path, undefined, headers);
    expect(resumed.status).toBe(204);
    expect(deleteCalls).toBe(1);
    expect(await sql.query("SELECT state FROM tf_resource_deployments")).toEqual([
      { state: "deleted" },
    ]);
    expect(await sql.query("SELECT operation_id FROM tf_provider_mutation_sagas")).toEqual([]);
  });

  test("proves native absence through a read-only scoped residual receipt", async () => {
    const { app } = newApp();
    const { organizationId, provider: auth } = await tenant(app.fetch);
    const created = await applyBucket(app.fetch, auth, "residual-proof", {}, "residual-create");
    expect(created.status).toBe(201);
    const uid = String((created.body.metadata as { uid: string }).uid);
    const revision = String((created.body.metadata as { revision: string }).revision);
    const generation = String((created.body.metadata as { generation: string }).generation);
    const path = `${LANE}/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/residual-proof?${QUERY}`;
    const deleted = await call(app.fetch, "DELETE", path, undefined, {
      ...auth,
      "idempotency-key": "residual-delete",
      "if-match": `"${revision}"`,
      "takoform-expected-generation": generation,
    });
    expect(deleted.status).toBe(204);
    const query = new URLSearchParams({
      space: "default",
      name: "residual-proof",
    });
    const proof = await call(
      app.fetch,
      "GET",
      `/v1/organizations/${organizationId}/resources/${uid}/native-residual?${query}`,
      undefined,
      auth,
    );
    expect(proof.status).toBe(200);
    expect(proof.body).toEqual({
      residual: {
        status: "absent",
        source: "provider",
        effectCount: 6,
        deploymentCount: 1,
        checkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
        evidenceRef: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });
    expect(JSON.stringify(proof.body)).not.toContain("fake:org_");

    const wrongSpace = await call(
      app.fetch,
      "GET",
      `/v1/organizations/${organizationId}/resources/${uid}/native-residual?${new URLSearchParams({
        space: "other-space",
        name: "residual-proof",
      })}`,
      undefined,
      auth,
    );
    expect(wrongSpace.status).toBe(200);
    expect(wrongSpace.body).toEqual({
      residual: {
        status: "indeterminate",
        source: "provider",
        reason: "legacy_unattested",
        effectCount: 6,
        deploymentCount: 1,
        checkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
      },
    });
    const unauthorized = await call(
      app.fetch,
      "GET",
      `/v1/organizations/${organizationId}/resources/${uid}/native-residual?${query}`,
    );
    expect(unauthorized.status).toBe(401);
  });

  test("fails closed when native residual readback still sees the object", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-08-24T00:00:00.000Z");
    const ledger = createLedger(sql, clock);
    await ledger.fund({
      organizationId: "org_residual_present",
      fundingRef: "paid",
      amountMinor: 2_000,
    });
    const provider: Provider = {
      id: "fake",
      offerings: [PROVIDER_OFFERING],
      ...fakeReadback,
      async apply(input) {
        return succeeded({ nativeId: "fake:native-present", observed: input.spec, outputs: {} });
      },
      async observe() {
        return succeeded({ nativeId: "fake:native-present", observed: {}, outputs: {} });
      },
      async delete() {
        // Simulate a provider that acknowledged DELETE while the native object
        // remains reachable; the follow-up readback is the authority.
        return succeeded({
          nativeId: "fake:native-present",
          observed: { deleted: true },
          outputs: {},
        });
      },
      async verifyNativeAbsence() {
        return { outcome: "present" as const, evidence: { state: "present" } };
      },
      async recoverDelete() {
        return failed("unavailable", "native object is still present", true);
      },
    };
    const deployments = createResourceDeploymentStore(sql, clock);
    const deletions = createTakoformStore(sql, clock);
    const driver = createProviderDriver({
      providers: [provider],
      catalog: createCatalog([SOLD]),
      ledger,
      deployments,
      deletions,
    });
    const input = {
      operationId: "op_residual_present",
      operationKey: "key_residual_present",
      tenantId: "org_residual_present",
      resourceUid: "uid_residual_present",
      form: FORM,
      name: "residual-present",
      space: "default",
      spec: {},
      relations: [],
    } as const;
    await driver.apply(input);
    await deletions.prepareResourceDeletion({
      tenantId: input.tenantId,
      resourceUid: input.resourceUid,
      address: {
        tenantId: input.tenantId,
        space: input.space,
        apiVersion: FORM_REF.apiVersion,
        kind: FORM_REF.kind,
        name: input.name,
      },
      formRef: FORM_REF,
      operationId: "op_residual_delete",
    });
    await deletions.markResourceDeletionDispatch({
      tenantId: input.tenantId,
      resourceUid: input.resourceUid,
      operationId: "op_residual_delete",
    });
    await driver.delete({
      operationId: "op_residual_delete",
      tenantId: input.tenantId,
      resourceUid: input.resourceUid,
      resource: {
        apiVersion: FORM_REF.apiVersion,
        kind: FORM_REF.kind,
        form: FORM.identity,
        metadata: {
          name: input.name,
          space: input.space,
          uid: input.resourceUid,
          generation: "1",
          revision: "1",
        },
        spec: input.spec,
        status: { observedGeneration: "1", conditions: [] },
      },
      relations: [],
    });
    await deletions.recordResourceEffect({
      tenantId: input.tenantId,
      resourceUid: input.resourceUid,
      effectId: "op_residual_delete",
      kind: "delete",
      phase: "succeeded",
      operationMode: "initial",
      providerPackRef: "fake",
      providerInstallationRef: SOLD.providerInstallationRef,
      nativeId: "fake:native-present",
    });
    await sql.run(
      `UPDATE tf_resource_deletion_attestations
       SET state = 'closed', updated_at = ?
       WHERE tenant_id = ? AND resource_uid = ?`,
      [clock().getTime(), input.tenantId, input.resourceUid],
    );
    const evidence = await driver.verifyNativeAbsence?.({
      tenantId: input.tenantId,
      resourceUid: input.resourceUid,
      space: input.space,
      name: input.name,
    });
    expect(evidence).toMatchObject({
      status: "present",
      source: "provider",
      deploymentCount: 1,
    });
  });

  test("aggregates readback evidence across every deleted deployment and fences the incarnation", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-08-24T00:00:00.000Z");
    const deployments = createResourceDeploymentStore(sql, clock);
    const deletions = createTakoformStore(sql, clock);
    const calls: string[] = [];
    const provider: Provider = {
      id: "fake",
      offerings: [PROVIDER_OFFERING],
      ...fakeReadback,
      createNativeReadbackDescriptor(input) {
        calls.push(input.nativeId);
        return fakeReadback.createNativeReadbackDescriptor(input);
      },
      async apply() {
        return failed("unavailable", "not used", true);
      },
      async observe() {
        return failed("not_found", "not found");
      },
      async delete() {
        return failed("unavailable", "not used", true);
      },
      async recoverDelete(input) {
        calls.push(`${input.nativeId}:${input.operationId}`);
        return succeeded({
          nativeId: input.nativeId,
          observed: { deleted: true },
          outputs: {},
          disposition: "deleted",
        });
      },
    };
    const driver = createProviderDriver({
      providers: [provider],
      catalog: createCatalog([SOLD]),
      ledger: createLedger(sql, clock),
      deployments,
      deletions,
    });
    const marker = (deleteOperationId: string) => ({
      __takoserver: {
        resourceUid: "uid_residual_multi",
        space: "default",
        name: "residual-multi",
        deleteOperationId,
      },
    });
    await deployments.create({
      tenantId: "org_residual_multi",
      id: "deployment_old",
      resourceUid: "uid_residual_multi",
      offeringId: SOLD.id,
      providerPackRef: "fake",
      providerInstallationRef: SOLD.providerInstallationRef,
      nativeId: "fake:native-old",
      state: "deleted",
      observed: { deleted: true },
      outputs: marker("op-delete-old"),
    });
    await deployments.create({
      tenantId: "org_residual_multi",
      id: "deployment_new",
      resourceUid: "uid_residual_multi",
      offeringId: SOLD.id,
      providerPackRef: "fake",
      providerInstallationRef: SOLD.providerInstallationRef,
      nativeId: "fake:native-new",
      state: "deleted",
      observed: { deleted: true },
      outputs: marker("op-delete-new"),
    });
    for (const [effectId, installation, native] of [
      ["op-delete-old", "fake.installation.0", "fake:native-old"],
      ["op-delete-new", "fake.installation.1", "fake:native-new"],
    ] as const) {
      await deletions.prepareResourceDeletion({
        tenantId: "org_residual_multi",
        resourceUid: "uid_residual_multi",
        address: {
          tenantId: "org_residual_multi",
          space: "default",
          apiVersion: FORM_REF.apiVersion,
          kind: FORM_REF.kind,
          name: "residual-multi",
        },
        formRef: FORM_REF,
        operationId: effectId,
      });
      await deletions.markResourceDeletionDispatch({
        tenantId: "org_residual_multi",
        resourceUid: "uid_residual_multi",
        operationId: effectId,
      });
      await deletions.recordResourceEffect({
        tenantId: "org_residual_multi",
        resourceUid: "uid_residual_multi",
        effectId,
        kind: "delete",
        phase: "succeeded",
        operationMode: "initial",
        providerPackRef: "fake",
        providerInstallationRef: installation,
        nativeId: native,
      });
    }
    await sql.run(
      `UPDATE tf_resource_deletion_attestations
       SET state = 'closed', updated_at = ?
       WHERE tenant_id = ? AND resource_uid = ?`,
      [clock().getTime(), "org_residual_multi", "uid_residual_multi"],
    );

    const evidence = await driver.verifyNativeAbsence?.({
      tenantId: "org_residual_multi",
      resourceUid: "uid_residual_multi",
      space: "default",
      name: "residual-multi",
    });
    expect(evidence).toMatchObject({
      status: "absent",
      source: "provider",
      effectCount: 6,
      deploymentCount: 2,
    });
    expect(calls).toEqual(["fake:native-new", "fake:native-old"]);

    // A caller cannot select another incarnation by changing only the logical
    // address. The UID and every retained tombstone marker must agree.
    await expect(
      driver.verifyNativeAbsence?.({
        tenantId: "org_residual_multi",
        resourceUid: "uid_residual_multi",
        space: "default",
        name: "other-incarnation",
      }),
    ).resolves.toMatchObject({
      status: "indeterminate",
      reason: "legacy_unattested",
      effectCount: 6,
      deploymentCount: 2,
    });
    expect(calls).toHaveLength(2);
  });

  test("attests intrinsic WorkerBundle absence from a closed zero-identity tombstone", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-08-24T00:00:00.000Z");
    const deletions = createTakoformStore(sql, clock);
    const formRef = {
      apiVersion: "edge.forms.takoform.com",
      kind: "WorkerBundle",
      definitionVersion: "0.1.0",
      schemaDigest: `sha256:${"0".repeat(64)}`,
    } as const;
    const input = {
      tenantId: "org_intrinsic_absence",
      resourceUid: "uid_intrinsic_absence",
      address: {
        tenantId: "org_intrinsic_absence",
        space: "default",
        apiVersion: formRef.apiVersion,
        kind: formRef.kind,
        name: "worker",
      },
      formRef,
      operationId: "op_intrinsic_delete",
    } as const;
    const prepared = await deletions.prepareResourceDeletion(input);
    expect(prepared.state).toBe("pending");
    await deletions.recordResourceEffect({
      tenantId: input.tenantId,
      resourceUid: input.resourceUid,
      effectId: input.operationId,
      kind: "delete",
      phase: "dispatched",
      operationMode: "initial",
    });
    await deletions.recordResourceEffect({
      tenantId: input.tenantId,
      resourceUid: input.resourceUid,
      effectId: input.operationId,
      kind: "delete",
      phase: "succeeded",
      operationMode: "initial",
    });
    await sql.run(
      `UPDATE tf_resource_deletion_attestations
       SET state = 'closed', updated_at = ?
       WHERE tenant_id = ? AND resource_uid = ?`,
      [clock().getTime(), input.tenantId, input.resourceUid],
    );
    expect(
      await deletions.cacheResourceDeletionEvidence({
        tenantId: input.tenantId,
        resourceUid: input.resourceUid,
        closureFence: prepared.closureFence,
        evidence: { status: "absent", source: "intrinsic" },
        evidenceRef: `sha256:${"1".repeat(64)}`,
        effectSetDigest: `sha256:${"3".repeat(64)}`,
        checkedAt: clock().getTime(),
        status: "absent",
      }),
    ).toBe(false);
    const closed = await deletions.readResourceDeletion(input.tenantId, input.resourceUid);
    expect(closed?.closureFence).toBe(prepared.closureFence + 2);
    expect(
      await deletions.cacheResourceDeletionEvidence({
        tenantId: input.tenantId,
        resourceUid: input.resourceUid,
        closureFence: closed?.closureFence ?? 0,
        evidence: { status: "absent", source: "intrinsic" },
        evidenceRef: `sha256:${"2".repeat(64)}`,
        effectSetDigest: `sha256:${"4".repeat(64)}`,
        checkedAt: clock().getTime(),
        status: "absent",
      }),
    ).toBe(true);
    const driver = createProviderDriver({
      providers: [],
      catalog: createCatalog([]),
      ledger: createLedger(sql, clock),
      deployments: createResourceDeploymentStore(sql, clock),
      deletions,
    });
    const evidence = await driver.verifyNativeAbsence?.({
      tenantId: input.tenantId,
      resourceUid: input.resourceUid,
      space: input.address.space,
      name: input.address.name,
    });
    expect(evidence).toMatchObject({
      status: "absent",
      source: "intrinsic",
      effectCount: 3,
      deploymentCount: 0,
      evidenceRef: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
  });

  test("keeps provider effects append-only and refuses secret targets or UID reuse", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-08-24T00:00:00.000Z");
    const deletions = createTakoformStore(sql, clock);
    const address = {
      tenantId: "org_effect_ledger",
      space: "default",
      apiVersion: FORM_REF.apiVersion,
      kind: FORM_REF.kind,
      name: "effect-ledger",
    } as const;
    const formRef = FORM_REF;
    const resourceUid = "uid_effect_ledger";
    expect(
      await deletions.reserveResourceIncarnation({
        tenantId: address.tenantId,
        resourceUid,
        address,
        formRef,
      }),
    ).toBe(true);
    expect(
      await deletions.recordResourceEffect({
        tenantId: address.tenantId,
        resourceUid,
        effectId: "op_effect_order",
        kind: "apply",
        phase: "dispatched",
        operationMode: "initial",
      }),
    ).toBe(false);
    await expect(
      deletions.recordResourceEffect({
        tenantId: address.tenantId,
        resourceUid,
        effectId: "op_effect_order",
        kind: "apply",
        phase: "planned",
        operationMode: "initial",
        target: { token: "must-not-persist" },
      }),
    ).rejects.toMatchObject({ code: "invalid_argument", status: 400 });
    expect(
      await deletions.recordResourceEffect({
        tenantId: address.tenantId,
        resourceUid,
        effectId: "op_effect_order",
        kind: "apply",
        phase: "planned",
        operationMode: "initial",
      }),
    ).toBe(true);
    expect(
      await deletions.recordResourceEffect({
        tenantId: address.tenantId,
        resourceUid,
        effectId: "op_effect_order",
        kind: "apply",
        phase: "succeeded",
        operationMode: "initial",
      }),
    ).toBe(false);
    expect(
      await deletions.recordResourceEffect({
        tenantId: address.tenantId,
        resourceUid,
        effectId: "op_effect_order",
        kind: "apply",
        phase: "dispatched",
        operationMode: "initial",
      }),
    ).toBe(true);
    expect(
      await deletions.recordResourceEffect({
        tenantId: address.tenantId,
        resourceUid,
        effectId: "op_effect_order",
        kind: "apply",
        phase: "succeeded",
        operationMode: "initial",
      }),
    ).toBe(true);
    expect(
      await deletions.recordResourceEffect({
        tenantId: address.tenantId,
        resourceUid,
        effectId: "op_effect_order",
        kind: "apply",
        phase: "cancelled",
        operationMode: "recovery",
      }),
    ).toBe(false);
    expect(await deletions.readResourceEffectLedger(address.tenantId, resourceUid)).toHaveLength(3);

    await sql.run(
      `UPDATE tf_resource_deletion_attestations
       SET state = 'closed', updated_at = ?
       WHERE tenant_id = ? AND resource_uid = ?`,
      [clock().getTime(), address.tenantId, resourceUid],
    );
    expect(
      await deletions.reserveResourceIncarnation({
        tenantId: address.tenantId,
        resourceUid,
        address,
        formRef,
      }),
    ).toBe(false);
    expect(
      await deletions.reserveResourceIncarnation({
        tenantId: address.tenantId,
        resourceUid,
        address: { ...address, name: "reincarnated" },
        formRef,
      }),
    ).toBe(false);
  });

  test("uses an exact retained offering for recorded lifecycle but never for authoring", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-08-24T00:00:00.000Z");
    const deployments = createResourceDeploymentStore(sql, clock);
    const tenantId = "org_retained_lifecycle";
    const resourceUid = "uid_retained_lifecycle";
    const nativeId = "fake:retained-lifecycle";
    const calls: string[] = [];
    const provider: Provider = {
      id: "fake",
      offerings: [PROVIDER_OFFERING],
      recoveryOfferings: [RETAINED_PROVIDER_OFFERING],
      async apply(input) {
        calls.push(`apply:${input.offering.form.apiVersion}`);
        return succeeded({ nativeId, observed: input.spec, outputs: {} });
      },
      async observe(input) {
        calls.push(`observe:${input.offering.form.apiVersion}`);
        return succeeded({ nativeId: input.nativeId, observed: input.spec, outputs: {} });
      },
      async delete(input) {
        calls.push(`delete:${input.offering.form.apiVersion}`);
        return succeeded({
          nativeId: input.nativeId,
          observed: { deleted: true },
          outputs: {},
          disposition: "deleted",
        });
      },
    };
    await deployments.create({
      tenantId,
      id: "dep_retained_lifecycle",
      resourceUid,
      offeringId: SOLD.id,
      providerPackRef: SOLD.providerPackRef,
      providerInstallationRef: SOLD.providerInstallationRef,
      nativeId,
      state: "active",
      observed: {},
      outputs: {},
    });
    const driver = createProviderDriver({
      providers: [provider],
      catalog: createCatalog([SOLD]),
      ledger: createLedger(sql, clock),
      deployments,
    });
    const resource = {
      apiVersion: RETAINED_FORM_REF.apiVersion,
      kind: RETAINED_FORM_REF.kind,
      form: RETAINED_FORM.identity,
      metadata: {
        name: "retained-lifecycle",
        space: "default",
        uid: resourceUid,
        generation: "1",
        revision: "1",
      },
      spec: {},
      status: { observedGeneration: "1", conditions: [] },
    } as const;

    await expect(
      driver.apply({
        operationId: "op_retained_authoring",
        operationKey: "key_retained_authoring",
        tenantId,
        resourceUid: "uid_retained_authoring",
        form: RETAINED_FORM,
        name: "retained-authoring",
        space: "default",
        spec: {},
        relations: [],
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });
    await driver.observe({ tenantId, resourceUid, resource, relations: [] });
    await driver.delete({
      operationId: "op_retained_lifecycle_delete",
      tenantId,
      resourceUid,
      resource,
      relations: [],
    });
    expect(calls).toEqual([
      "observe:edge.forms.takoform.com/v1beta1",
      "delete:edge.forms.takoform.com/v1beta1",
    ]);
  });

  test("proves a retained deployment absent only through its exact recovery offering", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-08-24T00:00:00.000Z");
    const deletions = createTakoformStore(sql, clock);
    const deployments = createResourceDeploymentStore(sql, clock);
    const tenantId = "org_retained_absence";
    const resourceUid = "uid_retained_absence";
    const operationId = "op_retained_delete";
    const nativeId = "fake:retained-native";
    const formRef = RETAINED_FORM_REF;
    await deletions.prepareResourceDeletion({
      tenantId,
      resourceUid,
      address: {
        tenantId,
        space: "default",
        apiVersion: formRef.apiVersion,
        kind: formRef.kind,
        name: "retained",
      },
      formRef,
      operationId,
    });
    await deletions.recordResourceEffect({
      tenantId,
      resourceUid,
      effectId: operationId,
      kind: "delete",
      phase: "dispatched",
      operationMode: "initial",
      providerPackRef: "fake",
      providerInstallationRef: SOLD.providerInstallationRef,
      nativeId,
    });
    await deletions.recordResourceEffect({
      tenantId,
      resourceUid,
      effectId: operationId,
      kind: "delete",
      phase: "succeeded",
      operationMode: "initial",
      providerPackRef: "fake",
      providerInstallationRef: SOLD.providerInstallationRef,
      nativeId,
    });
    await sql.run(
      `UPDATE tf_resource_deletion_attestations
       SET state = 'closed', updated_at = ?
       WHERE tenant_id = ? AND resource_uid = ?`,
      [clock().getTime(), tenantId, resourceUid],
    );
    await deployments.create({
      tenantId,
      id: "dep_retained_absence",
      resourceUid,
      offeringId: SOLD.id,
      providerPackRef: "fake",
      providerInstallationRef: SOLD.providerInstallationRef,
      nativeId,
      state: "retained",
      observed: { retained: true },
      outputs: {
        __takoserver: {
          resourceUid,
          space: "default",
          name: "retained",
          deleteOperationId: operationId,
        },
      },
    });
    let readbacks = 0;
    const provider: Provider = {
      id: "fake",
      offerings: [PROVIDER_OFFERING],
      recoveryOfferings: [RETAINED_PROVIDER_OFFERING],
      ...fakeReadback,
      async verifyNativeAbsence() {
        readbacks += 1;
        return await fakeReadback.verifyNativeAbsence();
      },
      async apply() {
        return failed("unavailable", "not used", true);
      },
      async observe() {
        return failed("not_found", "not found");
      },
      async delete() {
        return failed("unavailable", "not used", true);
      },
      async recoverDelete(input) {
        readbacks += 1;
        return succeeded({
          nativeId: input.nativeId,
          observed: { deleted: true },
          outputs: {},
          disposition: "deleted",
        });
      },
    };
    const driver = createProviderDriver({
      providers: [provider],
      catalog: createCatalog([SOLD]),
      ledger: createLedger(sql, clock),
      deployments,
      deletions,
    });
    const evidence = await driver.verifyNativeAbsence?.({
      tenantId,
      resourceUid,
      space: "default",
      name: "retained",
    });
    expect(evidence).toMatchObject({
      status: "absent",
      source: "provider",
      effectCount: 3,
      deploymentCount: 1,
    });
    expect(readbacks).toBe(1);
  });

  test("keeps a provider tombstone indeterminate when dispatch had no Deployment receipt", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-08-24T00:00:00.000Z");
    const deletions = createTakoformStore(sql, clock);
    const tenantId = "org_lost_deployment";
    const resourceUid = "uid_lost_deployment";
    const operationId = "op_lost_deployment";
    await deletions.prepareResourceDeletion({
      tenantId,
      resourceUid,
      address: {
        tenantId,
        space: "default",
        apiVersion: FORM_REF.apiVersion,
        kind: FORM_REF.kind,
        name: "lost-deployment",
      },
      formRef: FORM_REF,
      operationId,
    });
    await deletions.recordResourceEffect({
      tenantId,
      resourceUid,
      effectId: operationId,
      kind: "delete",
      phase: "dispatched",
      operationMode: "initial",
      providerPackRef: "fake",
      providerInstallationRef: SOLD.providerInstallationRef,
      nativeId: "fake:lost-deployment",
    });
    await deletions.recordResourceEffect({
      tenantId,
      resourceUid,
      effectId: operationId,
      kind: "delete",
      phase: "succeeded",
      operationMode: "initial",
      providerPackRef: "fake",
      providerInstallationRef: SOLD.providerInstallationRef,
      nativeId: "fake:lost-deployment",
    });
    await sql.run(
      `UPDATE tf_resource_deletion_attestations
       SET state = 'closed', updated_at = ?
       WHERE tenant_id = ? AND resource_uid = ?`,
      [clock().getTime(), tenantId, resourceUid],
    );
    let readbacks = 0;
    const provider: Provider = {
      id: "fake",
      offerings: [PROVIDER_OFFERING],
      ...fakeReadback,
      async apply() {
        return failed("unavailable", "not used", true);
      },
      async observe() {
        return failed("not_found", "not found");
      },
      async delete() {
        return failed("unavailable", "not used", true);
      },
      async recoverDelete() {
        readbacks += 1;
        return succeeded({
          nativeId: "fake:lost-deployment",
          observed: { deleted: true },
          outputs: {},
        });
      },
    };
    const driver = createProviderDriver({
      providers: [provider],
      catalog: createCatalog([SOLD]),
      ledger: createLedger(sql, clock),
      deployments: createResourceDeploymentStore(sql, clock),
      deletions,
    });
    const evidence = await driver.verifyNativeAbsence?.({
      tenantId,
      resourceUid,
      space: "default",
      name: "lost-deployment",
    });
    expect(evidence).toEqual({
      status: "indeterminate",
      source: "provider",
      reason: "provider_identity_missing",
      effectCount: 3,
      deploymentCount: 0,
      checkedAt: expect.any(String),
    });
    expect(readbacks).toBe(0);
  });

  test("fails closed when a deployment installation drifts from the provider authority", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-08-24T00:00:00.000Z");
    const deletions = createTakoformStore(sql, clock);
    const deployments = createResourceDeploymentStore(sql, clock);
    const tenantId = "org_same_native";
    const resourceUid = "uid_same_native";
    const operationIds = ["op_install_a", "op_install_b"] as const;
    const nativeId = "fake:shared-native";
    await deletions.prepareResourceDeletion({
      tenantId,
      resourceUid,
      address: {
        tenantId,
        space: "default",
        apiVersion: FORM_REF.apiVersion,
        kind: FORM_REF.kind,
        name: "same-native",
      },
      formRef: FORM_REF,
      operationId: operationIds[0],
    });
    await deletions.prepareResourceDeletion({
      tenantId,
      resourceUid,
      address: {
        tenantId,
        space: "default",
        apiVersion: FORM_REF.apiVersion,
        kind: FORM_REF.kind,
        name: "same-native",
      },
      formRef: FORM_REF,
      operationId: operationIds[1],
    });
    for (const [index, operationId] of operationIds.entries()) {
      await deletions.recordResourceEffect({
        tenantId,
        resourceUid,
        effectId: operationId,
        kind: "delete",
        phase: "dispatched",
        operationMode: "initial",
        providerPackRef: "fake",
        providerInstallationRef: `fake.installation.${index}`,
        nativeId,
      });
      await deletions.recordResourceEffect({
        tenantId,
        resourceUid,
        effectId: operationId,
        kind: "delete",
        phase: "succeeded",
        operationMode: "initial",
        providerPackRef: "fake",
        providerInstallationRef: `fake.installation.${index}`,
        nativeId,
      });
    }
    await sql.run(
      `UPDATE tf_resource_deletion_attestations
       SET state = 'closed', updated_at = ?
       WHERE tenant_id = ? AND resource_uid = ?`,
      [clock().getTime(), tenantId, resourceUid],
    );
    const marker = (operationId: string) => ({
      __takoserver: {
        resourceUid,
        space: "default",
        name: "same-native",
        deleteOperationId: operationId,
      },
    });
    await deployments.create({
      tenantId,
      id: "dep_install_a",
      resourceUid,
      offeringId: SOLD.id,
      providerPackRef: "fake",
      providerInstallationRef: "fake.installation.0",
      nativeId,
      state: "retained",
      observed: { retained: true },
      outputs: marker(operationIds[0]),
    });
    await deployments.create({
      tenantId,
      id: "dep_install_b",
      resourceUid,
      offeringId: SOLD.id,
      providerPackRef: "fake",
      providerInstallationRef: "fake.installation.1",
      nativeId,
      state: "retained",
      observed: { retained: true },
      outputs: marker(operationIds[1]),
    });
    const readbacks: string[] = [];
    const provider: Provider = {
      id: "fake",
      offerings: [PROVIDER_OFFERING],
      ...fakeReadback,
      createNativeReadbackDescriptor(input) {
        readbacks.push(input.nativeId);
        return fakeReadback.createNativeReadbackDescriptor(input);
      },
      async apply() {
        return failed("unavailable", "not used", true);
      },
      async observe() {
        return failed("not_found", "not found");
      },
      async delete() {
        return failed("unavailable", "not used", true);
      },
      async recoverDelete(input) {
        readbacks.push(`${input.operationId}:${input.nativeId}`);
        return succeeded({
          nativeId,
          observed: { deleted: true },
          outputs: {},
          disposition: "deleted",
        });
      },
    };
    const driver = createProviderDriver({
      providers: [provider],
      catalog: createCatalog([SOLD]),
      ledger: createLedger(sql, clock),
      deployments,
      deletions,
    });
    const evidence = await driver.verifyNativeAbsence?.({
      tenantId,
      resourceUid,
      space: "default",
      name: "same-native",
    });
    expect(evidence).toMatchObject({
      status: "indeterminate",
      source: "provider",
      reason: "provider_unavailable",
      effectCount: 6,
      deploymentCount: 2,
    });
    expect(readbacks).toEqual([]);
  });

  test("fails closed before adapter readback when the provider offering Form drifts", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-08-24T00:00:00.000Z");
    const deletions = createTakoformStore(sql, clock);
    const deployments = createResourceDeploymentStore(sql, clock);
    const tenantId = "org_offering_form_drift";
    const resourceUid = "uid_offering_form_drift";
    const operationId = "op_offering_form_drift_delete";
    const nativeId = "fake:offering-form-drift";
    await deletions.prepareResourceDeletion({
      tenantId,
      resourceUid,
      address: {
        tenantId,
        space: "default",
        apiVersion: FORM_REF.apiVersion,
        kind: FORM_REF.kind,
        name: "offering-form-drift",
      },
      formRef: FORM_REF,
      operationId,
    });
    await deletions.recordResourceEffect({
      tenantId,
      resourceUid,
      effectId: operationId,
      kind: "delete",
      phase: "dispatched",
      operationMode: "initial",
      providerPackRef: SOLD.providerPackRef,
      providerInstallationRef: SOLD.providerInstallationRef,
      nativeId,
    });
    await deletions.recordResourceEffect({
      tenantId,
      resourceUid,
      effectId: operationId,
      kind: "delete",
      phase: "succeeded",
      operationMode: "initial",
      providerPackRef: SOLD.providerPackRef,
      providerInstallationRef: SOLD.providerInstallationRef,
      nativeId,
    });
    await sql.run(
      `UPDATE tf_resource_deletion_attestations
       SET state = 'closed', updated_at = ?
       WHERE tenant_id = ? AND resource_uid = ?`,
      [clock().getTime(), tenantId, resourceUid],
    );
    await deployments.create({
      tenantId,
      id: "dep_offering_form_drift",
      resourceUid,
      offeringId: SOLD.id,
      providerPackRef: SOLD.providerPackRef,
      providerInstallationRef: SOLD.providerInstallationRef,
      nativeId,
      state: "retained",
      observed: { retained: true },
      outputs: {
        __takoserver: {
          resourceUid,
          space: "default",
          name: "offering-form-drift",
          deleteOperationId: operationId,
        },
      },
    });
    const driftedOffering: ProviderOffering = {
      ...PROVIDER_OFFERING,
      form: { ...FORM_REF, definitionVersion: "0.2.0" },
    };
    let descriptorCalls = 0;
    let verifyCalls = 0;
    const provider: Provider = {
      id: SOLD.providerPackRef,
      offerings: [driftedOffering],
      createNativeReadbackDescriptor(input) {
        descriptorCalls += 1;
        return {
          apiVersion: "providers.takoserver.com/readback/v1",
          provider: SOLD.providerPackRef,
          kind: input.offering.kind,
          nativeId: input.nativeId,
          data: {
            tenantRef: input.identity.tenantRef,
            space: input.identity.space,
            name: input.identity.name,
          },
        };
      },
      async verifyNativeAbsence() {
        verifyCalls += 1;
        return { outcome: "absent" as const, evidence: {} };
      },
      async apply() {
        return failed("unavailable", "not used", true);
      },
      async observe() {
        return failed("not_found", "not found");
      },
      async delete() {
        return failed("unavailable", "not used", true);
      },
    };
    const driver = createProviderDriver({
      providers: [provider],
      catalog: createCatalog([SOLD]),
      ledger: createLedger(sql, clock),
      deployments,
      deletions,
    });
    const evidence = await driver.verifyNativeAbsence?.({
      tenantId,
      resourceUid,
      space: "default",
      name: "offering-form-drift",
    });
    expect(evidence).toMatchObject({
      status: "indeterminate",
      source: "provider",
      reason: "provider_unavailable",
      deploymentCount: 1,
    });
    expect(descriptorCalls).toBe(0);
    expect(verifyCalls).toBe(0);
  });

  test("provisions a usage-only resource without a fake monthly or setup debit", async () => {
    const { app, provider, ledger } = newApp({ usageOnly: true });
    const { organizationId, provider: auth } = await tenant(app.fetch);

    const created = await applyBucket(app.fetch, auth, "metered", {}, "apply-usage-only");

    expect(created.status).toBe(201);
    expect(provider.listResources()).toEqual([`${organizationId}/default/metered`]);
    expect(await ledger.wallet(organizationId)).toMatchObject({
      settledMinor: 2_000,
      heldMinor: 0,
      availableMinor: 2_000,
    });
  });

  test("returns the hold when the backend refuses", async () => {
    const { app, ledger } = newApp({ failOn: ["doomed"] });
    const { organizationId, provider: auth } = await tenant(app.fetch);

    const failed = await applyBucket(app.fetch, auth, "doomed", { location: "apac" }, "apply-002");
    expect(failed.status).toBe(503);
    // The customer keeps their money, and nothing is recorded as provisioned.
    expect(await ledger.wallet(organizationId)).toMatchObject({
      settledMinor: 2_000,
      heldMinor: 0,
      availableMinor: 2_000,
    });
    const read = await call(
      app.fetch,
      "GET",
      `${LANE}/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/doomed?${QUERY}`,
      undefined,
      auth,
    );
    expect(read.status).toBe(404);
  });

  test("refuses to provision what the wallet cannot pay for", async () => {
    const { app, provider, ledger } = newApp();
    const { organizationId, provider: auth } = await tenant(app.fetch);

    // Four buckets at 500 exhausts the 2,000 credited.
    for (const name of ["one", "two", "three", "four"]) {
      expect((await applyBucket(app.fetch, auth, name, {}, `apply-${name}`)).status).toBe(201);
    }
    expect(await ledger.wallet(organizationId)).toMatchObject({ availableMinor: 0 });

    const denied = await applyBucket(app.fetch, auth, "five", {}, "apply-five");
    expect(denied.status).toBe(402);
    expect(provider.listResources()).toHaveLength(4);
  });

  test("records the backend's own identity so a later read finds the same thing", async () => {
    const { app, ledger, sql } = newApp();
    const { organizationId, provider: auth } = await tenant(app.fetch);
    const created = await applyBucket(app.fetch, auth, "assets", { location: "apac" }, "apply-003");
    const resource = created.body as unknown as { metadata: { uid: string } };

    // The wire Resource is logical. Provider identity belongs only to its
    // active Deployment, where a later migration may add a candidate beside it.
    expect(
      (await sql.query("PRAGMA table_info(tf_resources)")).map((column) => column.name),
    ).not.toContain("native_id");
    expect(
      await sql.query(
        `SELECT resource_uid, offering_id, provider_pack_ref, provider_installation_ref,
                native_id, state
         FROM tf_resource_deployments WHERE tenant_id = ? AND resource_uid = ?`,
        [organizationId, resource.metadata.uid],
      ),
    ).toEqual([
      {
        resource_uid: resource.metadata.uid,
        offering_id: SOLD.id,
        provider_pack_ref: "fake",
        provider_installation_ref: "fake.primary",
        native_id: `fake:${organizationId}/default/assets`,
        state: "active",
      },
    ]);

    const observed = await call(
      app.fetch,
      "POST",
      `${LANE}/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/assets/observe?${QUERY}`,
      undefined,
      { ...auth, "idempotency-key": "observe-001", "takoform-expected-generation": "1" },
    );
    expect(observed.status).toBe(200);
    // Observation reaches the backend by native identity and bills nothing.
    expect(await ledger.wallet(organizationId)).toMatchObject({ settledMinor: 1_500 });
  });

  test("deletes on the backend when the resource is deleted", async () => {
    const { app, provider, sql } = newApp();
    const { provider: auth } = await tenant(app.fetch);
    const created = await applyBucket(app.fetch, auth, "assets", {}, "apply-004");
    const resource = created.body as unknown as { metadata: { uid: string } };
    expect(provider.listResources()).toHaveLength(1);

    const deleted = await call(
      app.fetch,
      "DELETE",
      `${LANE}/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/assets?${QUERY}`,
      undefined,
      { ...auth, "idempotency-key": "delete-001", "takoform-expected-generation": "1" },
    );
    expect(deleted.status).toBe(204);
    expect(provider.listResources()).toEqual([]);
    expect(
      await sql.query("SELECT state FROM tf_resource_deployments WHERE resource_uid = ?", [
        resource.metadata.uid,
      ]),
    ).toEqual([{ state: "deleted" }]);
  });
});

describe("orphaned declarations", () => {
  test("names resources whose Form is no longer installed", async () => {
    const sql = createEphemeralSql();
    const provider = new FakeProvider({ offerings: [PROVIDER_OFFERING] });
    const ports = {
      sql,
      objects: createMemoryObjectStore(),
      identity,
      settlement,
      publicOrigin: "https://api.takoserver.com",
      providers: [provider],
      offerings: [SOLD],
    };

    const app = buildApp({
      ...ports,
      forms: [FORM],
      hostForms: [FORM],
      takoformHostFactory: createStaticStableTestTakoformHost,
    });
    const { provider: auth } = await tenant(app.fetch);
    await applyBucket(app.fetch, auth, "assets", { location: "apac" }, "orphan-001");
    expect((await app.tick()).orphanedResources).toEqual([]);

    // The same deployment, restarted with a Form whose schema moved on without
    // a new definition version. The declaration is now unresolvable, and the
    // backend resource it describes is still running.
    const moved = buildApp({
      ...ports,
      hostForms: [FORM],
      takoformHostFactory: createStaticStableTestTakoformHost,
      forms: [
        {
          ...FORM,
          identity: {
            formRef: { ...FORM_REF, schemaDigest: `sha256:${"9".repeat(64)}` },
          },
        },
      ],
    });
    expect((await moved.tick()).orphanedResources).toEqual(["default/ObjectBucket/assets"]);
  });
});
