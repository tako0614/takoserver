import { type BackendAdapter, BackendError, type BackendOffering } from "./backends.ts";
import type {
  InstalledTakoformForm,
  TakoformDriverReceipt,
  TakoformResourceDriver,
  TakoformStoredResource,
} from "./takoform/types.ts";

interface BoundBackendResource {
  readonly backend: BackendAdapter;
  readonly offering: BackendOffering;
  readonly nativeId: string;
}

/**
 * Connects the portable Takoform lifecycle to the provider-neutral backend
 * seam. The Host remains responsible for identity/fences/replay; this driver
 * owns backend selection and native identity only.
 */
export class BackendTakoformResourceDriver implements TakoformResourceDriver {
  readonly #backends: readonly BackendAdapter[];
  readonly #resources = new Map<string, BoundBackendResource>();

  constructor(backends: readonly BackendAdapter[]) {
    if (backends.length === 0) throw new TypeError("at least one backend is required");
    this.#backends = [...backends];
  }

  async apply(input: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly form: InstalledTakoformForm;
    readonly name: string;
    readonly space: string;
    readonly spec: import("./backends.ts").JsonObject;
    readonly previous?: TakoformStoredResource;
  }): Promise<TakoformDriverReceipt> {
    if (input.previous) throw new BackendError("invalid_request", false);
    const selection = await this.#select(input.form);
    const receipt = await selection.backend.perform({
      kind: "provision",
      operationId: input.operationId,
      offering: selection.offering,
      resource: {
        tenantRef: input.tenantId,
        name: input.name,
        space: input.space,
        spec: input.spec,
      },
    });
    this.#resources.set(resourceAddress(input), { ...selection, nativeId: receipt.nativeId });
    return { observed: receipt.observed, outputs: receipt.output };
  }

  async observe(input: {
    readonly tenantId: string;
    readonly resource: TakoformStoredResource;
  }): Promise<TakoformDriverReceipt> {
    const bound = this.#required(input.tenantId, input.resource);
    const receipt = await bound.backend.perform({
      kind: "observe",
      operationId: `observe:${input.resource.metadata.uid}:${input.resource.metadata.revision}`,
      offering: bound.offering,
      nativeId: bound.nativeId,
      resource: {
        tenantRef: input.tenantId,
        name: input.resource.metadata.name,
        space: input.resource.metadata.space,
        spec: input.resource.spec,
      },
    });
    return { observed: receipt.observed, outputs: receipt.output };
  }

  async delete(input: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly resource: TakoformStoredResource;
  }): Promise<void> {
    const key = resourceAddress({
      tenantId: input.tenantId,
      space: input.resource.metadata.space,
      name: input.resource.metadata.name,
      form: { identity: input.resource.form },
    });
    const bound = this.#resources.get(key);
    if (!bound) throw new BackendError("not_found", false);
    await bound.backend.perform({
      kind: "delete",
      operationId: input.operationId,
      offering: bound.offering,
      nativeId: bound.nativeId,
      resource: {
        tenantRef: input.tenantId,
        name: input.resource.metadata.name,
        space: input.resource.metadata.space,
        spec: input.resource.spec,
      },
    });
    this.#resources.delete(key);
  }

  async import(input: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly form: InstalledTakoformForm;
    readonly name: string;
    readonly space: string;
    readonly spec: import("./backends.ts").JsonObject;
    readonly nativeId: string;
  }): Promise<TakoformDriverReceipt> {
    const selection = await this.#select(input.form);
    const receipt = await selection.backend.perform({
      kind: "observe",
      operationId: input.operationId,
      offering: selection.offering,
      nativeId: input.nativeId,
      resource: {
        tenantRef: input.tenantId,
        name: input.name,
        space: input.space,
        spec: input.spec,
      },
    });
    this.#resources.set(resourceAddress(input), { ...selection, nativeId: receipt.nativeId });
    return { observed: receipt.observed, outputs: receipt.output };
  }

  async #select(form: InstalledTakoformForm): Promise<{
    readonly backend: BackendAdapter;
    readonly offering: BackendOffering;
  }> {
    const matches: { backend: BackendAdapter; offering: BackendOffering }[] = [];
    for (const backend of this.#backends) {
      for (const offering of await backend.discover()) {
        if (offering.available !== false && sameForm(offering, form)) {
          matches.push({ backend, offering });
        }
      }
    }
    if (matches.length !== 1) {
      throw new BackendError(matches.length === 0 ? "not_found" : "conflict", false);
    }
    return matches[0] as { backend: BackendAdapter; offering: BackendOffering };
  }

  #required(tenantId: string, resource: TakoformStoredResource): BoundBackendResource {
    const found = this.#resources.get(
      resourceAddress({
        tenantId,
        space: resource.metadata.space,
        name: resource.metadata.name,
        form: { identity: resource.form },
      }),
    );
    if (!found) throw new BackendError("not_found", false);
    return found;
  }
}

function sameForm(offering: BackendOffering, form: InstalledTakoformForm): boolean {
  const left = offering.form;
  const right = form.identity.formRef;
  return (
    left.apiVersion === right.apiVersion &&
    left.kind === right.kind &&
    left.definitionVersion === right.definitionVersion &&
    left.schemaDigest === right.schemaDigest
  );
}

function resourceAddress(input: {
  readonly tenantId: string;
  readonly space: string;
  readonly name: string;
  readonly form: Pick<InstalledTakoformForm, "identity">;
}): string {
  const ref = input.form.identity.formRef;
  return [
    input.tenantId,
    input.space,
    ref.apiVersion,
    ref.kind,
    ref.definitionVersion,
    ref.schemaDigest,
    input.name,
  ].join("\0");
}
