import { expect, test } from "bun:test";
import {
  buildApp,
  createEphemeralSql,
  createMemoryObjectStore,
  createRuntimeInputAuthority,
  InMemoryTakoformResourceDriver,
  runtimeInputPublicApplyCommitment,
} from "../src/index.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";

const HOST_ORIGIN = "https://api.takoserver.test";
const PREPARATION_TIME = "2026-08-31T18:00:00Z";
const OPERATION_KEY = `takoform-worker-runtime-v1-${"c".repeat(64)}`;
const HOST_OPERATION_ID = "op_worker_version_01";
const WORKER_RESOURCE_UID = "uid-worker-01";
const VERSION_RESOURCE_UID = "uid-worker-version-01";
const OFFERING_ID = "worker.module.test";
const CLAIM_TARGET = {
  space: "default",
  workerName: "yurucommu",
  workerResourceUid: WORKER_RESOURCE_UID,
  bundleName: "bundle-01",
} as const;
const BINDINGS = {
  ENCRYPTION_KEY: "placeholder-encryption-value",
  TAKOSUMI_ACCOUNTS_CLIENT_ID: "placeholder-client-id",
} as const;
const BINDING_NAMES = ["ENCRYPTION_KEY", "TAKOSUMI_ACCOUNTS_CLIENT_ID"] as const;
const APPLY_PATH = "/apis/forms.takoform.com/v1/spaces/default/resources/WorkerVersion/app-v1";
const APPLY_BODY = '{"apiVersion":"edge.forms.takoform.com","kind":"WorkerVersion"}';
const WORKER_FORM_REF = {
  apiVersion: "edge.forms.takoform.com",
  kind: "ModuleWorker",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:049df2fb1eda53e4ccb0d646022a3ded8bc17c44eb433fa2e5ac0861efe42ac7" as const,
};

function publicApply(
  overrides: { readonly path?: string; readonly body?: string; readonly method?: string } = {},
) {
  return {
    method: overrides.method ?? "PUT",
    path: overrides.path ?? APPLY_PATH,
    fences: { ifNoneMatch: "*" },
    body: overrides.body ?? APPLY_BODY,
  };
}

function preparationInput(
  overrides: {
    readonly operationKey?: string;
    readonly canonicalPublicOrigin?: string;
    readonly bindings?: Readonly<Record<string, string>>;
    readonly path?: string;
    readonly body?: string;
  } = {},
) {
  return {
    organizationId: "org_01",
    operationKey: overrides.operationKey ?? OPERATION_KEY,
    canonicalPublicOrigin: overrides.canonicalPublicOrigin ?? HOST_ORIGIN,
    publicApply: publicApply(overrides),
    bindings: overrides.bindings ?? BINDINGS,
  };
}

function leaseInput(
  overrides: { readonly operationId?: string; readonly reference?: string } = {},
) {
  return {
    organizationId: "org_01",
    operationId: overrides.operationId ?? HOST_OPERATION_ID,
    resourceUid: VERSION_RESOURCE_UID,
    reference: overrides.reference ?? OPERATION_KEY,
    target: CLAIM_TARGET,
    // Deliberately unsorted: the authority sorts before it fences.
    bindingNames: [...BINDING_NAMES].reverse(),
  };
}

async function runtimeInputFixture(options: { readonly initialTime?: string } = {}) {
  const sql = createEphemeralSql();
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  let now = new Date(options.initialTime ?? PREPARATION_TIME);
  await seedWorkerLifecycle(sql, "org_01", now.getTime());
  const authority = createRuntimeInputAuthority({
    sql,
    sealKeys: { current: { keyId: "runtime-input-test-key", key } },
    canonicalPublicOrigin: HOST_ORIGIN,
    clock: () => now,
  });
  return {
    sql,
    authority,
    setNow(value: string) {
      now = new Date(value);
    },
  };
}

