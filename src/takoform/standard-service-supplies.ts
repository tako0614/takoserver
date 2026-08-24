import {
  type StandardServiceSupply,
  StandardServiceSupplyError,
} from "../standard-service-port.ts";
import type { TakoformStandardServiceResolver } from "./types.ts";
import { TakoformHostError } from "./types.ts";

/**
 * Registers Host-owned integrations by their complete opaque identity.
 *
 * The registry knows no protocol vocabulary. Each supply owns its backend and
 * sealed runtime shape; an absent exact tuple remains unsupported.
 */
export function createStandardServiceResolver(
  supplies: readonly StandardServiceSupply[],
): TakoformStandardServiceResolver {
  const byIdentity = new Map<string, StandardServiceSupply>();
  for (const supply of supplies) {
    const key = identityKey(supply.serviceRef);
    if (byIdentity.has(key)) throw new TypeError("standard-service supply identity is duplicated");
    byIdentity.set(key, supply);
  }
  return {
    async satisfiable(input) {
      const supply = byIdentity.get(identityKey(input.serviceRef));
      return supply
        ? await supply.satisfiable({ tenantId: input.tenantId, ...space(input) })
        : false;
    },
    async resolve(input) {
      const supply = byIdentity.get(identityKey(input.slot.service));
      if (!supply) return null;
      try {
        return await supply.materialize({
          tenantId: input.tenantId,
          space: input.space,
          slotName: input.slot.name,
        });
      } catch (error) {
        if (error instanceof StandardServiceSupplyError) {
          throw new TakoformHostError(error.code, 503);
        }
        throw error;
      }
    },
  };
}

function identityKey(serviceRef: {
  readonly apiVersion: string;
  readonly protocol: string;
}): string {
  return `${serviceRef.apiVersion}\0${serviceRef.protocol}`;
}

function space(input: { readonly space?: string }): { readonly space?: string } {
  return input.space === undefined ? {} : { space: input.space };
}
