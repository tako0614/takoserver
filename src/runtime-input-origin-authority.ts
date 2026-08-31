import { STABLE_PRODUCTION_TAKOFORM_CATALOG } from "./generated/takoform-stable-v1-catalog.ts";
import type { RuntimeInputOriginAuthority } from "./runtime-input-preparations.ts";
import type { TakoformStore } from "./takoform/store.ts";

const ORIGIN_FORM_REFS = STABLE_PRODUCTION_TAKOFORM_CATALOG.forms
  .filter(
    (form) =>
      form.identity.formRef.kind === "WorkerEndpoint" ||
      form.identity.formRef.kind === "WorkerCustomDomain",
  )
  .map((form) => form.identity.formRef);

/**
 * Resolves an application origin from Takoserver's own durable Resource
 * inventory. A preparation may name the Resource, but it may not assert what
 * origin that Resource realizes.
 */
export function createTakoformRuntimeInputOriginAuthority(
  resources: Pick<TakoformStore, "resourceWithRelationsByUid">,
): RuntimeInputOriginAuthority {
  return {
    async resolve(input) {
      const snapshot = await resources.resourceWithRelationsByUid(
        input.organizationId,
        input.resourceUid,
      );
      if (!snapshot) return null;
      const { listing, relations } = snapshot;
      const resource = listing.resource;
      if (
        listing.uid !== input.resourceUid ||
        listing.space !== input.space ||
        resource.metadata.uid !== listing.uid ||
        resource.metadata.space !== listing.space ||
        resource.metadata.name !== listing.name ||
        resource.metadata.generation !== listing.generation ||
        resource.metadata.revision !== listing.revision ||
        resource.kind !== listing.kind ||
        resource.form.formRef.kind !== resource.kind ||
        resource.form.formRef.apiVersion !== resource.apiVersion ||
        !ORIGIN_FORM_REFS.some((formRef) => sameFormRef(formRef, resource.form.formRef)) ||
        resource.status.observedGeneration !== resource.metadata.generation ||
        !canonicalRevision(listing.revision) ||
        !resource.status.conditions.some(
          (condition) => condition.type === "Ready" && condition.status === "True",
        )
      ) {
        return null;
      }

      const worker = object(resource.spec.worker);
      if (
        worker?.kind !== "ModuleWorker" ||
        worker.name !== input.workerName ||
        worker.apiVersion !== "edge.forms.takoform.com"
      ) {
        return null;
      }
      const workerRelations = relations.filter(
        (relation) => relation.pointer === "/worker" && relation.relation === "/worker",
      );
      if (
        workerRelations.length !== 1 ||
        workerRelations[0]?.targetKind !== "ModuleWorker" ||
        workerRelations[0].targetName !== input.workerName ||
        workerRelations[0].targetUid !== input.workerResourceUid
      ) {
        return null;
      }

      if (resource.kind === "WorkerEndpoint") {
        const outputs = resource.status.outputs;
        const hostname = outputs?.hostname;
        const url = outputs?.url;
        if (typeof hostname !== "string" || typeof url !== "string") return null;
        const parsed = exactHttpsRoot(url);
        if (!parsed || parsed.hostname !== hostname || hostname !== hostname.toLowerCase()) {
          return null;
        }
        return { canonicalPublicOrigin: parsed.origin, resourceRevision: listing.revision };
      }

      if (resource.kind === "WorkerCustomDomain") {
        const declared = resource.spec.hostname;
        if (typeof declared !== "string") return null;
        const hostname = declared.toLowerCase().replace(/\.$/u, "");
        if (hostname !== declared) return null;
        const parsed = exactHttpsRoot(`https://${hostname}/`);
        return parsed
          ? { canonicalPublicOrigin: parsed.origin, resourceRevision: listing.revision }
          : null;
      }

      return null;
    },
  };
}

function sameFormRef(
  left: (typeof ORIGIN_FORM_REFS)[number],
  right: {
    readonly apiVersion: string;
    readonly kind: string;
    readonly definitionVersion: string;
    readonly schemaDigest: string;
  },
): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.kind === right.kind &&
    left.definitionVersion === right.definitionVersion &&
    left.schemaDigest === right.schemaDigest
  );
}

function exactHttpsRoot(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.port === "" &&
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    value === `${parsed.origin}/`
    ? parsed
    : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalRevision(value: string): boolean {
  return /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
}