test("commits to the exact public apply with the released provider's own framing", async () => {
  // Goldens produced by clientv3.RuntimeInputPublicApplyCommitment in the
  // released provider worktree, so the two implementations are proved equal
  // rather than merely described as equal.
  expect(await runtimeInputPublicApplyCommitment(publicApply())).toBe(
    "sha256:19172351e3e716937020b3957cd21de33b1f29ebac182dec2c66a9d16dd43053",
  );
  expect(await runtimeInputPublicApplyCommitment(publicApply({ path: "/a", body: "b" }))).toBe(
    "sha256:3e252054273aac593d7cc703c8c290d9051373cf7e6cb0448e46eb6f1a5dc794",
  );
  expect(
    await runtimeInputPublicApplyCommitment(
      publicApply({ path: "/unicode/\u2028\u2029", body: "non-bmp-\u{1f600}" }),
    ),
  ).toBe("sha256:94741ee6ad4cff2e17d23eb2b2746c7fae9d561ef1cbfac921926f09e3b15352");
});

test("refuses a public apply this contract cannot authorize", async () => {
  for (const invalid of [
    publicApply({ method: "POST" }),
    publicApply({ path: "no-leading-slash" }),
    publicApply({ body: "" }),
    { ...publicApply(), fences: { ifNoneMatch: "W/x" } },
    publicApply({ body: "\ud800" }),
  ]) {
    await expect(runtimeInputPublicApplyCommitment(invalid)).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
    });
  }
});

test("seals one runtime-input set and projects it without any value", async () => {
  const { sql, authority } = await runtimeInputFixture();
  const prepared = await authority.preparations.prepare(preparationInput());

  expect(prepared).toEqual({
    format: "takoserver.worker-runtime-input-preparation@v2",
    status: "prepared",
    operationKey: OPERATION_KEY,
    applyCommitment: "sha256:19172351e3e716937020b3957cd21de33b1f29ebac182dec2c66a9d16dd43053",
    canonicalPublicOrigin: HOST_ORIGIN,
    bindingNames: ["ENCRYPTION_KEY", "TAKOSUMI_ACCOUNTS_CLIENT_ID"],
  });
  expect(await authority.preparations.prepare(preparationInput())).toEqual(prepared);
  expect(await authority.preparations.read("org_01", OPERATION_KEY)).toEqual(prepared);

  const rows = await sql.query(
    "SELECT * FROM worker_runtime_input_preparations WHERE organization_id = ? AND operation_key = ?",
    ["org_01", OPERATION_KEY],
  );
  expect(rows).toHaveLength(1);
  const durable = JSON.stringify(rows[0]);
  expect(durable).not.toContain("placeholder-encryption-value");
  expect(durable).not.toContain("placeholder-client-id");
  expect(rows[0]?.binding_names_json).toBe('["ENCRYPTION_KEY","TAKOSUMI_ACCOUNTS_CLIENT_ID"]');
  expect(rows[0]?.preparation_id).toMatch(/^prep-[0-9a-f]{32}$/u);
  expect(rows[0]?.host_operation_id).toBeNull();
});

test("refuses a preparation addressed to another Host origin", async () => {
  const { sql, authority } = await runtimeInputFixture();
  await expect(
    authority.preparations.prepare(
      preparationInput({ canonicalPublicOrigin: "https://api.elsewhere.test" }),
    ),
  ).rejects.toMatchObject({ code: "invalid_argument", status: 400 });
  expect(
    await sql.query("SELECT operation_key FROM worker_runtime_input_preparations", []),
  ).toHaveLength(0);
});

