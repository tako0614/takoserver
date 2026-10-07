/**
 * WorkerVersion 0.5 confirmed observation eligibility for a consumer binding.
 * Unknown observation members remain forward-compatible; bundleVerified is
 * required only when the immutable Version declares a WorkerBundle.
 */
export function isReadyWorkerVersionObservation(value: unknown, hasBundle: boolean): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const observation = value as Record<string, unknown>;
  return (
    observation.ready === true &&
    observation.resolvedBindings === true &&
    (hasBundle
      ? observation.bundleVerified === true
      : !Object.hasOwn(observation, "bundleVerified"))
  );
}
