import { expect, test } from "bun:test";
import type { TakoformV1Alpha3FormRef } from "../src/form-ref.ts";
import { STABLE_PRODUCTION_TAKOFORM_CATALOG } from "../src/generated/takoform-stable-v1-catalog.ts";
import { createTakoformRuntimeInputOriginAuthority } from "../src/index.ts";
import type { JsonObject } from "../src/ports.ts";
import type { TakoformStoredRelation } from "../src/takoform/relations.ts";
import type { ResourceWithRelations } from "../src/takoform/store.ts";
import type { TakoformCondition, TakoformStoredResource } from "../src/takoform/types.ts";

const ORGANIZATION_ID = "org_runtime_inputs";
const SPACE = "public";
const WORKER_NAME = "community";
const WORKER_RESOURCE_UID = "worker_uid_01";
const ORIGIN_RESOURCE_UID = "origin_uid_01";
const ORIGIN_RESOURCE_NAME = "community-endpoint";
const ENDPOINT_HOSTNAME = "community.example.test";
const CUSTOM_DOMAIN_HOSTNAME = "app.example.test";

type OriginKind = "WorkerEndpoint" | "WorkerCustomDomain";
type ResolutionInput = Parameters<
  ReturnType<typeof createTakoformRuntimeInputOriginAuthority>["resolve"]
>[0];

const BASE_INPUT: ResolutionInput = {
  organizationId: ORGANIZATION_ID,
  resourceUid: ORIGIN_RESOURCE_UID,
  space: SPACE,
  workerName: WORKER_NAME,
  workerResourceUid: WORKER_RESOURCE_UID,
};

test("derives the canonical origin from an exact released WorkerEndpoint", async () => {
  const authority = authorityFor(originSnapshot("WorkerEndpoint"));

  await expect(authority.resolve(BASE_INPUT)).resolves.toEqual({
    canonicalPublicOrigin: "https://community.example.test",
    resourceRevision: "9",
  });
});

test("derives the canonical origin from an exact released WorkerCustomDomain", async () => {
  const authority = authorityFor(originSnapshot("WorkerCustomDomain"));

  await expect(authority.resolve(BASE_INPUT)).resolves.toEqual({
    canonicalPublicOrigin: "https://app.example.test",
    resourceRevision: "9",
  });
});

test("rejects a Resource whose FormRef is not the exact released origin FormRef", async () => {
  const endpoint = originSnapshot("WorkerEndpoint");
  const changedRefs: readonly ((formRef: TakoformV1Alpha3FormRef) => TakoformV1Alpha3FormRef)[] = [
    (formRef) => ({ ...formRef, definitionVersion: "9.9.9" }),
    (formRef) => ({ ...formRef, schemaDigest: `sha256:${"f".repeat(64)}` }),
  ];

  for (const changeFormRef of changedRefs) {
    const changed = replaceResource(endpoint, (resource) => ({
      ...resource,
      form: {
        ...resource.form,
        formRef: changeFormRef(resource.form.formRef),
      },
    }));
    await expect(authorityFor(changed).resolve(BASE_INPUT)).resolves.toBeNull();
  }
});

test("rejects a released origin Resource from another space", async () => {
  await expect(
    authorityFor(originSnapshot("WorkerEndpoint")).resolve({
      ...BASE_INPUT,
      space: "private",
    }),
  ).resolves.toBeNull();
});

test("rejects a released origin Resource when the worker UID or name is wrong", async () => {
  const authority = authorityFor(originSnapshot("WorkerEndpoint"));

  await expect(
    authority.resolve({
      ...BASE_INPUT,
      workerResourceUid: "different_worker_uid",
    }),
  ).resolves.toBeNull();
  await expect(
    authority.resolve({
      ...BASE_INPUT,
      workerName: "different-worker",
    }),
  ).resolves.toBeNull();
});

test("rejects malformed or incoherent WorkerEndpoint outputs", async () => {
  const malformedOutputs: readonly (readonly [string, JsonObject])[] = [
    ["missing hostname", { url: `https://${ENDPOINT_HOSTNAME}/` }],
    ["missing URL", { hostname: ENDPOINT_HOSTNAME }],
    ["plaintext URL", { hostname: ENDPOINT_HOSTNAME, url: `http://${ENDPOINT_HOSTNAME}/` }],
    ["non-root URL", { hostname: ENDPOINT_HOSTNAME, url: `https://${ENDPOINT_HOSTNAME}/path` }],
    ["hostname mismatch", { hostname: "other.example.test", url: `https://${ENDPOINT_HOSTNAME}/` }],
    [
      "explicit default port",
      { hostname: ENDPOINT_HOSTNAME, url: `https://${ENDPOINT_HOSTNAME}:443/` },
    ],
  ];

  for (const [, outputs] of malformedOutputs) {
    const changed = replaceResource(originSnapshot("WorkerEndpoint"), (resource) => ({
      ...resource,
      status: { ...resource.status, outputs },
    }));
    await expect(authorityFor(changed).resolve(BASE_INPUT)).resolves.toBeNull();
  }
});

