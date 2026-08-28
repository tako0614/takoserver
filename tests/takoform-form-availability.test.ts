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
  },
  desiredSchema: { type: "object", additionalProperties: false },
  operations: ["create", "read", "delete"],
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
        identity: form.identity,
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
      "https://host.invalid/apis/forms.takoform.com/v1/form-definitions/function.forms.takoform.com/Function?space=main&group=function.forms.takoform.com&kind=Function&definitionVersion=0.1.0&schemaDigest=" +
        encodeURIComponent(form.identity.formRef.schemaDigest),
      { headers },
    ),
  );
  expect(definition?.status).toBe(200);
  expect(await definition?.json()).toMatchObject({ identity: form.identity });

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
