import { expect, test } from "bun:test";
import { buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const ORIGIN = "https://api.takoserver.test";
const FORM = "https://forms.example.test/fixture-only/composed-resource/1.0.0";
const ROOT = "/apis/forms.takoform.com/v2";

test("normal app composes one exact v2 Form for authenticated HTTP and reconstructed execution", async () => {
  const sql = createEphemeralSql();
  const objects = createMemoryObjectStore();
  const clock = () => new Date("2026-10-07T12:00:00.000Z");
  const identity = {
    async verify({ assertion }: { assertion: string }) {
      return {
        providerSubject: assertion,
        email: `${assertion}@example.test`,
        displayName: assertion,
      };
    },
  };
  const accounts = createAccounts({ sql, identity, clock });
  const ownerSession = await accounts.signIn({ provider: "google", assertion: "owner" });
  const owner = await accounts.authenticate(`Bearer ${ownerSession.sessionToken}`);
  if (!owner) throw new Error("fixture owner did not authenticate");
  const organization = await accounts.createOrganization({ actor: owner, name: "Owner Org" });
  const otherSession = await accounts.signIn({ provider: "google", assertion: "other" });
  const other = await accounts.authenticate(`Bearer ${otherSession.sessionToken}`);
  if (!other) throw new Error("fixture other owner did not authenticate");
  const otherOrganization = await accounts.createOrganization({ actor: other, name: "Other Org" });
  const writer = await accounts.createApiKey({
    actor: owner,
    organizationId: organization.id,
    name: "writer",
    scopes: ["resources:write"],
    expiresInSeconds: 3_600,
  });
  const reader = await accounts.createApiKey({
    actor: owner,
    organizationId: organization.id,
    name: "reader",
    scopes: ["resources:read"],
    expiresInSeconds: 3_600,
  });
  const foreignWriter = await accounts.createApiKey({
    actor: other,
    organizationId: otherOrganization.id,
    name: "foreign writer",
    scopes: ["resources:write"],
    expiresInSeconds: 3_600,
  });
  const form: V2Form = {
    validateCreate(spec) {
      if (typeof spec.value !== "string") throw new TypeError("fixture value must be a string");
    },
    validateUpdate(_previous, spec) {
      if (typeof spec.value !== "string") throw new TypeError("fixture value must be a string");
    },
    backend: {
      id: "fixture-composed-v2-backend",
      targetKey: "fixture-composed-target",
      async execute(input) {
        return { kind: "complete", observed: { value: input.spec.value ?? null }, output: {} };
      },
      async reconcile(input) {
        return { kind: "complete", observed: { value: input.spec.value ?? null }, output: {} };
      },
    },
  };
  const selected: Record<string, V2Form> = { [FORM]: form };
  let compositions = 0;
  const makeApp = () =>
    buildApp({
      sql,
      objects,
      clock,
      identity,
      settlement: {
        async verify() {
          throw new Error("not configured");
        },
      },
      publicOrigin: ORIGIN,
      forms: [],
      hostForms: [],
      driver: new InMemoryTakoformResourceDriver(),
      offerings: [],
      v2: {
        cursorSigningKey: new Uint8Array(32).fill(0x5a),
        documentation: "https://docs.example.test/takoform-v2",
        authenticationDocumentation: "https://docs.example.test/takoform-v2/authentication",
      },
      v2FormFactory(context) {
        expect(context.sql).toBe(sql);
        expect(context.objects).toBe(objects);
        expect(context.clock).toBe(clock);
        compositions += 1;
        return selected;
      },
    });
  const request = (
    app: ReturnType<typeof buildApp>,
    path: string,
    key: string,
    init: RequestInit = {},
  ) =>
    app.fetch(
      new Request(`${ORIGIN}${ROOT}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${key}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
      }),
    );

  const first = makeApp();
  expect(compositions).toBe(1);
  const support = await request(first, `/support?form=${encodeURIComponent(FORM)}`, writer.secret);
  expect(support.status).toBe(200);
  expect(await support.json()).toMatchObject({ form: FORM, supported: true });
  delete selected[FORM];
  expect(
    await (await request(first, `/support?form=${encodeURIComponent(FORM)}`, writer.secret)).json(),
  ).toMatchObject({ form: FORM, supported: true });
  const created = await request(first, "/resources", writer.secret, {
    method: "POST",
    headers: { "idempotency-key": "composed-create-key-0001" },
    body: JSON.stringify({
      form: FORM,
      space: organization.id,
      name: "composed",
      spec: { value: "one" },
    }),
  });
  expect(created.status).toBe(202);
  const accepted = (await created.json()) as { id: string; resourceUid: string };
  expect((await request(first, `/operations/${accepted.id}`, reader.secret)).status).toBe(200);
  expect(
    (await request(first, `/resources/${accepted.resourceUid}`, foreignWriter.secret)).status,
  ).toBe(404);
  expect(
    (
      await request(first, `/resources/${accepted.resourceUid}`, reader.secret, {
        method: "PUT",
        headers: {
          "idempotency-key": "reader-update-key-0001",
          "takoform-expected-generation": "1",
        },
        body: JSON.stringify({ spec: { value: "not allowed" } }),
      })
    ).status,
  ).toBe(403);

  selected[FORM] = form;
  const second = makeApp();
  expect(compositions).toBe(2);
  delete selected[FORM];
  expect(await second.tickTakoformV2()).toMatchObject({ id: accepted.id, status: "succeeded" });
  const replay = await request(second, "/resources", writer.secret, {
    method: "POST",
    headers: { "idempotency-key": "composed-create-key-0001" },
    body: JSON.stringify({
      form: FORM,
      space: organization.id,
      name: "composed",
      spec: { value: "one" },
    }),
  });
  expect((await replay.json()).id).toBe(accepted.id);
  expect(
    await (await request(second, `/resources/${accepted.resourceUid}`, reader.secret)).json(),
  ).toMatchObject({ observed: { value: "one" } });
  const updated = await request(second, `/resources/${accepted.resourceUid}`, writer.secret, {
    method: "PUT",
    headers: { "idempotency-key": "composed-update-key-0001", "takoform-expected-generation": "1" },
    body: JSON.stringify({ spec: { value: "two" } }),
  });
  expect(updated.status).toBe(202);
  const updateOperation = (await updated.json()) as { id: string };
  expect(await second.tickTakoformV2()).toMatchObject({
    id: updateOperation.id,
    status: "succeeded",
  });
  expect(
    await (await request(second, `/resources/${accepted.resourceUid}`, reader.secret)).json(),
  ).toMatchObject({ observed: { value: "two" } });
  const deleted = await request(second, `/resources/${accepted.resourceUid}`, writer.secret, {
    method: "DELETE",
    headers: { "idempotency-key": "composed-delete-key-0001", "takoform-expected-generation": "2" },
  });
  expect(deleted.status).toBe(202);
  const deleteOperation = (await deleted.json()) as { id: string };
  expect(await second.tickTakoformV2()).toMatchObject({
    id: deleteOperation.id,
    status: "succeeded",
  });
  expect((await request(second, `/resources/${accepted.resourceUid}`, writer.secret)).status).toBe(
    410,
  );
  await accounts.revokeApiKey({
    actor: owner,
    organizationId: organization.id,
    apiKeyId: writer.apiKey.id,
  });
  expect((await request(second, `/operations/${accepted.id}`, writer.secret)).status).toBe(401);
});

test("operator Form composition refuses built-in overrides and malformed maps before serving", () => {
  const sql = createEphemeralSql();
  const objects = createMemoryObjectStore();
  const complete: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    backend: {
      id: "fixture-composed-v2-backend",
      targetKey: "fixture-composed-target",
      async execute() {
        return { kind: "complete", observed: {}, output: {} };
      },
      async reconcile() {
        return { kind: "complete", observed: {}, output: {} };
      },
    },
  };
  const base = {
    sql,
    objects,
    identity: {
      async verify() {
        return { providerSubject: "x", email: "x@example.test", displayName: "x" };
      },
    },
    settlement: {
      async verify() {
        throw new Error("not configured");
      },
    },
    publicOrigin: ORIGIN,
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
    v2: {
      cursorSigningKey: new Uint8Array(32).fill(0x5a),
      documentation: "https://docs.example.test/takoform-v2",
      authenticationDocumentation: "https://docs.example.test/takoform-v2/authentication",
      workerBundle: { targetKey: "fixture-bundle-target", heldArtifacts: [] },
    },
  };
  expect(() =>
    buildApp({ ...base, v2FormFactory: () => ({ [WORKER_BUNDLE_FORM_URL]: complete }) }),
  ).toThrow("duplicate v2 Form URL");
  expect(() =>
    buildApp({ ...base, v2FormFactory: () => ({ "not-a-form-url": complete }) }),
  ).toThrow("Form keys must be exact absolute HTTPS Form URLs");
  expect(() =>
    buildApp({ ...base, v2FormFactory: () => new Map() as unknown as Record<string, V2Form> }),
  ).toThrow("v2 Form factory must return a plain exact Form map");
  expect(() =>
    buildApp({ ...base, v2FormFactory: null as unknown as () => Record<string, V2Form> }),
  ).toThrow("v2 Form factory must be a function");
  expect(() =>
    buildApp({
      ...base,
      v2FormFactory: () => ({ [FORM]: { ...complete, backend: undefined } as unknown as V2Form }),
    }),
  ).toThrow("v2 Form factory returned an incomplete backend");
});
