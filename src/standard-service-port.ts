import type { JsonObject } from "./ports.ts";

/** Value-only seam shared by Host policy and provider runtime delivery. */
export interface StandardServiceSlot {
  readonly name: string;
  readonly required: boolean;
  readonly service: {
    readonly apiVersion: "standards.takoform.com/v1alpha1" | "standards.takoform.com/v1";
    readonly protocol: string;
  };
}

/** Runtime-only material, not ciphertext. Never Resource state or provider output. */
export interface StandardServiceProjection extends StandardServiceSlot {
  readonly endpoint: JsonObject;
  readonly credential: JsonObject;
}

export const STABLE_STANDARD_SERVICE_PROTOCOL_PATTERN =
  "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){2,}$";
const STABLE_PROTOCOL = new RegExp(STABLE_STANDARD_SERVICE_PROTOCOL_PATTERN, "u");

/** Syntax only: no protocol registry, Host policy, or runtime integration. */
export function isStableStandardServiceProtocol(value: string): boolean {
  return value.length <= 253 && STABLE_PROTOCOL.test(value);
}
