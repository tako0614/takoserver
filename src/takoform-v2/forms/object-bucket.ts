export const OBJECT_BUCKET_FORM_URL =
  "https://edge.forms.takoform.com/forms/ObjectBucket/0.2.0/" as const;

export const OBJECT_BUCKET_LIMITS = Object.freeze({
  maxKeyBytes: 979,
  maxObjectBytes: 5_368_709_120,
  maxSinglePutBytes: 314_572_800,
  maxMultipartParts: 10_000,
  consistency: "strong-read-after-write" as const,
});

export class ObjectBucketValidationError extends Error {
  readonly code = "invalid_spec" as const;

  constructor() {
    super("invalid_spec");
    this.name = "ObjectBucketValidationError";
  }
}

/** ObjectBucket 0.2 has no configuration: only the exact empty object is valid. */
export function parseObjectBucketSpec(input: unknown): Record<string, never> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(input).length !== 0
  ) {
    throw new ObjectBucketValidationError();
  }
  return {};
}

export function validateObjectBucketUpdate(
  previousInput: unknown,
  nextInput: unknown,
): Record<string, never> {
  parseObjectBucketSpec(previousInput);
  return parseObjectBucketSpec(nextInput);
}
