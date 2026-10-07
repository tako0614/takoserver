export const EDGE_KV_NAMESPACE_FORM_URL =
  "https://edge.forms.takoform.com/forms/EdgeKVNamespace/0.2.0/" as const;

export const EDGE_KV_NAMESPACE_LIMITS = Object.freeze({
  maxKeyBytes: 467,
  maxValueBytes: 26_214_400,
  maxMetadataBytes: 1_024,
  consistency: "eventual" as const,
});

export class EdgeKVNamespaceValidationError extends Error {
  readonly code = "invalid_spec" as const;

  constructor() {
    super("invalid_spec");
    this.name = "EdgeKVNamespaceValidationError";
  }
}

export function parseEdgeKVNamespaceSpec(input: unknown): Record<string, never> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(input).length !== 0
  ) {
    throw new EdgeKVNamespaceValidationError();
  }
  return {};
}

export function validateEdgeKVNamespaceUpdate(
  previousInput: unknown,
  nextInput: unknown,
): Record<string, never> {
  parseEdgeKVNamespaceSpec(previousInput);
  return parseEdgeKVNamespaceSpec(nextInput);
}
