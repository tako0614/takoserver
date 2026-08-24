import type { JsonObject } from "../ports.ts";
import {
  type InstalledTakoformForm,
  TakoformHostError,
  type TakoformStandardServiceProjection,
  type TakoformStandardServiceResolver,
  type TakoformStandardServiceSlot,
} from "./types.ts";

const LEGACY_STANDARD_SERVICES_API = "standards.takoform.com/v1alpha1";
export const STABLE_STANDARD_SERVICES_API = "standards.takoform.com/v1";
const STABLE_PROTOCOL =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){2,}$/u;
const PROJECTED_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  postgresql: ["URL"],
  redis: ["URL"],
  smtp: ["URL"],
  "s3-compatible": ["ENDPOINT", "REGION", "BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"],
};

interface StandardServiceDeclaration {
  readonly pointer: `/${string}`;
  readonly apiVersion: typeof LEGACY_STANDARD_SERVICES_API | typeof STABLE_STANDARD_SERVICES_API;
  readonly protocols?: readonly string[];
}

/** Stable syntax validation is structural and never a protocol registry lookup. */
export function isStableStandardServiceProtocol(value: string): boolean {
  return value.length <= 253 && STABLE_PROTOCOL.test(value);
}

/** Reads the extension from the Definition schema; there is no parallel slot catalog. */
export function standardServiceDeclarations(
  form: InstalledTakoformForm,
): readonly StandardServiceDeclaration[] {
  const declarations: StandardServiceDeclaration[] = [];
  walk(form.desiredSchema, "", declarations);
  if (declarations.length > 0 && form.role !== "revision") {
    throw new TypeError("standard service slots require a revision Form");
  }
  return declarations;
}

/** Resolve required slots now; optionally return sealed execution material. */
export async function resolveStandardServiceSlots(input: {
  readonly tenantId: string;
  readonly space: string;
  readonly form: InstalledTakoformForm;
  readonly spec: JsonObject;
  readonly resolver?: TakoformStandardServiceResolver;
  readonly project: boolean;
}): Promise<readonly TakoformStandardServiceProjection[]> {
  const slots = declaredSlots(input.form, input.spec);
  validateRuntimeNamespace(input.form, input.spec, slots);
  const result: TakoformStandardServiceProjection[] = [];
  for (const slot of slots) {
    const satisfiable =
      input.resolver !== undefined &&
      (await input.resolver.satisfiable({
        tenantId: input.tenantId,
        space: input.space,
        serviceRef: slot.service,
      }));
    if (!satisfiable) {
      if (slot.required) throw new TakoformHostError("unsupported_capability", 422);
      continue;
    }
    if (!input.project) continue;
    const material = await input.resolver?.resolve({
      tenantId: input.tenantId,
      space: input.space,
      form: input.form,
      slot,
    });
    if (!material) {
      if (slot.required) throw new TakoformHostError("unsupported_capability", 422);
      continue;
    }
    result.push({
      ...slot,
      endpoint: structuredClone(material.endpoint),
      credential: structuredClone(material.credential),
    });
  }
  return result;
}

function declaredSlots(
  form: InstalledTakoformForm,
  spec: JsonObject,
): readonly TakoformStandardServiceSlot[] {
  const slots: TakoformStandardServiceSlot[] = [];
  const names = new Set<string>();
  for (const declaration of standardServiceDeclarations(form)) {
    const value = pointerValue(spec, declaration.pointer);
    if (!Array.isArray(value)) throw new TakoformHostError("invalid_argument", 400);
    for (const candidate of value) {
      if (!record(candidate)) throw new TakoformHostError("invalid_argument", 400);
      const service = candidate.service;
      if (
        typeof candidate.name !== "string" ||
        !record(service) ||
        service.apiVersion !== declaration.apiVersion ||
        typeof service.protocol !== "string" ||
        (declaration.apiVersion === STABLE_STANDARD_SERVICES_API
          ? !isStableStandardServiceProtocol(service.protocol)
          : !declaration.protocols?.includes(service.protocol)) ||
        (candidate.required !== undefined && typeof candidate.required !== "boolean") ||
        names.has(candidate.name)
      ) {
        throw new TakoformHostError("invalid_argument", 400);
      }
      names.add(candidate.name);
      slots.push({
        name: candidate.name,
        required: candidate.required !== false,
        service: {
          apiVersion: declaration.apiVersion,
          protocol: service.protocol,
        },
      });
    }
  }
  return slots;
}

