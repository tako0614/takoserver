import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { installedBindings } from "../src/takoform/bindings.ts";
import { installedForms } from "../src/takoform/forms.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import type { InstalledTakoformBinding, InstalledTakoformForm } from "../src/takoform/types.ts";
import { createConfiguredHistoricalTakoformHost as createTakoformHost } from "./helpers/historical-takoform-host.ts";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const candidateLane = "/apis/forms.takoform.com/v1beta4";

function form(requiresHostApi: string, definitionVersion = "0.1.0"): InstalledTakoformForm {
  return {
    identity: {
      formRef: {
        apiVersion: "edge.forms.takoform.com",
        kind: "ModuleWorker",
        definitionVersion,
        schemaDigest: digest(definitionVersion === "0.1.0" ? "1" : "2"),
      },
    },
    requiresHostApi,
    desiredSchema: { type: "object", additionalProperties: false },
    operations: ["create", "read", "delete", "import", "observe"],
  };
}

function candidateHost(installed: readonly InstalledTakoformForm[]) {
  return createTakoformHost({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
    forms: installed,
    driver: new InMemoryTakoformResourceDriver(),
    routes: {
      hostApiVersion: "forms.takoform.com/v1beta4",
      apiPath: candidateLane,
      supportProfileApiVersion: "support.takoform.com/v1alpha2",
      enumerateForms: true,
      exposeDefinitionConstraints: true,
      omitObservedStatus: true,
      bodyGenerationFence: true,
      reviewSpecDigest: true,
    },
  });
}

function request(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("authorization", "Bearer test");
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://candidate.invalid${path}`, {
    ...init,
    headers,
  });
}

describe("unpublished v1beta4 candidate installation", () => {
  test("accepts versionless family FormRefs and keeps definitionVersion independent of schemaDigest", () => {
    const registry = installedForms(
      [form("forms.takoform.com/v1beta1"), form("forms.takoform.com/v1beta4", "0.2.0")],
      "forms.takoform.com/v1beta4",
    );

    expect(registry.size).toBe(2);
  });

  test("refuses Host and envelope namespaces as versionless Form families", () => {
    for (const apiVersion of [
      "forms.takoform.com",
      "packages.forms.takoform.com",
      "trust.forms.takoform.com",
    ]) {
      const candidate = form("forms.takoform.com/v1beta4");
      expect(() =>
        installedForms(
          [
            {
              ...candidate,
              identity: { formRef: { ...candidate.identity.formRef, apiVersion } },
            },
          ],
          "forms.takoform.com/v1beta4",
        ),
      ).toThrow("invalid Form identity");
    }
  });

  test("treats requiresHostApi as an install-time lower bound", () => {
    expect(() =>
      installedForms([form("forms.takoform.com/v1beta5")], "forms.takoform.com/v1beta4"),
    ).toThrow(
      "Form ModuleWorker requires forms.takoform.com/v1beta5 but host implements forms.takoform.com/v1beta4",
    );
  });

  test("preserves candidate Binding v1alpha2 and versionless target identities", () => {
    const binding: InstalledTakoformBinding = {
      bindingRef: {
        apiVersion: "bindings.takoform.com/v1alpha2",
        name: "module-worker.kv-namespace",
        version: "1.0.0",
        schemaDigest: digest("3"),
      },
      sourceRole: "revision",
      targetInterface: {
        apiVersion: "interfaces.takoform.com/v1alpha1",
        name: "edge.kv",
        version: "1.0.0",
        schemaDigest: digest("4"),
      },
      allowedTargetForms: [{ apiVersion: "edge.forms.takoform.com", kind: "EdgeKVNamespace" }],
    };

    expect(installedBindings([binding]).values().next().value?.bindingRef).toEqual(
      binding.bindingRef,
    );
  });

  test("serves versionless family paths only on the explicitly composed candidate lane", async () => {
    const candidateForm = {
      ...form("forms.takoform.com/v1beta4"),
      constraints: [{ kind: "hostAssigned", output: "/hostname" }] as const,
      outputSchema: {
        type: "object",
        properties: { hostname: { type: "string" } },
        required: ["hostname"],
        additionalProperties: false,
      },
    };
    const host = candidateHost([candidateForm]);

    const listed = await host.handle(request(`${candidateLane}/forms?space=candidate`));
    expect(listed?.status).toBe(200);
    expect(await listed?.json()).toMatchObject({
      forms: [{ identity: { formRef: candidateForm.identity.formRef } }],
    });
    const retainedGroup = new URLSearchParams({
      space: "candidate",
      group: "edge.forms.takoform.com/v1beta1",
    });
    const noFallback = await host.handle(request(`${candidateLane}/forms?${retainedGroup}`));
    expect(noFallback?.status).toBe(200);
    expect(await noFallback?.json()).toEqual({ forms: [] });

    const query = new URLSearchParams({
      space: "candidate",
      group: candidateForm.identity.formRef.apiVersion,
      kind: candidateForm.identity.formRef.kind,
      definitionVersion: candidateForm.identity.formRef.definitionVersion,
      schemaDigest: candidateForm.identity.formRef.schemaDigest,
    });
    const definition = await host.handle(
      request(`${candidateLane}/form-definitions/edge.forms.takoform.com/ModuleWorker?${query}`),
    );
    expect(definition?.status).toBe(200);
    expect(await definition?.json()).toMatchObject({ constraints: candidateForm.constraints });

    expect(await host.handle(request("/apis/forms.takoform.com/v1/forms"))).toBeNull();
    expect(await host.handle(request("/apis/forms.takoform.com/v1alpha3/forms"))).toBeNull();
    expect(await host.handle(request(`${candidateLane}-shadow/forms`))).toBeNull();
  });

  test("accepts the candidate review specDigest echo without widening production defaults", async () => {
    const candidateForm = form("forms.takoform.com/v1beta4");
    const host = candidateHost([candidateForm]);
    const resource = {
      apiVersion: candidateForm.identity.formRef.apiVersion,
      kind: candidateForm.identity.formRef.kind,
      form: { formRef: candidateForm.identity.formRef },
      metadata: { name: "worker", space: "candidate" },
      spec: {},
    };
    const prepared = await host.handle(
      request(`${candidateLane}/resources/prepare`, {
        method: "POST",
        body: JSON.stringify(resource),
      }),
    );
    expect(prepared?.status).toBe(200);
    if (!prepared) throw new Error("candidate prepare was not routed");
    const review = ((await prepared.json()) as { review: Record<string, string> }).review;

    const applied = await host.handle(
      request(`${candidateLane}/resources/edge.forms.takoform.com/ModuleWorker/worker`, {
        method: "PUT",
        headers: { "idempotency-key": "candidate-create-0001", "if-none-match": "*" },
        body: JSON.stringify({ ...resource, review }),
      }),
    );
    expect(applied?.status).toBe(201);
    const created = (await applied?.json()) as { status: Record<string, unknown> };
    expect(created.status.observed).toBeUndefined();
  });
});
