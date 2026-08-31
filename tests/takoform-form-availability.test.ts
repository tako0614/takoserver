import { expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import type { InstalledTakoformForm } from "../src/takoform/types.ts";
import { createStaticStableTestTakoformHost as createTakoformHost } from "./helpers/historical-takoform-host.ts";

const form: InstalledTakoformForm = {
  identity: {
    formRef: {
      apiVersion: "function.forms.takoform.com",
      kind: "Function",
      definitionVersion: "0.1.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
    },
    packageDigest: `sha256:${"b".repeat(64)}`,
    implementationDigest: `sha256:${"c".repeat(64)}`,
  },
  desiredSchema: { type: "object", additionalProperties: false },
  operations: ["create", "read", "delete", "observe"],
};

const portableIdentity = {
  formRef: form.identity.formRef,
  packageDigest: form.identity.packageDigest,
};

test("an unsupported installed Definition stays discoverable but is not advertised executable", async () => {
  const host = createTakoformHost({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
    forms: [form],
    driver: new InMemoryTakoformResourceDriver(),
    availability: {
      async resolve() {
        return { executable: false, activated: false, availableToPrincipal: false };
      },
    },
  });
  const headers = { authorization: "Bearer primary" };
  const listed = await host.handle(
    new Request("https://host.invalid/apis/forms.takoform.com/v1/forms?space=main", { headers }),
  );
  expect(listed?.status).toBe(200);
  expect(await listed?.json()).toEqual({
    forms: [
      {
        identity: portableIdentity,
        definitionKnown: true,
        installed: true,
        executable: false,
        activated: false,
        availableToPrincipal: false,
        operations: form.operations,
      },
    ],
  });

  const definition = await host.handle(
    new Request(
      "https://host.invalid/apis/forms.takoform.com/v1/form-definitions/function.forms.takoform.com/Function?space=main&definitionVersion=0.1.0&schemaDigest=" +
        encodeURIComponent(form.identity.formRef.schemaDigest),
      { headers },
    ),
  );
  expect(definition?.status).toBe(200);
  const definitionBody = (await definition?.json()) as {
    readonly identity: unknown;
  };
  expect(definitionBody.identity).toEqual(portableIdentity);

  const prepared = await host.handle(
    new Request("https://host.invalid/apis/forms.takoform.com/v1/resources/prepare", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        apiVersion: form.identity.formRef.apiVersion,
        kind: form.identity.formRef.kind,
        form: { formRef: form.identity.formRef },
        metadata: { name: "unbacked", space: "main" },
        spec: {},
      }),
    }),
  );
  expect(prepared?.status).toBe(503);
  expect(await prepared?.json()).toMatchObject({ error: { code: "form_unavailable" } });
});

test("stable Host v1 keeps implementation authority out of every resource wire view", async () => {
  const host = createTakoformHost({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
    forms: [form],
    driver: new InMemoryTakoformResourceDriver(),
    availability: {
      async resolve() {
        return { executable: true, activated: true, availableToPrincipal: true };
      },
    },
  });
  const headers = {
    authorization: "Bearer primary",
    "content-type": "application/json",
  };
  const resource = {
    apiVersion: form.identity.formRef.apiVersion,
    kind: form.identity.formRef.kind,
    form: portableIdentity,
    metadata: { name: "portable", space: "main" },
    spec: {},
  };
  const prepared = await host.handle(
    new Request("https://host.invalid/apis/forms.takoform.com/v1/resources/prepare", {
      method: "POST",
      headers,
      body: JSON.stringify(resource),
    }),
  );
  expect(prepared?.status).toBe(200);
  const preparedBody = (await prepared?.json()) as {
    readonly resource: { readonly form: unknown };
    readonly review: Record<string, string>;
  };
  expect(preparedBody.resource.form).toEqual(portableIdentity);

  const target =
    "https://host.invalid/apis/forms.takoform.com/v1/resources/function.forms.takoform.com/Function/portable";
  const created = await host.handle(
    new Request(target, {
      method: "PUT",
      headers: {
        ...headers,
        "idempotency-key": "create-portable-0001",
        "if-none-match": "*",
      },
      body: JSON.stringify({ ...resource, review: preparedBody.review }),
    }),
  );
  expect(created?.status).toBe(201);
  const createdBody = (await created?.json()) as { readonly form: unknown };
  expect(createdBody.form).toEqual(portableIdentity);

  const query = new URLSearchParams({
    space: "main",
    definitionVersion: form.identity.formRef.definitionVersion,
    schemaDigest: form.identity.formRef.schemaDigest,
  });
  const read = await host.handle(new Request(`${target}?${query}`, { headers }));
  expect(read?.status).toBe(200);
  const readBody = (await read?.json()) as { readonly form: unknown };
  expect(readBody.form).toEqual(portableIdentity);

  const observed = await host.handle(
    new Request(`${target}/observe?${query}`, {
      method: "POST",
      headers: {
        ...headers,
        "idempotency-key": "observe-portable-0001",
        "takoform-expected-generation": "1",
      },
    }),
  );
  expect(observed?.status).toBe(200);
  const observedBody = (await observed?.json()) as {
    readonly resource: { readonly form: unknown };
  };
  expect(observedBody.resource.form).toEqual(portableIdentity);
});
