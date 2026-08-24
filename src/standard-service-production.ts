import {
  AMAZON_S3_STANDARD_SERVICE,
  createCloudflareR2StandardServiceSupply,
} from "./providers/cloudflare-r2-standard-service.ts";
import { createStandardServiceResolver } from "./takoform/standard-service-supplies.ts";
import type { TakoformStandardServiceResolver } from "./takoform/types.ts";

export const PRODUCTION_STANDARD_SERVICE_SUPPLIES_KIND = "takoserver.standard-service-supplies@v1";

export function createProductionStandardServiceResolver(input: {
  readonly raw?: string;
  readonly cloudflare?: {
    readonly accountId: string;
    readonly authorize: () => Promise<string> | string;
    readonly apiOrigin?: string;
    readonly fetch?: (request: Request) => Promise<Response>;
  };
}): TakoformStandardServiceResolver | undefined {
  if (input.raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch {
    throw invalid();
  }
  const document = object(parsed);
  if (
    !document ||
    !exactKeys(document, ["kind", "supplies"]) ||
    document.kind !== PRODUCTION_STANDARD_SERVICE_SUPPLIES_KIND ||
    !Array.isArray(document.supplies) ||
    document.supplies.length === 0
  ) {
    throw invalid();
  }
  const supplies = document.supplies.map((value) => {
    const supply = object(value);
    const serviceRef = object(supply?.serviceRef);
    const backend = object(supply?.backend);
    if (
      !supply ||
      !serviceRef ||
      !backend ||
      !exactKeys(supply, ["serviceRef", "backend"]) ||
      !exactKeys(serviceRef, ["apiVersion", "protocol"]) ||
      !exactKeys(backend, ["kind", "supplyNamespace"]) ||
      serviceRef.apiVersion !== AMAZON_S3_STANDARD_SERVICE.apiVersion ||
      serviceRef.protocol !== AMAZON_S3_STANDARD_SERVICE.protocol ||
      backend.kind !== "cloudflare-r2" ||
      !validSupplyNamespace(backend.supplyNamespace) ||
      !input.cloudflare
    ) {
      throw invalid();
    }
    return createCloudflareR2StandardServiceSupply({
      ...input.cloudflare,
      supplyNamespace: backend.supplyNamespace,
    });
  });
  return createStandardServiceResolver(supplies);
}

function validSupplyNamespace(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function invalid(): TypeError {
  return new TypeError("invalid production standard-service supplies");
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