function validateRuntimeNamespace(
  form: InstalledTakoformForm,
  spec: JsonObject,
  slots: readonly TakoformStandardServiceSlot[],
): void {
  const occupied = new Set<string>();
  if (record(spec.vars)) {
    for (const name of Object.keys(spec.vars)) occupied.add(name);
  }
  if (Array.isArray(spec.requiredSensitiveVars)) {
    for (const candidate of spec.requiredSensitiveVars) {
      if (typeof candidate === "string") occupied.add(candidate);
    }
  }
  const bindingPointers: string[] = [];
  walkBindingDeclarations(form.desiredSchema, "", bindingPointers);
  for (const pointer of bindingPointers) {
    const bindings = pointerValue(spec, pointer);
    if (!Array.isArray(bindings)) continue;
    for (const binding of bindings) {
      if (record(binding) && typeof binding.name === "string") occupied.add(binding.name);
    }
  }
  const collisions = new Set<string>();
  for (const slot of slots) {
    if (slot.service.apiVersion === STABLE_STANDARD_SERVICES_API) {
      if (occupied.has(slot.name)) collisions.add(slot.name);
      occupied.add(slot.name);
      continue;
    }
    const members = PROJECTED_MEMBERS[slot.service.protocol];
    if (!members) throw new TakoformHostError("unsupported_capability", 422);
    for (const member of members) {
      const projectedName = `${slot.name}_${member}`;
      if (occupied.has(projectedName)) collisions.add(projectedName);
      occupied.add(projectedName);
    }
  }
  if (collisions.size > 0) {
    throw new TakoformHostError("invalid_argument", 400, { collisions: [...collisions].sort() });
  }
}

function walkBindingDeclarations(schema: unknown, pointer: string, result: string[]): void {
  if (!record(schema)) return;
  if (typeof schema["x-takoform-binding"] === "string" && pointer !== "") {
    result.push(pointer);
  }
  if (!record(schema.properties)) return;
  for (const [name, child] of Object.entries(schema.properties)) {
    walkBindingDeclarations(child, `${pointer}/${escapePointer(name)}`, result);
  }
}

function walk(schema: unknown, pointer: string, result: StandardServiceDeclaration[]): void {
  if (!record(schema)) return;
  const extension = schema["x-takoform-standard-services"];
  if (extension !== undefined) {
    const items = schema.items;
    const service =
      record(items) && record(items.properties) && record(items.properties.service)
        ? items.properties.service
        : undefined;
    const serviceProperties = record(service) ? service.properties : undefined;
    const protocol =
      record(serviceProperties) && record(serviceProperties.protocol)
        ? serviceProperties.protocol
        : undefined;
    const apiVersion =
      extension === STABLE_STANDARD_SERVICES_API
        ? STABLE_STANDARD_SERVICES_API
        : extension === LEGACY_STANDARD_SERVICES_API
          ? LEGACY_STANDARD_SERVICES_API
          : undefined;
    const statedApiVersion =
      record(serviceProperties) && record(serviceProperties.apiVersion)
        ? serviceProperties.apiVersion.const
        : undefined;
    const protocols = record(protocol) ? protocol.enum : undefined;
    const stableProtocolSchema =
      apiVersion === STABLE_STANDARD_SERVICES_API &&
      record(protocol) &&
      protocol.type === "string" &&
      protocol.pattern === STABLE_PROTOCOL.source &&
      protocol.maxLength === 253;
    const legacyProtocolSchema =
      apiVersion === LEGACY_STANDARD_SERVICES_API &&
      Array.isArray(protocols) &&
      protocols.length > 0 &&
      protocols.every((value) => typeof value === "string");
    if (
      apiVersion === undefined ||
      pointer === "" ||
      schema.type !== "array" ||
      statedApiVersion !== apiVersion ||
      (!stableProtocolSchema && !legacyProtocolSchema)
    ) {
      throw new TypeError("invalid x-takoform-standard-services declaration");
    }
    result.push({
      pointer: pointer as `/${string}`,
      apiVersion,
      ...(legacyProtocolSchema ? { protocols: [...protocols] as string[] } : {}),
    });
  }
  if (!record(schema.properties)) return;
  for (const [name, child] of Object.entries(schema.properties)) {
    walk(child, `${pointer}/${escapePointer(name)}`, result);
  }
}

function pointerValue(root: unknown, pointer: string): unknown {
  let value = root;
  for (const token of pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (!record(value)) return undefined;
    value = value[token];
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
