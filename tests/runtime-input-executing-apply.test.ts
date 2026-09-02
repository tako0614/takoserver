import { expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { ProviderRuntimeInputPublicApply } from "../src/provider-runtime-input-port.ts";
import { runtimeInputPublicApplyCommitment } from "../src/runtime-input-preparations.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { DEFAULT_TAKOFORM_ROUTES } from "../src/takoform/routes.ts";
import type { InstalledTakoformForm, TakoformResourceDriver } from "../src/takoform/types.ts";
import { createConfiguredHistoricalTakoformHost } from "./helpers/historical-takoform-host.ts";

/**
 * The other half of the runtime-input claim fence.
 *
 * `claim` recomputes the executing apply's commitment and compares it with the
 * one the preparation stored, which is only a fence if the Host actually states
 * what it is executing. This proves the engine hands the driver the exact
 * request — method, path, `If-None-Match`, and the raw body bytes — and that
 * the commitment derived from it is the same string the released provider
 * computes over the request it sent.
 */

const LANE = "/apis/forms.takoform.com/v1";
const FORM: InstalledTakoformForm = {
  identity: {
    formRef: {
      apiVersion: "edge.forms.takoform.com",
      kind: "ObjectBucket",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"7".repeat(64)}`,
    },
  },
  requiresHostApi: "forms.takoform.com/v1",
  desiredSchema: { type: "object", additionalProperties: false },
  operations: ["create", "read", "update", "delete", "observe"],
};

function recordingHost(): {
  readonly host: ReturnType<typeof createConfiguredHistoricalTakoformHost>;
  readonly seen: { value?: ProviderRuntimeInputPublicApply };
} {
  const inner = new InMemoryTakoformResourceDriver();
  const seen: { value?: ProviderRuntimeInputPublicApply } = {};
  const driver: TakoformResourceDriver = {
    ...inner,
    apply: async (input) => {
      if (input.publicApply) seen.value = input.publicApply;
      return await inner.apply(input);
    },
    observe: (input) => inner.observe(input),
    delete: (input) => inner.delete(input),
  };
  return {
    seen,
    host: createConfiguredHistoricalTakoformHost({
      sql: createEphemeralSql(),
      objects: createMemoryObjectStore(),
      authenticate: async () => ({ tenantId: "org_01", principalId: "principal_01" }),
      forms: [FORM],
      driver,
      routes: DEFAULT_TAKOFORM_ROUTES,
    }),
  };
}

const resourceBody = (name: string) => ({
  apiVersion: FORM.identity.formRef.apiVersion,
  kind: FORM.identity.formRef.kind,
  form: { formRef: FORM.identity.formRef },
  metadata: { space: "default", name },
  spec: {},
});

test("hands the driver the exact apply a runtime-input commitment is checked against", async () => {
  const { host, seen } = recordingHost();
  const name = "media";
  const prepared = await host.handle(
    new Request(`https://host.invalid${LANE}/resources/prepare`, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify(resourceBody(name)),
    }),
  );
  if (!prepared) throw new TypeError("the stable Host did not handle prepare");
  expect(prepared.status).toBe(200);
  const review = ((await prepared.json()) as { review: { prepareDigest: string } }).review;

  const path = `${LANE}/resources/${FORM.identity.formRef.apiVersion}/${FORM.identity.formRef.kind}/${name}`;
  // The exact bytes a caller sends, kept as one string so the assertion below
  // compares what was transmitted rather than what re-serializing would give.
  const body = JSON.stringify({ ...resourceBody(name), review: { ...review } });
  const applied = await host.handle(
    new Request(`https://host.invalid${path}`, {
      method: "PUT",
      headers: {
        authorization: "Bearer test",
        "content-type": "application/json",
        "idempotency-key": `apply-${name}-0000000000`,
        "if-none-match": "*",
      },
      body,
    }),
  );
  expect(applied?.status).toBe(201);

  expect(seen.value).toEqual({ method: "PUT", path, ifNoneMatch: "*", body });
  // And the commitment over it is the cross-implementation one, so the caller's
  // own computation over the request it sent lands on the same string.
  expect(
    await runtimeInputPublicApplyCommitment({
      method: "PUT",
      path,
      fences: { ifNoneMatch: "*" },
      body,
    }),
  ).toBe(
    await runtimeInputPublicApplyCommitment({
      method: seen.value?.method as string,
      path: seen.value?.path as string,
      fences: { ifNoneMatch: seen.value?.ifNoneMatch as string },
      body: seen.value?.body as string,
    }),
  );
});
