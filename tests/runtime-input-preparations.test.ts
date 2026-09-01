import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  buildApp,
  createEphemeralSql,
  createMemoryObjectStore,
  createRuntimeInputAuthority,
  deriveRuntimeInputReference,
  InMemoryTakoformResourceDriver,
} from "../src/index.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { createTakoformStore } from "../src/takoform/store.ts";

const PREPARATION_TIME = "2026-08-31T18:00:00Z";
const WORKER_RESOURCE_REVISION = "1";
const PREPARATION_TARGET = {
  space: "default",
  workerName: "yurucommu",
  workerResourceUid: "uid-worker-01",
  bundleName: "bundle-01",
  originReservationId: "reservation-01",
} as const;
const CLAIM_TARGET = {
  space: PREPARATION_TARGET.space,
  workerName: PREPARATION_TARGET.workerName,
  workerResourceUid: PREPARATION_TARGET.workerResourceUid,
  bundleName: PREPARATION_TARGET.bundleName,
} as const;
const PREPARATION_BINDINGS = {
  ENCRYPTION_KEY: "placeholder-encryption-value",
  TAKOSUMI_ACCOUNTS_CLIENT_ID: "placeholder-client-id",
} as const;
const PREPARATION_BINDING_NAMES = ["ENCRYPTION_KEY", "TAKOSUMI_ACCOUNTS_CLIENT_ID"] as const;
const WORKER_FORM_REF = {
  apiVersion: "edge.forms.takoform.com",
  kind: "ModuleWorker",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:049df2fb1eda53e4ccb0d646022a3ded8bc17c44eb433fa2e5ac0861efe42ac7" as const,
};
const RESERVATION_REVISION = "2";
const OFFERING_ID = "worker.module.test";
const OFFERING_DIGEST = `sha256:${"a".repeat(64)}` as const;

type PreparationTarget = {
  readonly space: string;
  readonly workerName: string;
  readonly workerResourceUid: string;
  readonly bundleName: string;
  readonly originReservationId: string;
};

async function runtimeInputFixture(
  options: { readonly randomIds?: readonly string[]; readonly initialTime?: string } = {},
) {
  const sql = createEphemeralSql();
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  let now = new Date(options.initialTime ?? PREPARATION_TIME);
  await seedReservationLifecycle(
    sql,
    "org_01",
    PREPARATION_TARGET.originReservationId,
    now.getTime(),
  );
  let realizedOrigin = "https://community.example.test";
  let afterNextOriginResolution: (() => Promise<void>) | undefined;
  const reservation = () => ({
    organizationId: "org_01",
    reservationId: PREPARATION_TARGET.originReservationId,
    canonicalPublicOrigin: realizedOrigin,
    revision: RESERVATION_REVISION,
    expiresAtEpochMilliseconds: Date.parse(PREPARATION_TIME) + 60 * 60 * 1_000,
    binding: {
      space: PREPARATION_TARGET.space,
      workerName: PREPARATION_TARGET.workerName,
      workerResourceUid: PREPARATION_TARGET.workerResourceUid,
      workerResourceRevision: WORKER_RESOURCE_REVISION,
      endpointName: "public",
    },
    status: "bound" as const,
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
    offeringId: OFFERING_ID,
    offeringDigest: OFFERING_DIGEST,
  });
  const resolveReservation = async () => {
    const resolution = reservation();
    const afterResolve = afterNextOriginResolution;
    afterNextOriginResolution = undefined;
    if (afterResolve) await afterResolve();
    return resolution;
  };
  const authority = createRuntimeInputAuthority({
    sql,
    sealKeys: { current: { keyId: "runtime-input-test-key", key } },
    originReservations: {
      bind: resolveReservation,
      inspectBound: resolveReservation,
    },
    clock: () => now,
    randomId: () => "unused-server-id",
  });
  return {
    sql,
    authority,
    setNow(value: string) {
      now = new Date(value);
    },
    clock: () => now,
    setRealizedOrigin(value: string) {
      realizedOrigin = value;
    },
    raceNextOriginResolution(afterResolve: () => Promise<void>) {
      afterNextOriginResolution = afterResolve;
    },
  };
}

