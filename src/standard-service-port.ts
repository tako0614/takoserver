import type { JsonObject } from "./ports.ts";

/** Complete opaque identity supplied by the stable Host standard-service lane. */
export interface StandardServiceRef {
  readonly apiVersion: string;
  readonly protocol: string;
}

/**
 * Host-owned backend supply. Adapters return sealed runtime material and never
 * portable resource state; the domain maps this port onto Takoform slots.
 * There is deliberately no Resource-scoped delete: service lifetime and
 * cleanup are out-of-band Host/operator policy, not portable lifecycle.
 */
export interface StandardServiceSupply {
  readonly serviceRef: StandardServiceRef;
  satisfiable(input: { readonly tenantId: string; readonly space?: string }): Promise<boolean>;
  materialize(input: {
    readonly tenantId: string;
    readonly space: string;
    readonly slotName: string;
  }): Promise<{
    readonly endpoint: JsonObject;
    readonly credential: JsonObject;
  } | null>;
}

/** Sanitized adapter failure which the domain converts to its Host wire error. */
export class StandardServiceSupplyError extends Error {
  constructor(readonly code: "backend_unavailable" = "backend_unavailable") {
    super(code.replaceAll("_", " "));
    this.name = "StandardServiceSupplyError";
  }
}