test("classifies a replay that changes the public apply or the values as a conflict", async () => {
  const { authority } = await runtimeInputFixture();
  await authority.preparations.prepare(preparationInput());
  await expect(
    authority.preparations.prepare(preparationInput({ body: '{"kind":"Different"}' })),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
  await expect(
    authority.preparations.prepare(
      preparationInput({ bindings: { ...BINDINGS, ENCRYPTION_KEY: "different" } }),
    ),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
  await expect(
    authority.preparations.prepare(preparationInput({ bindings: { ENCRYPTION_KEY: "x" } })),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
});

test("claims the exact operation key with a commitment-bound preparation identity", async () => {
  const { authority } = await runtimeInputFixture();
  const prepared = await authority.preparations.prepare(preparationInput());
  const lease = await authority.leases.acquire(leaseInput());

  expect(lease.bindings).toEqual(BINDINGS);
  expect(lease.preparation).toEqual({
    preparationId: expect.stringMatching(/^prep-[0-9a-f]{32}$/u),
    operationKey: OPERATION_KEY,
    workerResourceUid: WORKER_RESOURCE_UID,
    canonicalPublicOrigin: HOST_ORIGIN,
    commitment: prepared.applyCommitment,
  });

  // A claimed handoff names the Host operation that will consume it, which is
  // the only thing a recovering caller can poll after a lost acknowledgement.
  expect(await authority.preparations.read("org_01", OPERATION_KEY)).toMatchObject({
    status: "accepted",
    hostOperationId: HOST_OPERATION_ID,
  });

  // Re-acquiring the same operation is idempotent; a different one is refused.
  expect((await authority.leases.acquire(leaseInput())).bindings).toEqual(BINDINGS);
  await expect(
    authority.leases.acquire(leaseInput({ operationId: "op_other" })),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
});

test("refuses a claim whose binding-name set is not the sealed one", async () => {
  const { authority } = await runtimeInputFixture();
  await authority.preparations.prepare(preparationInput());
  await expect(
    authority.leases.acquire({ ...leaseInput(), bindingNames: ["ENCRYPTION_KEY"] }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
});

test("erases the sealed bytes before the provider request and settles from a receipt", async () => {
  const { sql, authority } = await runtimeInputFixture();
  await authority.preparations.prepare(preparationInput());
  const lease = await authority.leases.acquire(leaseInput());
  const sealedAfterClaim = await sql.query(
    "SELECT state, sealed_payload FROM worker_runtime_input_preparations WHERE organization_id = ? AND operation_key = ?",
    ["org_01", OPERATION_KEY],
  );
  expect(sealedAfterClaim[0]?.state).toBe("claimed");
  expect(typeof sealedAfterClaim[0]?.sealed_payload).toBe("string");

  const dispatched = await lease.dispatch();
  const afterDispatch = await sql.query(
    "SELECT state, sealed_payload, seal_nonce, seal_key_id FROM worker_runtime_input_preparations WHERE organization_id = ? AND operation_key = ?",
    ["org_01", OPERATION_KEY],
  );
  expect(afterDispatch[0]).toMatchObject({
    state: "dispatched",
    sealed_payload: null,
    seal_nonce: null,
    seal_key_id: null,
  });
  expect(await authority.preparations.read("org_01", OPERATION_KEY)).toMatchObject({
    status: "dispatched",
    hostOperationId: HOST_OPERATION_ID,
  });

  await dispatched.settle(`sha256:${"1".repeat(64)}`);
  expect(await authority.preparations.read("org_01", OPERATION_KEY)).toMatchObject({
    status: "consumed",
  });
  // Settling twice with the same authoritative readback is the same answer.
  await dispatched.settle(`sha256:${"1".repeat(64)}`);
  await expect(dispatched.settle(`sha256:${"2".repeat(64)}`)).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });
});

test("aborts a claimed lease, erases it, and lets the same key be prepared again", async () => {
  const { sql, authority } = await runtimeInputFixture();
  await authority.preparations.prepare(preparationInput());
  const lease = await authority.leases.acquire(leaseInput());
  await lease.abort();

  const [aborted] = await sql.query(
    "SELECT state, sealed_payload FROM worker_runtime_input_preparations WHERE organization_id = ? AND operation_key = ?",
    ["org_01", OPERATION_KEY],
  );
  expect(aborted).toEqual({ state: "revoked", sealed_payload: null });
  expect(await authority.preparations.read("org_01", OPERATION_KEY)).toBeNull();
  await expect(lease.dispatch()).rejects.toMatchObject({ code: "conflict", status: 409 });

  // A Terraform retry recomputes the same plan-derived operation key.
  expect(await authority.preparations.prepare(preparationInput())).toMatchObject({
    status: "prepared",
  });
});

test("refuses to prepare over a handoff whose values already reached a provider", async () => {
  const { authority } = await runtimeInputFixture();
  await authority.preparations.prepare(preparationInput());
  const lease = await authority.leases.acquire(leaseInput());
  await lease.dispatch();
  await expect(authority.preparations.prepare(preparationInput())).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });
});

test("lets exactly one abort-or-dispatch transition win", async () => {
  const { authority } = await runtimeInputFixture();
  await authority.preparations.prepare(preparationInput());
  const lease = await authority.leases.acquire(leaseInput());
  await lease.dispatch();
  await expect(lease.abort()).rejects.toMatchObject({ code: "conflict", status: 409 });
});

test("recovers a dispatched handoff by value-free identity and never returns values", async () => {
  const { authority } = await runtimeInputFixture();
  const prepared = await authority.preparations.prepare(preparationInput());
  const lease = await authority.leases.acquire(leaseInput());
  await lease.dispatch();

  const recovery = await authority.leases.recover(leaseInput());
  expect(Object.keys(recovery)).toEqual(["preparation", "bindingNames", "settle"]);
  expect(recovery.bindingNames).toEqual([...BINDING_NAMES]);
  expect(recovery.preparation.commitment).toBe(prepared.applyCommitment);
  expect(JSON.stringify(recovery.preparation)).not.toContain("placeholder-encryption-value");

  await recovery.settle(`sha256:${"3".repeat(64)}`);
  expect(await authority.preparations.read("org_01", OPERATION_KEY)).toMatchObject({
    status: "consumed",
  });
});

test("abandons a dispatched handoff after proven provider absence", async () => {
  const { sql, authority } = await runtimeInputFixture();
  await authority.preparations.prepare(preparationInput());
  const lease = await authority.leases.acquire(leaseInput());
  await lease.dispatch();
  await authority.leases.abandon?.(leaseInput());
  await authority.leases.abandon?.(leaseInput());
  const [row] = await sql.query(
    "SELECT state FROM worker_runtime_input_preparations WHERE organization_id = ? AND operation_key = ?",
    ["org_01", OPERATION_KEY],
  );
  expect(row).toEqual({ state: "revoked" });
});

test("blocks ModuleWorker deletion while an unexpired claim exists", async () => {
  const { sql, authority } = await runtimeInputFixture();
  await authority.preparations.prepare(preparationInput());
  await authority.leases.acquire(leaseInput());
  const blocking = await sql.query(
    `SELECT operation_key FROM worker_runtime_input_preparations
     WHERE organization_id = ? AND worker_resource_uid = ? AND state = 'claimed'
       AND claim_expires_at > ?`,
    ["org_01", WORKER_RESOURCE_UID, Date.parse(PREPARATION_TIME)],
  );
  expect(blocking).toHaveLength(1);
});

test("sweeps an expired claim but leaves a dispatched handoff untouched", async () => {
  const fixture = await runtimeInputFixture();
  await fixture.authority.preparations.prepare(preparationInput());
  await fixture.authority.leases.acquire(leaseInput());
  fixture.setNow("2026-08-31T18:20:00Z");
  expect(await fixture.authority.maintenance.expireDue(64)).toBe(1);
  expect(await fixture.authority.preparations.read("org_01", OPERATION_KEY)).toBeNull();

  const second = await runtimeInputFixture();
  await second.authority.preparations.prepare(preparationInput());
  const lease = await second.authority.leases.acquire(leaseInput());
  await lease.dispatch();
  second.setNow("2026-08-31T20:00:00Z");
  expect(await second.authority.maintenance.expireDue(64)).toBe(0);
  expect(await second.authority.preparations.read("org_01", OPERATION_KEY)).toMatchObject({
    status: "dispatched",
  });
});

test("expires an unclaimed preparation and erases its ciphertext on read", async () => {
  const fixture = await runtimeInputFixture();
  await fixture.authority.preparations.prepare(preparationInput());
  fixture.setNow("2026-08-31T19:00:01Z");
  expect(await fixture.authority.preparations.read("org_01", OPERATION_KEY)).toBeNull();
  const [row] = await fixture.sql.query(
    "SELECT state, sealed_payload FROM worker_runtime_input_preparations WHERE organization_id = ? AND operation_key = ?",
    ["org_01", OPERATION_KEY],
  );
  expect(row).toEqual({ state: "expired", sealed_payload: null });
});

test("serves the private v2 route to one resources writer, shaped as the provider sends it", async () => {
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
    canonicalPublicOrigin: HOST_ORIGIN,
    clock: () => new Date(PREPARATION_TIME),
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
    publicOrigin: HOST_ORIGIN,
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
    clock: () => new Date(PREPARATION_TIME),
    randomId,
  });
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    authorization?: string,
    idempotencyKey?: string,
  ): Promise<Response> =>
    await app.fetch(
      new Request(`${HOST_ORIGIN}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(authorization ? { authorization } : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  const formProfiles = await call("GET", "/v1/forms");
  expect(formProfiles.status).toBe(200);
  const formProfilesBody = (await formProfiles.json()) as {
    profiles: readonly { formRef: { kind: string }; limits?: Record<string, number> }[];
  };
  // The published key is the one the released provider reads back.
  expect(
    formProfilesBody.profiles.find((profile) => profile.formRef.kind === "WorkerVersion"),
  ).toMatchObject({
    formRef: { kind: "WorkerVersion" },
    limits: { maximumRequiredSensitiveVars: 0 },
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
  const apiKey = await call(
    "POST",
    `/v1/organizations/${organizationId}/api-keys`,
    { name: "runtime-input-writer", scopes: ["resources:write"], expiresInSeconds: 3_600 },
    owner,
  );
  expect(apiKey.status).toBe(201);
  const writer = `Bearer ${((await apiKey.json()) as { secret: string }).secret}`;
  const readKey = await call(
    "POST",
    `/v1/organizations/${organizationId}/api-keys`,
    { name: "runtime-input-reader", scopes: ["resources:read"], expiresInSeconds: 3_600 },
    owner,
  );
  expect(readKey.status).toBe(201);
  const reader = `Bearer ${((await readKey.json()) as { secret: string }).secret}`;

  // Exactly the body the Go client encodes, including its key order.
  const input = {
    format: "takoserver.worker-runtime-input-preparation@v2",
    canonicalPublicOrigin: HOST_ORIGIN,
    publicApply: {
      method: "PUT",
      path: APPLY_PATH,
      fences: { ifNoneMatch: "*" },
      body: APPLY_BODY,
    },
    bindings: { ENCRYPTION_KEY: "placeholder-encryption-value" },
  };
  const path = `/v1/takoform/worker-runtime-input-preparations/${OPERATION_KEY}`;

  expect((await call("PUT", path, input, owner, OPERATION_KEY)).status).toBe(403);
  expect((await call("PUT", path, input, reader, OPERATION_KEY)).status).toBe(403);
  expect((await call("PUT", path, input, undefined, OPERATION_KEY)).status).toBe(401);
  // The private request must name the same operation the public apply will.
  expect((await call("PUT", path, input, writer, "some-other-key")).status).toBe(400);
  expect((await call("PUT", path, input, writer)).status).toBe(400);
  expect(
    (await call("PUT", path, { ...input, ignoredTypo: true }, writer, OPERATION_KEY)).status,
  ).toBe(400);
  expect(
    await sql.query(
      "SELECT operation_key FROM worker_runtime_input_preparations WHERE organization_id = ?",
      [organizationId],
    ),
  ).toHaveLength(0);

  const prepared = await call("PUT", path, input, writer, OPERATION_KEY);
  expect(prepared.status).toBe(200);
  expect(prepared.headers.get("cache-control")).toBe("private, no-store");
  const preparedBody = (await prepared.json()) as Record<string, unknown>;
  expect(JSON.stringify(preparedBody)).not.toContain("placeholder-encryption-value");
  expect(preparedBody).toEqual({
    format: "takoserver.worker-runtime-input-preparation@v2",
    status: "prepared",
    operationKey: OPERATION_KEY,
    applyCommitment: "sha256:19172351e3e716937020b3957cd21de33b1f29ebac182dec2c66a9d16dd43053",
    canonicalPublicOrigin: HOST_ORIGIN,
    bindingNames: ["ENCRYPTION_KEY"],
  });

  const replayed = await call("PUT", path, input, writer, OPERATION_KEY);
  expect(replayed.status).toBe(200);
  expect(await replayed.json()).toEqual(preparedBody);

  const drifted = await call(
    "PUT",
    path,
    { ...input, publicApply: { ...input.publicApply, body: '{"kind":"Other"}' } },
    writer,
    OPERATION_KEY,
  );
  expect(drifted.status).toBe(409);

  const read = await call("GET", path, undefined, writer, OPERATION_KEY);
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual(preparedBody);

  const absent = await call(
    "GET",
    `/v1/takoform/worker-runtime-input-preparations/${"z".repeat(40)}`,
    undefined,
    writer,
    "z".repeat(40),
  );
  expect(absent.status).toBe(404);
  expect(await absent.json()).toMatchObject({ error: { code: "operation_not_found" } });

  expect((await call("DELETE", path, undefined, writer, OPERATION_KEY)).status).toBe(204);
  expect((await call("DELETE", path, undefined, writer, OPERATION_KEY)).status).toBe(204);
  expect((await call("GET", path, undefined, writer, OPERATION_KEY)).status).toBe(404);
  const [durable] = await sql.query(
    "SELECT state, sealed_payload FROM worker_runtime_input_preparations WHERE organization_id = ? AND operation_key = ?",
    [organizationId, OPERATION_KEY],
  );
  expect(durable).toEqual({ state: "revoked", sealed_payload: null });
});

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
    publicOrigin: HOST_ORIGIN,
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
  });

  const response = await app.fetch(
    new Request(`${HOST_ORIGIN}/v1/takoform/worker-runtime-input-preparations/${OPERATION_KEY}`, {
      method: "GET",
      headers: { "idempotency-key": OPERATION_KEY },
    }),
  );
  expect(response.status).toBe(404);
});

async function seedWorkerLifecycle(
  sql: ReturnType<typeof createEphemeralSql>,
  organizationId: string,
  now: number,
): Promise<void> {
  const resource = {
    apiVersion: WORKER_FORM_REF.apiVersion,
    kind: WORKER_FORM_REF.kind,
    form: { formRef: WORKER_FORM_REF },
    metadata: {
      name: CLAIM_TARGET.workerName,
      space: CLAIM_TARGET.space,
      uid: WORKER_RESOURCE_UID,
      generation: "1",
      revision: "1",
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
             '1', '1', ?, ?)`,
    [organizationId, WORKER_RESOURCE_UID, JSON.stringify(resource), now],
  );
  await sql.run(
    `INSERT INTO tf_resource_deployments
       (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
        provider_installation_ref, native_id, native_claimed, state,
        observed_json, outputs_json, created_at, updated_at)
     VALUES (?, 'deployment-worker-01', ?, ?, 'fake', 'fake.primary',
             'worker:native-01', 0, 'active', '{}', '{}', ?, ?)`,
    [organizationId, WORKER_RESOURCE_UID, OFFERING_ID, now, now],
  );
  await sql.run(
    `INSERT INTO tf_resource_deletion_attestations
       (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
        state, closure_fence, effects_json, evidence_json, evidence_ref,
        evidence_effect_digest, evidence_checked_at, evidence_status, created_at, updated_at)
     VALUES (?, ?, 'default', 'edge.forms.takoform.com', 'ModuleWorker', 'yurucommu', ?,
             'live', 1, '[]', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    [organizationId, WORKER_RESOURCE_UID, JSON.stringify(WORKER_FORM_REF), now, now],
  );
}
