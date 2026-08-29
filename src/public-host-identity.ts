export interface PublicHostIdentity {
  readonly kind: "takoserver.public-host-identity@v1";
  readonly hostId: string;
  readonly workerVersionId: string;
}

export interface PublicHostIdentityRpc {
  identity(): Promise<PublicHostIdentity>;
}

export function publicHostIdentity(input: {
  readonly hostId: unknown;
  readonly workerVersionId: unknown;
}): PublicHostIdentity {
  if (
    typeof input.hostId !== "string" ||
    input.hostId.length === 0 ||
    input.hostId.length > 255 ||
    typeof input.workerVersionId !== "string" ||
    !workerVersionId(input.workerVersionId)
  ) {
    throw new TypeError("public Host identity is invalid");
  }
  return {
    kind: "takoserver.public-host-identity@v1",
    hostId: input.hostId,
    workerVersionId: input.workerVersionId,
  };
}

export function isPublicHostIdentity(value: unknown): value is PublicHostIdentity {
  return (
    isRecord(value) &&
    value.kind === "takoserver.public-host-identity@v1" &&
    typeof value.hostId === "string" &&
    value.hostId.length > 0 &&
    value.hostId.length <= 255 &&
    typeof value.workerVersionId === "string" &&
    workerVersionId(value.workerVersionId)
  );
}

function workerVersionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
