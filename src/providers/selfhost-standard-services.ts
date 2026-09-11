import { canonicalJson, isJsonObject, type JsonObject } from "../json.ts";
import {
  isStableStandardServiceProtocol,
  type StandardServiceProjection,
} from "../standard-service-port.ts";
import { parseStrictJson } from "../strict-json.ts";
import type { SelfhostVersionExternalService } from "./selfhost-version-bindings.ts";

type Declaration = Omit<SelfhostVersionExternalService, "binding">;

/** Operator code owns the JSON object's keys; this is not a protocol registry. */
export interface SelfhostStandardServiceIntegration {
  readonly service: Declaration["service"];
  readonly serialize: (projection: StandardServiceProjection) => JsonObject;
}

export class SelfhostStandardServiceError extends Error {
  constructor() {
    // Never reflect callback errors, endpoints or credentials into a ticket.
    super("the Worker Version external service bindings are unavailable or invalid");
  }
}

/** One composition owns initial materialization; retained records own recovery. */
export function createSelfhostStandardServices(
  integrations: readonly SelfhostStandardServiceIntegration[] = [],
) {
  const serializers = new Map<string, SelfhostStandardServiceIntegration["serialize"]>();
  for (const integration of integrations) {
    if (
      integration.service.apiVersion !== "standards.takoform.com/v1" ||
      !isStableStandardServiceProtocol(integration.service.protocol) ||
      typeof integration.serialize !== "function" ||
      serializers.has(integration.service.protocol)
    ) {
      throw new SelfhostStandardServiceError();
    }
    serializers.set(integration.service.protocol, integration.serialize);
  }
  return {
    protocols: integrations.map(({ service }) => ({ ...service })),
    materialize(
      spec: JsonObject,
      projections: readonly StandardServiceProjection[],
      reserved: ReadonlySet<string>,
    ): readonly SelfhostVersionExternalService[] {
      try {
        const slots = declarations(spec);
        const supplied = new Map<string, StandardServiceProjection>();
        for (const projection of projections) {
          const slot = slots.find((candidate) => candidate.name === projection.name);
          if (
            !slot ||
            supplied.has(projection.name) ||
            canonicalJson(slot) !==
              canonicalJson({
                name: projection.name,
                required: projection.required,
                service: projection.service,
              })
          ) {
            throw new SelfhostStandardServiceError();
          }
          supplied.set(projection.name, projection);
        }
        return slots.map((slot) => {
          if (reserved.has(slot.name)) throw new SelfhostStandardServiceError();
          const projection = supplied.get(slot.name);
          const serialize = serializers.get(slot.service.protocol);
          if (!projection || !serialize) {
            if (slot.required) throw new SelfhostStandardServiceError();
            return slot;
          }
          const value = serialize(structuredClone(projection));
          if (!isJsonObject(value) || !plainJson(value)) throw new SelfhostStandardServiceError();
          const text = canonicalJson(value);
          if (!isJsonObject(parseStrictJson(new TextEncoder().encode(text), 4 * 1024 * 1024))) {
            throw new SelfhostStandardServiceError();
          }
          return { ...slot, binding: { kind: "json" as const, value: text } };
        });
      } catch {
        throw new SelfhostStandardServiceError();
      }
    },
  };
}

function plainJson(value: unknown, ancestors = new Set<unknown>(), depth = 0): boolean {
  if (depth > 128) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  ancestors.add(value);
  const valid = Object.values(value).every((entry) => plainJson(entry, ancestors, depth + 1));
  ancestors.delete(value);
  return valid;
}

/** No resolver, serializer, credentials, or current support lookup on recovery. */
export function sameSelfhostStandardServiceDeclaration(
  spec: JsonObject,
  recorded: readonly SelfhostVersionExternalService[] | undefined,
): boolean {
  try {
    const expected = declarations(spec);
    const actual = (recorded ?? [])
      .map(({ name, required, service, binding }) => {
        if (required && !binding) throw new SelfhostStandardServiceError();
        return { name, required, service };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return canonicalJson(expected) === canonicalJson(actual);
  } catch {
    return false;
  }
}

function declarations(spec: JsonObject): readonly Declaration[] {
  const raw = spec.externalServices === undefined ? [] : spec.externalServices;
  if (!Array.isArray(raw) || raw.length > 16) throw new SelfhostStandardServiceError();
  const names = new Set<string>();
  return raw
    .map((slot) => {
      if (
        !isJsonObject(slot) ||
        Object.keys(slot).some((key) => !["name", "required", "service"].includes(key)) ||
        typeof slot.name !== "string" ||
        slot.name.length > 64 ||
        !/^[A-Z][A-Z0-9_]*$/u.test(slot.name) ||
        names.has(slot.name) ||
        (slot.required !== undefined && typeof slot.required !== "boolean") ||
        !isJsonObject(slot.service) ||
        Object.keys(slot.service).sort().join(",") !== "apiVersion,protocol" ||
        slot.service.apiVersion !== "standards.takoform.com/v1" ||
        typeof slot.service.protocol !== "string" ||
        !isStableStandardServiceProtocol(slot.service.protocol)
      ) {
        throw new SelfhostStandardServiceError();
      }
      names.add(slot.name);
      return {
        name: slot.name,
        required: slot.required !== false,
        service: {
          apiVersion: "standards.takoform.com/v1" as const,
          protocol: slot.service.protocol,
        },
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
