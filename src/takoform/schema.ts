import { canonicalJson } from "../json.ts";
import type { JsonObject, JsonValue } from "../ports.ts";
import type { InstalledTakoformForm, TakoformDiagnostic } from "./types.ts";

/**
 * The JSON Schema subset the Host understands, and the default materialization
 * that runs before validation.
 *
 * This is deliberately a subset, not a general validator: an installed Form
 * declares a closed shape, and anything outside `const`/`enum`/`type`/object
 * and array structure/string and number bounds is ignored rather than guessed
 * at. Diagnostics carry JSON Pointer fields, which the wire contract pins.
 */

export function validateDesired(
  form: InstalledTakoformForm,
  spec: JsonObject,
): readonly TakoformDiagnostic[] {
  if (form.validateDesired) return clone(form.validateDesired(clone(spec)));
  return validateSchemaValue(form.desiredSchema, spec, "");
}

export function validateSchemaValue(
  schemaValue: unknown,
  value: JsonValue,
  pointer: string,
): TakoformDiagnostic[] {
  if (!isRecord(schemaValue)) return [];
  const diagnostics: TakoformDiagnostic[] = [];
  const error = (message: string, field = pointer): void => {
    diagnostics.push({ severity: "error", ...(field ? { field } : {}), message });
  };
  if (
    schemaValue.const !== undefined &&
    canonicalJson(schemaValue.const) !== canonicalJson(value)
  ) {
    error("value does not match const");
  }
  if (
    Array.isArray(schemaValue.enum) &&
    !schemaValue.enum.some((candidate) => canonicalJson(candidate) === canonicalJson(value))
  ) {
    error("value is not in enum");
  }
  const type = schemaValue.type;
  if (typeof type === "string" && !matchesJsonType(type, value)) {
    error(`value must be ${type}`);
    return diagnostics;
  }
  if (type === "object" && isRecord(value)) {
    const properties = isRecord(schemaValue.properties) ? schemaValue.properties : {};
    const required = Array.isArray(schemaValue.required)
      ? schemaValue.required.filter((entry): entry is string => typeof entry === "string")
      : [];
    for (const key of required) {
      if (!(key in value)) {
        error("required field is missing", `${pointer}/${jsonPointerSegment(key)}`);
      }
    }
    if (schemaValue.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) error("unknown field", `${pointer}/${jsonPointerSegment(key)}`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (properties[key] !== undefined) {
        diagnostics.push(
          ...validateSchemaValue(properties[key], child, `${pointer}/${jsonPointerSegment(key)}`),
        );
      } else if (isRecord(schemaValue.additionalProperties)) {
        diagnostics.push(
          ...validateSchemaValue(
            schemaValue.additionalProperties,
            child,
            `${pointer}/${jsonPointerSegment(key)}`,
          ),
        );
      }
    }
  }
  if (type === "array" && Array.isArray(value)) {
    if (Number.isInteger(schemaValue.minItems) && value.length < Number(schemaValue.minItems)) {
      error("array has too few items");
    }
    if (Number.isInteger(schemaValue.maxItems) && value.length > Number(schemaValue.maxItems)) {
      error("array has too many items");
    }
    if (isRecord(schemaValue.items)) {
      value.forEach((entry, index) => {
        diagnostics.push(...validateSchemaValue(schemaValue.items, entry, `${pointer}/${index}`));
      });
    }
  }
  if (type === "string" && typeof value === "string") {
    const length = [...value].length;
    if (Number.isInteger(schemaValue.minLength) && length < Number(schemaValue.minLength)) {
      error("string is too short");
    }
    if (Number.isInteger(schemaValue.maxLength) && length > Number(schemaValue.maxLength)) {
      error("string is too long");
    }
    if (typeof schemaValue.pattern === "string") {
      try {
        if (!new RegExp(schemaValue.pattern, "u").test(value)) {
          error("string does not match pattern");
        }
      } catch {
        throw new TypeError("invalid installed schema pattern");
      }
    }
  }
  if (typeof value === "number") {
    if (typeof schemaValue.minimum === "number" && value < schemaValue.minimum) {
      error("number is below minimum");
    }
    if (typeof schemaValue.maximum === "number" && value > schemaValue.maximum) {
      error("number is above maximum");
    }
    if (typeof schemaValue.exclusiveMinimum === "number" && value <= schemaValue.exclusiveMinimum) {
      error("number is below exclusive minimum");
    }
    if (typeof schemaValue.exclusiveMaximum === "number" && value >= schemaValue.exclusiveMaximum) {
      error("number is above exclusive maximum");
    }
  }
  return diagnostics;
}

/** Fills declared defaults so validation and digests see one canonical spec. */
export function materializeDefaults(schemaValue: JsonObject, spec: JsonObject): JsonObject {
  return materializeValue(schemaValue, spec) as JsonObject;
}

function materializeValue(schemaValue: unknown, value: JsonValue): JsonValue {
  if (!isRecord(schemaValue)) return clone(value);
  if (schemaValue.type === "object" && isRecord(value)) {
    const properties = isRecord(schemaValue.properties) ? schemaValue.properties : {};
    const next: Record<string, JsonValue> = {};
    for (const [key, propertyValue] of Object.entries(properties)) {
      if (!isRecord(propertyValue)) continue;
      if (value[key] === undefined && propertyValue.default !== undefined) {
        next[key] = clone(propertyValue.default) as JsonValue;
      }
    }
    for (const [key, child] of Object.entries(value)) {
      next[key] = materializeValue(properties[key], child);
    }
    return next;
  }
  if (schemaValue.type === "array" && Array.isArray(value) && isRecord(schemaValue.items)) {
    return value.map((entry) => materializeValue(schemaValue.items, entry));
  }
  return clone(value);
}

function matchesJsonType(type: string, value: JsonValue): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

function jsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
