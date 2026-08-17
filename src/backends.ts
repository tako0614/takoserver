import type { ExactFormRef, OfferingPrice, ServiceAllowance } from "./contracts.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export interface BackendOffering {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly form: ExactFormRef;
  readonly price: OfferingPrice;
  readonly allowances: readonly ServiceAllowance[];
  readonly available?: boolean;
}

export interface BackendAdapter {
  readonly id: string;
  discover(): Promise<readonly BackendOffering[]>;
  perform(operation: BackendOperation): Promise<BackendReceipt>;
}

export type BackendOperation =
  | {
      readonly kind: "provision";
      readonly operationId: string;
      readonly offering: BackendOffering;
      readonly resource: {
        readonly tenantRef: string;
        readonly name: string;
        readonly space: string;
        readonly spec: JsonObject;
      };
    }
  | {
      readonly kind: "observe" | "delete";
      readonly operationId: string;
      readonly offering: BackendOffering;
      readonly nativeId: string;
      readonly resource: {
        readonly tenantRef: string;
        readonly name: string;
        readonly space: string;
        readonly spec: JsonObject;
      };
    };

export interface BackendReceipt {
  readonly nativeId: string;
  readonly observed: JsonObject;
  readonly output: JsonObject;
}

export class BackendError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "conflict"
      | "not_found"
      | "unavailable"
      | "invalid_response",
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "BackendError";
  }
}

export class PortableFakeBackend implements BackendAdapter {
  readonly id: string;
  readonly #offerings: readonly BackendOffering[];
  readonly #resources = new Map<
    string,
    BackendReceipt & { readonly name: string; readonly space: string; readonly offeringId: string }
  >();
  readonly #operations = new Map<
    string,
    { readonly fingerprint: string; readonly receipt: BackendReceipt }
  >();

  constructor(id: string, offerings: readonly BackendOffering[]) {
    if (id.length === 0) throw new TypeError("backend id is required");
    this.id = id;
    this.#offerings = structuredClone(offerings);
  }

  async discover(): Promise<readonly BackendOffering[]> {
    return structuredClone(this.#offerings);
  }

  async perform(operation: BackendOperation): Promise<BackendReceipt> {
    if (!this.#offerings.some((offering) => offering.id === operation.offering.id)) {
      throw new BackendError("not_found", false);
    }
    const fingerprint = JSON.stringify({
      kind: operation.kind,
      offeringId: operation.offering.id,
      ...(operation.kind === "provision" ? {} : { nativeId: operation.nativeId }),
      resource: operation.resource,
    });
    const replay = this.#operations.get(operation.operationId);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new BackendError("conflict", false);
      return structuredClone(replay.receipt);
    }
    const resourceKey = `${operation.resource.tenantRef}/${operation.resource.space}/${operation.resource.name}`;
    if (operation.kind === "observe") {
      const resource = this.#resources.get(resourceKey);
      if (!resource || resource.nativeId !== operation.nativeId) {
        throw new BackendError("not_found", false);
      }
      return structuredClone(resource);
    }
    if (operation.kind === "delete") {
      const resource = this.#resources.get(resourceKey);
      if (resource && resource.nativeId !== operation.nativeId) {
        throw new BackendError("conflict", false);
      }
      this.#resources.delete(resourceKey);
      const receipt: BackendReceipt = {
        nativeId: operation.nativeId,
        observed: { deleted: true },
        output: {},
      };
      this.#operations.set(operation.operationId, { fingerprint, receipt });
      return structuredClone(receipt);
    }
    if (this.#resources.has(resourceKey)) throw new BackendError("conflict", false);
    const receipt: BackendReceipt = {
      nativeId: `${this.id}:${resourceKey}`,
      observed: structuredClone(operation.resource.spec),
      output: { resourceUri: `fake://${this.id}/${resourceKey}` },
    };
    this.#resources.set(resourceKey, {
      ...receipt,
      name: operation.resource.name,
      space: operation.resource.space,
      offeringId: operation.offering.id,
    });
    this.#operations.set(operation.operationId, { fingerprint, receipt });
    return structuredClone(receipt);
  }

  listResources(): readonly BackendReceipt[] {
    return [...this.#resources.values()].map((resource) => structuredClone(resource));
  }
}
