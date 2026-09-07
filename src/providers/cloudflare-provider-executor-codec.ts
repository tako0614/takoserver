/** Pure wire validation shared by the public proxy and private executor. */
import type { JsonObject, JsonValue } from "../ports.ts";
import type { ProviderArtifactConsumption } from "../provider-port.ts";

export function digestArray(
  value: unknown,
  maximum: number,
  minimum = 0,
): value is readonly `sha256:${string}`[] {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= maximum &&
    value.every(digest) &&
    value.every((item, index) => {
      const previous = value[index - 1];
      return index === 0 || (typeof previous === "string" && previous < item);
    })
  );
}

export function isCloudflareProviderArtifactConsumption(
  value: unknown,
): value is ProviderArtifactConsumption {
  const raw = plainRecord(value) ? value : null;
  if (!raw || typeof raw.outcome !== "string") return false;
  if (raw.outcome === "absent") {
    const exact = maybeExactRecord(raw, ["outcome", "evidence"]);
    return !!exact && jsonObject(exact.evidence);
  }
  if (raw.outcome === "present") {
    if (raw.consumption === "none") {
      const exact = maybeExactRecord(raw, ["outcome", "consumption", "evidence"]);
      return !!exact && jsonObject(exact.evidence);
    }
    if (raw.consumption === "identified") {
      const exact = maybeExactRecord(raw, [
        "outcome",
        "consumption",
        "manifestDigests",
        "evidence",
      ]);
      return !!exact && digestArray(exact.manifestDigests, 16_384, 1) && jsonObject(exact.evidence);
    }
    return false;
  }
  if (raw.outcome === "unknown") {
    const exact = maybeExactRecord(raw, ["outcome", "reason", "retryable"]);
    return (
      !!exact &&
      (exact.reason === "transport" ||
        exact.reason === "malformed" ||
        exact.reason === "unsupported" ||
        exact.reason === "authority_unavailable") &&
      typeof exact.retryable === "boolean"
    );
  }
  return false;
}

export function jsonObject(value: unknown): value is JsonObject {
  if (!jsonValue(value, 0) || Array.isArray(value) || value === null) return false;
  try {
    return JSON.stringify(value).length <= 1_048_576;
  } catch {
    return false;
  }
}

function jsonValue(value: unknown, depth: number): value is JsonValue {
  if (depth > 64) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length <= 10_000 && value.every((item) => jsonValue(item, depth + 1));
  }
  if (!plainRecord(value)) return false;
  return Object.entries(value).every(
    ([key, item]) => key.length > 0 && key.length <= 1_024 && jsonValue(item, depth + 1),
  );
}

export function digest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

export function boundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

export function maybeExactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  if (!plainRecord(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return null;
  const names = keys as string[];
  const accepted = new Set([...required, ...optional]);
  if (
    names.length < required.length ||
    names.some((key) => !accepted.has(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    return null;
  }
  return value;
}

export function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
