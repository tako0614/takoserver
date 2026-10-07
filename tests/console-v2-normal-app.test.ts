import { afterEach, expect, test } from "bun:test";
import { createApi } from "../console/src/api.ts";
import { buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";

const ORIGIN = "https://api.takoserver.test";
const FORM = "https://forms.example.test/fixture-only/console-v2/1.0.0";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("console accepts a v2 Resource through the normal organization-authenticated app", async () => {
  const sql = createEphemeralSql();
  const objects = createMemoryObjectStore();
  const identity = {
    async verify({ assertion }: { assertion: string }) {
      return {
        providerSubject: assertion,
        email: `${assertion}@example.test`,
        displayName: assertion,
      };
    },
  };
  const accounts = createAccounts({ sql, identity });
  const signedIn = await accounts.signIn({ provider: "google", assertion: "owner" });
  const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
  if (!actor) throw new Error("fixture session did not authenticate");
  const organization = await accounts.createOrganization({ actor, name: "Console Org" });
  const otherSession = await accounts.signIn({ provider: "google", assertion: "other" });
  const otherActor = await accounts.authenticate(`Bearer ${otherSession.sessionToken}`);
  if (!otherActor) throw new Error("other fixture session did not authenticate");
  const otherOrganization = await accounts.createOrganization({
    actor: otherActor,
    name: "Other Org",
  });
  const app = buildApp({
    sql,
    objects,
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
    v2FormFactory: () => ({
      [FORM]: {
        validateCreate() {},
        validateUpdate() {},
        backend: {
          id: "console-v2-fixture",
          targetKey: "fixture-target",
          async execute(input) {
            return { kind: "complete", observed: input.spec, output: {} };
          },
          async reconcile(input) {
            return { kind: "complete", observed: input.spec, output: {} };
          },
        },
      },
    }),
  });
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return app.fetch(request);
    },
    { preconnect: originalFetch.preconnect },
  );
  const client = createApi({
    origin: ORIGIN,
    token: () => signedIn.sessionToken,
    onSessionLost: () => {
      throw new Error("valid session lost");
    },
  });

  const accepted = await client.createResource(
    organization.id,
    { form: FORM, space: organization.id, name: "widget", spec: { value: "one" } },
    "console-v2-create-0001",
  );
  expect(accepted).toMatchObject({ action: "create", status: "queued" });
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    "/apis/forms.takoform.com/v2/resources",
  ]);
  expect(await app.tickTakoformV2()).toMatchObject({ id: accepted.id, status: "succeeded" });
  expect(await client.resourceOperation(organization.id, accepted.id)).toMatchObject({
    id: accepted.id,
    status: "succeeded",
    effect: "complete",
  });
  const listed = await client.resources(organization.id);
  expect(listed.resources).toHaveLength(1);
  expect(listed.resources[0]).toMatchObject({
    uid: accepted.resourceUid,
    form: FORM,
    space: organization.id,
    generation: 1,
    observedGeneration: 1,
  });
  const found = await client.resource(organization.id, accepted.resourceUid);
  expect(found).toMatchObject({ name: "widget", observed: { value: "one" } });
  const replay = await client.createResource(
    organization.id,
    { form: FORM, space: organization.id, name: "widget", spec: { value: "one" } },
    "console-v2-create-0001",
  );
  expect(replay.id).toBe(accepted.id);
  const update = await client.updateResource(
    organization.id,
    accepted.resourceUid,
    found.generation,
    { value: "two" },
    "console-v2-update-0001",
  );
  expect(update).toMatchObject({ action: "update", status: "queued", generation: 2 });
  expect(await app.tickTakoformV2()).toMatchObject({ id: update.id, status: "succeeded" });
  const changed = await client.resource(organization.id, accepted.resourceUid);
  expect(changed).toMatchObject({
    generation: 2,
    observedGeneration: 2,
    observed: { value: "two" },
  });
  const foreign = createApi({
    origin: ORIGIN,
    token: () => otherSession.sessionToken,
    onSessionLost: () => {
      throw new Error("other session lost");
    },
  });
  expect((await foreign.resources(otherOrganization.id)).resources).toHaveLength(0);
  await expect(foreign.resource(otherOrganization.id, accepted.resourceUid)).rejects.toMatchObject({
    status: 404,
  });
  const deletion = await client.deleteResource(
    organization.id,
    accepted.resourceUid,
    changed.generation,
    "console-v2-delete-0001",
  );
  expect(deletion).toMatchObject({ action: "delete", status: "queued" });
  expect(await app.tickTakoformV2()).toMatchObject({ id: deletion.id, status: "succeeded" });
  await expect(client.resource(organization.id, accepted.resourceUid)).rejects.toMatchObject({
    status: 410,
    code: "gone",
  });
  expect((await client.resources(organization.id)).resources).toHaveLength(0);
});