function preparationInput(
  operationId: string,
  overrides: {
    readonly materialSetId?: string;
    readonly materialSetNonce?: string;
    readonly target?: PreparationTarget;
    readonly canonicalPublicOrigin?: string;
    readonly bindings?: Readonly<Record<string, string>>;
  } = {},
) {
  const target = overrides.target ?? PREPARATION_TARGET;
  const bindings = overrides.bindings ?? PREPARATION_BINDINGS;
  const materialSetNonce = overrides.materialSetNonce ?? "nonce-01";
  const canonicalPublicOrigin = overrides.canonicalPublicOrigin ?? "https://community.example.test";
  const preimage = JSON.stringify({
    format: "takoserver.worker-runtime-input-preflight.v1",
    materialSetNonce,
    target: {
      space: target.space,
      workerName: target.workerName,
      bundleName: target.bundleName,
      endpointName: "public",
      originReservationId: target.originReservationId,
      canonicalPublicOrigin,
    },
    bindings: Object.fromEntries(
      Object.entries(bindings).sort(([left], [right]) => left.localeCompare(right)),
    ),
  });
  const hex = createHash("sha256").update(preimage).digest("hex");
  const preparationId = `prep-${hex.slice(0, 32)}`;
  return {
    organizationId: "org_01",
    operationId,
    materialSetId: overrides.materialSetId ?? "material-set-01",
    materialSetNonce,
    runtimeInputReference: `rip1.${preparationId}.${hex}`,
    target,
    bindings,
  };
}

test("accepts the exact Go provider preflight golden across the full Unicode domain", async () => {
  const materialSetNonce = "A".repeat(43);
  const bindings = {
    A: "<&>\u2028\u2029",
    Z: "non-bmp-😀",
  };
  const expectedReference =
    "rip1.prep-2e42bd63644611fe7a79da06e0993205.2e42bd63644611fe7a79da06e09932056f6ac00874251acb75f174d3a18d931c";
  const derived = await deriveRuntimeInputReference({
    format: "takoserver.worker-runtime-input-preflight.v1",
    materialSetNonce,
    target: {
      space: PREPARATION_TARGET.space,
      workerName: PREPARATION_TARGET.workerName,
      bundleName: PREPARATION_TARGET.bundleName,
      endpointName: "public",
      originReservationId: PREPARATION_TARGET.originReservationId,
      canonicalPublicOrigin: "https://community.example.test",
    },
    bindings,
  });
  expect(derived.runtimeInputReference).toBe(expectedReference);

  const { authority } = await runtimeInputFixture();
  await expect(
    authority.preparations.prepare({
      organizationId: "org_01",
      operationId: "op_unicode",
      materialSetId: "material-set-unicode",
      materialSetNonce,
      runtimeInputReference: expectedReference,
      target: PREPARATION_TARGET,
      bindings,
    }),
  ).resolves.toMatchObject({ runtimeInputReference: expectedReference, status: "prepared" });
});

test("rejects unpaired UTF-16 surrogates instead of hashing a cross-language replacement", async () => {
  for (const invalid of ["\ud800", "\ud800x", "\udc00", "x\udc00"]) {
    await expect(
      deriveRuntimeInputReference({
        format: "takoserver.worker-runtime-input-preflight.v1",
        materialSetNonce: "nonce-01",
        target: {
          space: PREPARATION_TARGET.space,
          workerName: PREPARATION_TARGET.workerName,
          bundleName: PREPARATION_TARGET.bundleName,
          endpointName: "public",
          originReservationId: PREPARATION_TARGET.originReservationId,
          canonicalPublicOrigin: "https://community.example.test",
        },
        bindings: { A: invalid },
      }),
    ).rejects.toMatchObject({ code: "invalid_argument", status: 400 });
  }
  await expect(
    deriveRuntimeInputReference({
      format: "takoserver.worker-runtime-input-preflight.v1",
      materialSetNonce: "nonce-01",
      target: {
        space: PREPARATION_TARGET.space,
        workerName: PREPARATION_TARGET.workerName,
        bundleName: PREPARATION_TARGET.bundleName,
        endpointName: "public",
        originReservationId: PREPARATION_TARGET.originReservationId,
        canonicalPublicOrigin: "https://community.example.test",
      },
      bindings: { A: "valid-😀-�" },
    }),
  ).resolves.toMatchObject({ runtimeInputReference: expect.stringMatching(/^rip1\./u) });
});

function leaseInput(reference: string, overrides: { readonly operationId?: string } = {}) {
  return {
    organizationId: "org_01",
    operationId: overrides.operationId ?? "worker-version-operation-01",
    resourceUid: "uid-worker-version-01",
    reference,
    target: CLAIM_TARGET,
    bindingNames: [...PREPARATION_BINDING_NAMES].reverse(),
  };
}

function boundReservation(organizationId: string) {
  return {
    organizationId,
    reservationId: PREPARATION_TARGET.originReservationId,
    canonicalPublicOrigin: "https://community.example.test",
    revision: RESERVATION_REVISION,
    expiresAtEpochMilliseconds: Date.parse(PREPARATION_TIME) + 60 * 60 * 1_000,
    binding: {
      space: PREPARATION_TARGET.space,
      workerName: PREPARATION_TARGET.workerName,
      workerResourceUid: PREPARATION_TARGET.workerResourceUid,
      workerResourceRevision: WORKER_RESOURCE_REVISION,
      endpointName: "public",
    },
    status: "bound" as const,
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
    offeringId: OFFERING_ID,
    offeringDigest: OFFERING_DIGEST,
  };
}