test("does not treat an arbitrary URL-like Resource as an application origin", async () => {
  const changed = replaceResource(originSnapshot("WorkerEndpoint"), (resource) => ({
    ...resource,
    kind: "ArbitraryUrlResource",
    form: {
      ...resource.form,
      formRef: {
        ...resource.form.formRef,
        kind: "ArbitraryUrlResource",
      },
    },
  }));

  await expect(authorityFor(changed).resolve(BASE_INPUT)).resolves.toBeNull();
});

test("rejects an origin Resource that is not Ready", async () => {
  const nonReadyConditions: readonly (readonly TakoformCondition[])[] = [
    [condition("Ready", "False", "Provisioning")],
    [condition("Reconciling", "True", "Reconciling")],
    [],
  ];

  for (const conditions of nonReadyConditions) {
    const changed = replaceResource(originSnapshot("WorkerEndpoint"), (resource) => ({
      ...resource,
      status: { ...resource.status, conditions },
    }));
    await expect(authorityFor(changed).resolve(BASE_INPUT)).resolves.toBeNull();
  }
});

function authorityFor(snapshot: ResourceWithRelations | null) {
  return createTakoformRuntimeInputOriginAuthority({
    async resourceWithRelationsByUid(organizationId, resourceUid) {
      return organizationId === ORGANIZATION_ID && resourceUid === ORIGIN_RESOURCE_UID
        ? snapshot
        : null;
    },
  });
}

function originSnapshot(kind: OriginKind): ResourceWithRelations {
  const formRef = releasedFormRef(kind);
  const workerFormRef = releasedFormRef("ModuleWorker");
  const generation = "4";
  const worker = {
    apiVersion: workerFormRef.apiVersion,
    kind: workerFormRef.kind,
    name: WORKER_NAME,
  } as const;
  const resource: TakoformStoredResource = {
    apiVersion: formRef.apiVersion,
    kind,
    form: { formRef },
    metadata: {
      name: ORIGIN_RESOURCE_NAME,
      space: SPACE,
      uid: ORIGIN_RESOURCE_UID,
      generation,
      revision: "9",
    },
    spec: {
      worker,
      ...(kind === "WorkerCustomDomain" ? { hostname: CUSTOM_DOMAIN_HOSTNAME } : {}),
    },
    status: {
      observedGeneration: generation,
      conditions: [condition("Ready", "True", "Available")],
      ...(kind === "WorkerEndpoint"
        ? {
            outputs: {
              hostname: ENDPOINT_HOSTNAME,
              url: `https://${ENDPOINT_HOSTNAME}/`,
            },
          }
        : {}),
    },
  };
  const relation: TakoformStoredRelation = {
    pointer: "/worker",
    relation: "/worker",
    targetApiVersion: workerFormRef.apiVersion,
    targetKind: workerFormRef.kind,
    targetName: WORKER_NAME,
    targetUid: WORKER_RESOURCE_UID,
    targetFormRef: workerFormRef,
  };
  return {
    listing: {
      space: SPACE,
      apiVersion: resource.apiVersion,
      kind: resource.kind,
      name: resource.metadata.name,
      uid: resource.metadata.uid,
      generation,
      revision: resource.metadata.revision,
      updatedAt: "2026-08-31T18:00:00.000Z",
      resource,
    },
    relations: [relation],
  };
}

function replaceResource(
  snapshot: ResourceWithRelations,
  mutate: (resource: TakoformStoredResource) => TakoformStoredResource,
): ResourceWithRelations {
  const resource = mutate(snapshot.listing.resource);
  return {
    ...snapshot,
    listing: {
      ...snapshot.listing,
      apiVersion: resource.apiVersion,
      kind: resource.kind,
      name: resource.metadata.name,
      space: resource.metadata.space,
      uid: resource.metadata.uid,
      generation: resource.metadata.generation,
      revision: resource.metadata.revision,
      resource,
    },
  };
}

function releasedFormRef(kind: string): TakoformV1Alpha3FormRef {
  const form = STABLE_PRODUCTION_TAKOFORM_CATALOG.forms.find(
    (candidate) => candidate.identity.formRef.kind === kind,
  );
  if (!form) throw new Error(`missing released FormRef: ${kind}`);
  return form.identity.formRef as TakoformV1Alpha3FormRef;
}

function condition(
  type: TakoformCondition["type"],
  status: TakoformCondition["status"],
  reason: TakoformCondition["reason"],
): TakoformCondition {
  return {
    type,
    status,
    reason,
    lastTransitionTime: "2026-08-31T18:00:00.000Z",
  };
}