test("prepares one encrypted runtime-input set and returns its exact reference projection", async () => {
  const { sql, authority } = await runtimeInputFixture();
  const prepared = await authority.preparations.prepare(preparationInput("op_01"));

  expect(prepared).toMatchObject({
    format: "takoserver.worker-runtime-input-preparation@v1",
    operationId: "op_01",
    preparationId: expect.stringMatching(/^prep-[0-9a-f]{32}$/u),
    status: "prepared",
    expiresAt: "2026-08-31T19:00:00.000Z",
    target: {
      space: "default",
      workerName: "yurucommu",
      workerResourceUid: "uid-worker-01",
      bundleName: "bundle-01",
      originReservationId: "reservation-01",
    },
    canonicalPublicOrigin: "https://community.example.test",
    bindingNames: ["ENCRYPTION_KEY", "TAKOSUMI_ACCOUNTS_CLIENT_ID"],
  });
  expect(prepared.runtimeInputReference).toMatch(/^rip1\.prep-[0-9a-f]{32}\.[0-9a-f]{64}$/u);
  expect(await authority.preparations.prepare(preparationInput("op_01"))).toEqual(prepared);

  const rows = await sql.query(
    "SELECT binding_names_json, sealed_payload, seal_nonce FROM worker_runtime_input_preparations WHERE organization_id = ? AND operation_id = ?",
    ["org_01", "op_01"],
  );
  expect(rows).toHaveLength(1);
  const durable = JSON.stringify(rows[0]);
  expect(durable).not.toContain("placeholder-encryption-value");
  expect(durable).not.toContain("placeholder-client-id");
  expect(rows[0]?.binding_names_json).toBe('["ENCRYPTION_KEY","TAKOSUMI_ACCOUNTS_CLIENT_ID"]');
  expect(typeof rows[0]?.sealed_payload).toBe("string");
  expect(typeof rows[0]?.seal_nonce).toBe("string");
});

test("classifies an operation replay with a different non-secret target as conflict", async () => {
  const { authority } = await runtimeInputFixture();
  const original = preparationInput("op_01", {
    bindings: { ENCRYPTION_KEY: "placeholder-encryption-value" },
  });
  await authority.preparations.prepare(original);

  await expect(
    authority.preparations.prepare(
      preparationInput("op_01", {
        target: { ...original.target, workerName: "another-worker" },
        bindings: original.bindings,
      }),
    ),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
});

test("rejects origin drift before preparation or claim state changes", async () => {
  const fixture = await runtimeInputFixture();
  await expect(
    fixture.authority.preparations.prepare(
      preparationInput("op_bad", {
        canonicalPublicOrigin: "https://other.example.test",
      }),
    ),
  ).rejects.toMatchObject({ code: "invalid_argument", status: 400 });
  expect(
    await fixture.sql.query(
      "SELECT operation_id FROM worker_runtime_input_preparations WHERE organization_id = ?",
      ["org_01"],
    ),
  ).toHaveLength(0);

  const prepared = await fixture.authority.preparations.prepare(preparationInput("op_01"));
  fixture.setRealizedOrigin("https://other.example.test");
  await expect(
    fixture.authority.leases.acquire(leaseInput(prepared.runtimeInputReference)),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
  expect(await fixture.authority.preparations.read("org_01", "op_01")).toMatchObject({
    status: "prepared",
  });
});

test("expires an unclaimed preparation and erases its ciphertext on read", async () => {
  const { sql, authority, setNow } = await runtimeInputFixture();
  await authority.preparations.prepare(
    preparationInput("op_01", {
      bindings: { ENCRYPTION_KEY: "placeholder-encryption-value" },
    }),
  );
  setNow("2026-08-31T19:00:01Z");

  expect(await authority.preparations.read("org_01", "op_01")).toMatchObject({
    status: "expired",
  });
  const [row] = await sql.query(
    "SELECT sealed_payload, seal_nonce, seal_key_id FROM worker_runtime_input_preparations WHERE organization_id = ? AND operation_id = ?",
    ["org_01", "op_01"],
  );
  expect(row).toEqual({ sealed_payload: null, seal_nonce: null, seal_key_id: null });
});

test("requires the exact preparation reference and refuses substitution", async () => {
  const { authority } = await runtimeInputFixture({ randomIds: ["prep_01", "prep_02"] });
  const first = await authority.preparations.prepare(preparationInput("op_01"));
  const second = await authority.preparations.prepare(
    preparationInput("op_02", {
      target: { ...PREPARATION_TARGET, bundleName: "another-bundle" },
    }),
  );

  await expect(
    authority.leases.acquire({
      ...leaseInput(first.runtimeInputReference),
      reference: second.runtimeInputReference,
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
  expect(await authority.preparations.read("org_01", "op_01")).toMatchObject({
    status: "prepared",
  });
  expect(await authority.preparations.read("org_01", "op_02")).toMatchObject({
    status: "prepared",
  });

  const [prefix, preparationId] = first.runtimeInputReference.split(".");
  const forgedReference = `${prefix}.${preparationId}.${"0".repeat(64)}`;
  await expect(
    authority.leases.acquire({
      ...leaseInput(first.runtimeInputReference),
      reference: forgedReference,
    }),
  ).rejects.toMatchObject({ code: "invalid_argument", status: 400 });
  expect(await authority.preparations.read("org_01", "op_01")).toMatchObject({
    status: "prepared",
  });
});

test("claims the exact reference with a commitment-bound preparation identity", async () => {
  const { authority } = await runtimeInputFixture();
  const prepared = await authority.preparations.prepare(preparationInput("op_01"));
  const lease = await authority.leases.acquire(leaseInput(prepared.runtimeInputReference));

  expect(lease.bindings).toEqual(PREPARATION_BINDINGS);
  expect(lease.preparation).toMatchObject({
    preparationId: prepared.preparationId,
    materialSetId: "material-set-01",
    originReservationId: "reservation-01",
    canonicalPublicOrigin: "https://community.example.test",
  });
  expect(lease.preparation.commitment).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(prepared.runtimeInputReference).toBe(
    `rip1.${prepared.preparationId}.${lease.preparation.commitment.slice("sha256:".length)}`,
  );

  await lease.abort();
});

test("aborts a claimed lease and erases its ciphertext", async () => {
  const { sql, authority } = await runtimeInputFixture();
  const prepared = await authority.preparations.prepare(preparationInput("op_01"));
  const lease = await authority.leases.acquire(leaseInput(prepared.runtimeInputReference));
  const [before] = await sql.query(
    "SELECT sealed_payload, seal_nonce, seal_key_id FROM worker_runtime_input_preparations WHERE organization_id = ? AND operation_id = ?",
    ["org_01", "op_01"],
  );
  expect(typeof before?.sealed_payload).toBe("string");

  await lease.abort();
  expect(await authority.preparations.read("org_01", "op_01")).toMatchObject({
    status: "revoked",
  });
  const [after] = await sql.query(
    "SELECT sealed_payload, seal_nonce, seal_key_id FROM worker_runtime_input_preparations WHERE organization_id = ? AND operation_id = ?",
    ["org_01", "op_01"],
  );
  expect(after).toEqual({ sealed_payload: null, seal_nonce: null, seal_key_id: null });
  await expect(lease.dispatch()).rejects.toMatchObject({ code: "conflict", status: 409 });
});

test("lets exactly one abort-or-dispatch transition win", async () => {
  const { sql, authority } = await runtimeInputFixture();
  const prepared = await authority.preparations.prepare(preparationInput("op_01"));
  const lease = await authority.leases.acquire(leaseInput(prepared.runtimeInputReference));

  const outcomes = await Promise.allSettled([lease.abort(), lease.dispatch()]);
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  expect(await authority.preparations.read("org_01", "op_01")).toMatchObject({
    status: expect.stringMatching(/^(dispatched|revoked)$/u),
  });
  const [row] = await sql.query(
    "SELECT sealed_payload, seal_nonce, seal_key_id FROM worker_runtime_input_preparations WHERE organization_id = ? AND operation_id = ?",
    ["org_01", "op_01"],
  );
  expect(row).toEqual({ sealed_payload: null, seal_nonce: null, seal_key_id: null });
});

test("revalidates and revision-fences the origin immediately before dispatch", async () => {
  const drifted = await runtimeInputFixture();
  const prepared = await drifted.authority.preparations.prepare(
    preparationInput("op_dispatch_drift"),
  );
  const lease = await drifted.authority.leases.acquire(leaseInput(prepared.runtimeInputReference));
  drifted.setRealizedOrigin("https://changed.example.test");

  await expect(lease.dispatch()).rejects.toMatchObject({ code: "conflict", status: 409 });
  expect(await drifted.authority.preparations.read("org_01", "op_dispatch_drift")).toMatchObject({
    status: "claimed",
  });

  const raced = await runtimeInputFixture();
  const racedPreparation = await raced.authority.preparations.prepare(
    preparationInput("op_dispatch_revision_race"),
  );
  const racedLease = await raced.authority.leases.acquire(
    leaseInput(racedPreparation.runtimeInputReference),
  );
  raced.raceNextOriginResolution(async () => {
    await raced.sql.run(
      `UPDATE tf_resources SET revision = '2'
       WHERE tenant_id = ? AND uid = ? AND revision = ?`,
      ["org_01", PREPARATION_TARGET.workerResourceUid, WORKER_RESOURCE_REVISION],
    );
  });

  await expect(racedLease.dispatch()).rejects.toMatchObject({ code: "conflict", status: 409 });
  expect(
    await raced.authority.preparations.read("org_01", "op_dispatch_revision_race"),
  ).toMatchObject({ status: "claimed" });
});

test("serializes origin deletion against claim and releases the pin on abort", async () => {
  const fixture = await runtimeInputFixture();
  const prepared = await fixture.authority.preparations.prepare(preparationInput("op_01"));
  const lease = await fixture.authority.leases.acquire(leaseInput(prepared.runtimeInputReference));
  const store = createTakoformStore(fixture.sql, fixture.clock);
  const deletion = {
    tenantId: "org_01",
    resourceUid: PREPARATION_TARGET.workerResourceUid,
    address: {
      tenantId: "org_01",
      space: "default",
      apiVersion: WORKER_FORM_REF.apiVersion,
      kind: WORKER_FORM_REF.kind,
      name: PREPARATION_TARGET.workerName,
    },
    formRef: WORKER_FORM_REF,
    operationId: "delete-origin-01",
  } as const;

  await expect(store.prepareResourceDeletion(deletion)).rejects.toMatchObject({
    code: "dependency_in_use",
    status: 409,
  });
  expect(await fixture.authority.preparations.read("org_01", "op_01")).toMatchObject({
    status: "claimed",
  });

  await lease.abort();
  await expect(store.prepareResourceDeletion(deletion)).resolves.toMatchObject({
    state: "pending",
  });
});

test("lets deletion win before claim and keeps recovery available after dispatch", async () => {
  const deletionFirst = await runtimeInputFixture();
  const prepared = await deletionFirst.authority.preparations.prepare(preparationInput("op_01"));
  const deletionStore = createTakoformStore(deletionFirst.sql, deletionFirst.clock);
  await deletionStore.prepareResourceDeletion({
    tenantId: "org_01",
    resourceUid: PREPARATION_TARGET.workerResourceUid,
    address: {
      tenantId: "org_01",
      space: "default",
      apiVersion: WORKER_FORM_REF.apiVersion,
      kind: WORKER_FORM_REF.kind,
      name: PREPARATION_TARGET.workerName,
    },
    formRef: WORKER_FORM_REF,
    operationId: "delete-origin-01",
  });
  await expect(
    deletionFirst.authority.leases.acquire(leaseInput(prepared.runtimeInputReference)),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
  expect(await deletionFirst.authority.preparations.read("org_01", "op_01")).toMatchObject({
    status: "prepared",
  });

  const dispatchFirst = await runtimeInputFixture();
  const dispatchPrepared = await dispatchFirst.authority.preparations.prepare(
    preparationInput("op_01"),
  );
  const lease = await dispatchFirst.authority.leases.acquire(
    leaseInput(dispatchPrepared.runtimeInputReference),
  );
  await lease.dispatch();
  const dispatchStore = createTakoformStore(dispatchFirst.sql, dispatchFirst.clock);
  await dispatchStore.prepareResourceDeletion({
    tenantId: "org_01",
    resourceUid: PREPARATION_TARGET.workerResourceUid,
    address: {
      tenantId: "org_01",
      space: "default",
      apiVersion: WORKER_FORM_REF.apiVersion,
      kind: WORKER_FORM_REF.kind,
      name: PREPARATION_TARGET.workerName,
    },
    formRef: WORKER_FORM_REF,
    operationId: "delete-origin-01",
  });
  await expect(
    dispatchFirst.authority.leases.recover(leaseInput(dispatchPrepared.runtimeInputReference)),
  ).resolves.toMatchObject({
    preparation: { preparationId: dispatchPrepared.preparationId },
  });
});

test("recovers one dispatched preparation by value-free identity and settles it", async () => {
  const { authority } = await runtimeInputFixture();
  const prepared = await authority.preparations.prepare(preparationInput("op_01"));
  const input = leaseInput(prepared.runtimeInputReference);
  const lease = await authority.leases.acquire(input);
  await lease.dispatch();

  const [prefix, preparationId] = prepared.runtimeInputReference.split(".");
  const forgedReference = `${prefix}.${preparationId}.${"0".repeat(64)}`;
  await expect(
    authority.leases.recover({ ...input, reference: forgedReference }),
  ).rejects.toMatchObject({ code: "invalid_argument", status: 400 });
  expect(await authority.preparations.read("org_01", "op_01")).toMatchObject({
    status: "dispatched",
  });

  const recovered = await authority.leases.recover(input);
  expect(recovered.preparation).toEqual(lease.preparation);
  expect(recovered.bindingNames).toEqual([...PREPARATION_BINDING_NAMES]);
  expect(recovered).not.toHaveProperty("bindings");
  expect(JSON.stringify(recovered)).not.toContain("placeholder-encryption-value");

  await recovered.settle(`sha256:${"b".repeat(64)}`);
  expect(await authority.preparations.read("org_01", "op_01")).toMatchObject({
    status: "consumed",
  });
});

test("sweeps an expired claim but leaves a dispatched preparation untouched", async () => {
  const { sql, authority, setNow } = await runtimeInputFixture();
  const prepared = await authority.preparations.prepare(preparationInput("op_01"));
  const lease = await authority.leases.acquire(leaseInput(prepared.runtimeInputReference));

  setNow("2026-08-31T18:15:01Z");
  expect(await authority.maintenance.expireDue(64)).toBe(1);
  expect(await authority.preparations.read("org_01", "op_01")).toMatchObject({
    status: "expired",
  });
  const [expired] = await sql.query(
    "SELECT sealed_payload, seal_nonce, seal_key_id FROM worker_runtime_input_preparations WHERE organization_id = ? AND operation_id = ?",
    ["org_01", "op_01"],
  );
  expect(expired).toEqual({ sealed_payload: null, seal_nonce: null, seal_key_id: null });
  await expect(lease.dispatch()).rejects.toMatchObject({ code: "conflict", status: 409 });

  const secondFixture = await runtimeInputFixture();
  const second = await secondFixture.authority.preparations.prepare(preparationInput("op_02"));
  const dispatched = await secondFixture.authority.leases.acquire(
    leaseInput(second.runtimeInputReference),
  );
  await dispatched.dispatch();
  secondFixture.setNow("2026-08-31T20:00:01Z");
  expect(await secondFixture.authority.maintenance.expireDue(64)).toBe(0);
  expect(await secondFixture.authority.preparations.read("org_01", "op_02")).toMatchObject({
    status: "dispatched",
  });
});

test("serves the closed preparation control API to one resources writer", async () => {
  const sql = createEphemeralSql();
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  let randomCounter = 0;
  const randomId = () => {
    randomCounter += 1;
    return `test_${String(randomCounter).padStart(8, "0")}`;
  };
  const runtimeInputs = createRuntimeInputAuthority({
    sql,
    sealKeys: { current: { keyId: "runtime-input-test-key", key } },
    originReservations: {
      async bind(input) {
        return boundReservation(input.organizationId);
      },
      async inspectBound(input) {
        return boundReservation(input.organizationId);
      },
    },
    clock: () => new Date("2026-08-31T18:00:00Z"),
    randomId,
  });
  const currentCandidates = currentTakoformCandidates();
  const app = buildApp({
    sql,
    objects: createMemoryObjectStore(),
    identity: {
      async verify() {
        return {
          providerSubject: "owner-subject",
          email: "owner@example.test",
          displayName: "Owner",
        };
      },
    },
    settlement: {
      async verify() {
        return { fundingRef: "unused", amountMinor: 0, currency: "USD" };
      },
    },
    publicOrigin: "https://api.takoserver.test",
    forms: currentCandidates.forms,
    bindings: currentCandidates.bindings,
    hostForms: currentCandidates.forms,
    hostBindings: currentCandidates.bindings,
    driver: new InMemoryTakoformResourceDriver(),
    providers: [
      {
        id: "runtime-input-test-provider",
        offerings: [],
        runtimeInputCapabilities: { maximumBindings: 64 },
        async apply(): Promise<never> {
          throw new Error("runtime-input capability probe must not apply");
        },
        async observe(): Promise<never> {
          throw new Error("runtime-input capability probe must not observe");
        },
        async delete(): Promise<never> {
          throw new Error("runtime-input capability probe must not delete");
        },
      },
    ],
    offerings: [],
    runtimeInputs,
    clock: () => new Date("2026-08-31T18:00:00Z"),
    randomId,
  });
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    authorization?: string,
  ): Promise<Response> =>
    await app.fetch(
      new Request(`https://api.takoserver.test${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(authorization ? { authorization } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const formProfiles = await call("GET", "/v1/forms");
  expect(formProfiles.status).toBe(200);
  const formProfilesBody = (await formProfiles.json()) as {
    profiles: readonly { formRef: { kind: string }; limits?: Record<string, number> }[];
  };
  expect(
    formProfilesBody.profiles.find((profile) => profile.formRef.kind === "WorkerVersion"),
  ).toMatchObject({
    formRef: { kind: "WorkerVersion" },
    limits: { requiredSensitiveVars: 0 },
  });
  const session = await call("POST", "/v1/sessions", {
    provider: "google",
    assertion: "verified-owner-assertion",
  });
  expect(session.status).toBe(200);
  const sessionBody = (await session.json()) as { sessionToken: string };
  const owner = `Bearer ${sessionBody.sessionToken}`;
  const organization = await call("POST", "/v1/organizations", { name: "Owner" }, owner);
  expect(organization.status).toBe(201);
  const organizationBody = (await organization.json()) as { organization: { id: string } };
  const organizationId = organizationBody.organization.id;
  await seedReservationLifecycle(
    sql,
    organizationId,
    "reservation-01",
    Date.parse(PREPARATION_TIME),
  );
  const apiKey = await call(
    "POST",
    `/v1/organizations/${organizationId}/api-keys`,
    { name: "runtime-input-writer", scopes: ["resources:write"], expiresInSeconds: 3_600 },
    owner,
  );
  expect(apiKey.status).toBe(201);
  const apiKeyBody = (await apiKey.json()) as { secret: string };
  const writer = `Bearer ${apiKeyBody.secret}`;
  const readKey = await call(
    "POST",
    `/v1/organizations/${organizationId}/api-keys`,
    { name: "runtime-input-reader", scopes: ["resources:read"], expiresInSeconds: 3_600 },
    owner,
  );
  expect(readKey.status).toBe(201);
  const readKeyBody = (await readKey.json()) as { secret: string };
  const reader = `Bearer ${readKeyBody.secret}`;
  const otherOrganization = await call("POST", "/v1/organizations", { name: "Other" }, owner);
  expect(otherOrganization.status).toBe(201);
  const otherOrganizationBody = (await otherOrganization.json()) as {
    organization: { id: string };
  };
  const otherApiKey = await call(
    "POST",
    `/v1/organizations/${otherOrganizationBody.organization.id}/api-keys`,
    { name: "other-runtime-input-writer", scopes: ["resources:write"], expiresInSeconds: 3_600 },
    owner,
  );
  expect(otherApiKey.status).toBe(201);
  const otherApiKeyBody = (await otherApiKey.json()) as { secret: string };
  const otherWriter = `Bearer ${otherApiKeyBody.secret}`;

  const preparedInput = preparationInput("op_01", {
    bindings: { ENCRYPTION_KEY: "placeholder-encryption-value" },
  });
  const input = {
    format: "takoserver.worker-runtime-input-preparation@v1",
    materialSetId: preparedInput.materialSetId,
    materialSetNonce: preparedInput.materialSetNonce,
    runtimeInputReference: preparedInput.runtimeInputReference,
    target: preparedInput.target,
    bindings: preparedInput.bindings,
  };
  const path = `/v1/organizations/${organizationId}/worker-runtime-input-preparations/op_01`;
  expect((await call("PUT", path, input, owner)).status).toBe(403);
  expect((await call("PUT", path, input, otherWriter)).status).toBe(403);
  const readOnlyAttempt = await call("PUT", path, input, reader);
  expect(readOnlyAttempt.status).toBe(403);
  const malformed = await call("PUT", path, { ...input, ignoredTypo: true }, writer);
  expect(malformed.status).toBe(400);
  expect(
    await sql.query(
      "SELECT operation_id FROM worker_runtime_input_preparations WHERE organization_id = ?",
      [organizationId],
    ),
  ).toHaveLength(0);

  const prepared = await call("PUT", path, input, writer);
  expect(prepared.status).toBe(201);
  expect(prepared.headers.get("cache-control")).toBe("private, no-store");
  const preparedBody = (await prepared.json()) as Record<string, unknown>;
  expect(preparedBody).not.toHaveProperty("bindings");
  expect(JSON.stringify(preparedBody)).not.toContain("placeholder-encryption-value");
  expect(preparedBody).toMatchObject({
    operationId: "op_01",
    preparationId: expect.any(String),
    status: "prepared",
    bindingNames: ["ENCRYPTION_KEY"],
  });
  expect(preparedBody.runtimeInputReference).toMatch(/^rip1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/u);

  const replayed = await call("PUT", path, input, writer);
  expect(replayed.status).toBe(201);
  expect(await replayed.json()).toEqual(preparedBody);
  const conflictingReplay = await call(
    "PUT",
    path,
    { ...input, bindings: { ENCRYPTION_KEY: "different-placeholder-value" } },
    writer,
  );
  expect(conflictingReplay.status).toBe(400);

  const read = await call("GET", path, undefined, writer);
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual(preparedBody);

  const revoked = await call("DELETE", path, undefined, writer);
  expect(revoked.status).toBe(204);
  expect((await call("DELETE", path, undefined, writer)).status).toBe(204);
  const revokedRead = await call("GET", path, undefined, writer);
  expect(revokedRead.status).toBe(200);
  expect(await revokedRead.json()).toMatchObject({ operationId: "op_01", status: "revoked" });
  const [durable] = await sql.query(
    "SELECT state, sealed_payload FROM worker_runtime_input_preparations WHERE organization_id = ? AND operation_id = ?",
    [organizationId, "op_01"],
  );
  expect(durable).toEqual({ state: "revoked", sealed_payload: null });
});

async function seedReservationLifecycle(
  sql: ReturnType<typeof createEphemeralSql>,
  organizationId: string,
  reservationId: string,
  now: number,
): Promise<void> {
  const resource = {
    apiVersion: WORKER_FORM_REF.apiVersion,
    kind: WORKER_FORM_REF.kind,
    form: { formRef: WORKER_FORM_REF },
    metadata: {
      name: PREPARATION_TARGET.workerName,
      space: PREPARATION_TARGET.space,
      uid: PREPARATION_TARGET.workerResourceUid,
      generation: "1",
      revision: WORKER_RESOURCE_REVISION,
    },
    spec: {},
    status: {
      observedGeneration: "1",
      conditions: [
        {
          type: "Ready",
          status: "True",
          reason: "Available",
          lastTransitionTime: new Date(now).toISOString(),
        },
      ],
    },
  };
  await sql.run(
    `INSERT INTO tf_resources
       (tenant_id, space, api_version, kind, name, uid, generation, revision,
        resource_json, updated_at)
     VALUES (?, 'default', 'edge.forms.takoform.com', 'ModuleWorker', 'yurucommu', ?,
             '1', ?, ?, ?)`,
    [
      organizationId,
      PREPARATION_TARGET.workerResourceUid,
      WORKER_RESOURCE_REVISION,
      JSON.stringify(resource),
      now,
    ],
  );
  await sql.run(
    `INSERT INTO tf_resource_deployments
       (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
        provider_installation_ref, native_id, native_claimed, state,
        observed_json, outputs_json, created_at, updated_at)
     VALUES (?, 'deployment-worker-01', ?, ?, 'fake', 'fake.primary',
             'worker:native-01', 0, 'active', '{}', '{}', ?, ?)`,
    [organizationId, PREPARATION_TARGET.workerResourceUid, OFFERING_ID, now, now],
  );
  await sql.run(
    `INSERT INTO worker_endpoint_origin_reservations
       (organization_id, reservation_id, reservation_format,
        legacy_space, legacy_worker_name, legacy_endpoint_name, requested_subdomain,
        canonical_public_origin, provider_pack_ref, provider_installation_ref,
        offering_id, offering_digest, requested_ttl_seconds, expires_at,
        state, revision, bound_space, bound_worker_name,
        worker_resource_uid, worker_resource_revision, bound_endpoint_name,
        endpoint_resource_uid, endpoint_resource_revision, created_at, updated_at, released_at)
     VALUES (?, ?, 'takoserver.worker-endpoint-origin-reservation.v2',
             NULL, NULL, NULL, 'community', 'https://community.example.test',
             'fake', 'fake.primary', ?, ?, 3600, ?, 'bound', ?, 'default', 'yurucommu',
             ?, ?, 'public', 'uid-endpoint-01', '1', ?, ?, NULL)`,
    [
      organizationId,
      reservationId,
      OFFERING_ID,
      OFFERING_DIGEST,
      now + 60 * 60 * 1_000,
      Number(RESERVATION_REVISION),
      PREPARATION_TARGET.workerResourceUid,
      WORKER_RESOURCE_REVISION,
      now,
      now,
    ],
  );
  await sql.run(
    `INSERT INTO tf_resource_deletion_attestations
       (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
        state, closure_fence, effects_json, evidence_json, evidence_ref,
        evidence_effect_digest, evidence_checked_at, evidence_status, created_at, updated_at)
     VALUES (?, ?, 'default', 'edge.forms.takoform.com', 'ModuleWorker', 'yurucommu', ?,
             'live', 1, '[]', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    [
      organizationId,
      PREPARATION_TARGET.workerResourceUid,
      JSON.stringify(WORKER_FORM_REF),
      now,
      now,
    ],
  );
}

test("does not mount the preparation route without an explicit runtime-input service", async () => {
  const app = buildApp({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    identity: {
      async verify() {
        throw new Error("identity must not be reached");
      },
    },
    settlement: {
      async verify() {
        throw new Error("settlement must not be reached");
      },
    },
    publicOrigin: "https://api.takoserver.test",
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
  });

  const response = await app.fetch(
    new Request(
      "https://api.takoserver.test/v1/organizations/org_01/worker-runtime-input-preparations/op_01",
      { method: "GET" },
    ),
  );
  expect(response.status).toBe(404);
});
