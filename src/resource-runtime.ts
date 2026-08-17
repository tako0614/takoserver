import type { BackendAdapter, BackendOffering, BackendReceipt, JsonObject } from "./backends.ts";
import { BackendError } from "./backends.ts";
import type { ExactFormRef } from "./contracts.ts";
import type { ExecutionGrantClaims, RuntimeGrantVerifier } from "./runtime-grants.ts";
import { executionIntentDigest } from "./runtime-grants.ts";

export interface RuntimeResource {
  readonly id: string;
  readonly tenantRef: string;
  readonly offeringId: string;
  readonly backendId: string;
  readonly name: string;
  readonly space: string;
  readonly form: ExactFormRef;
  readonly state: "ready";
  readonly nativeId: string;
  readonly observed: JsonObject;
  readonly output: JsonObject;
  readonly createdAt: string;
}

export interface ResourceRuntimeResult {
  readonly kind: "resource.provisioned";
  readonly resource: RuntimeResource;
  readonly suggestedUsage: {
    readonly meter: string;
    readonly quantity: 1;
  };
}

export interface ProvisioningCommit {
  readonly claims: ExecutionGrantClaims;
  readonly resource: RuntimeResource;
  readonly usage: ResourceRuntimeResult["suggestedUsage"];
}

/** Trusted control-plane capability invoked only after provider success. */
export interface ResourceProvisioningCommitter {
  commit(input: ProvisioningCommit): Promise<void>;
}

export interface ResourceRuntime {
  execute(command: {
    readonly kind: "resource.provision";
    readonly grantToken: string;
    readonly name: string;
    readonly space: string;
    readonly spec: JsonObject;
    readonly idempotencyKey: string;
  }): Promise<ResourceRuntimeResult>;
}

export type RuntimeExecutionErrorCode =
  | "invalid_argument"
  | "idempotency_conflict"
  | "offering_unavailable"
  | "backend_conflict"
  | "backend_unavailable";

export class RuntimeExecutionError extends Error {
  constructor(
    readonly code: RuntimeExecutionErrorCode,
    readonly status: number,
  ) {
    super(code);
    this.name = "RuntimeExecutionError";
  }
}

interface RuntimeReplay {
  readonly fingerprint: string;
  readonly provisioned: Promise<{
    readonly claims: ExecutionGrantClaims;
    readonly result: ResourceRuntimeResult;
  }>;
}

export function createResourceRuntime(options: {
  readonly backends: readonly BackendAdapter[];
  readonly verifier: RuntimeGrantVerifier;
  readonly committer: ResourceProvisioningCommitter;
  readonly clock?: () => Date;
}): ResourceRuntime {
  if (options.backends.length === 0) throw new TypeError("at least one backend is required");
  if (!options.verifier || typeof options.verifier.verifyAndConsume !== "function") {
    throw new TypeError("runtime grant verifier is required");
  }
  if (!options.committer || typeof options.committer.commit !== "function") {
    throw new TypeError("resource provisioning committer is required");
  }
  const clock = options.clock ?? (() => new Date());
  const replays = new Map<string, RuntimeReplay>();

  return {
    async execute(command): Promise<ResourceRuntimeResult> {
      const idempotencyKey = reference(command.idempotencyKey, "idempotency key");
      if (idempotencyKey.length < 8) throw invalid();
      const name = reference(command.name, "resource name");
      const space = reference(command.space, "resource space");
      if (!isJsonObject(command.spec)) throw invalid();
      const fingerprint = canonicalJson({
        token: command.grantToken,
        name,
        space,
        spec: command.spec,
      });
      const existing = replays.get(idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new RuntimeExecutionError("idempotency_conflict", 409);
        }
        const completed = await existing.provisioned;
        await options.committer.commit({
          claims: completed.claims,
          resource: completed.result.resource,
          usage: completed.result.suggestedUsage,
        });
        return structuredClone(completed.result);
      }
      const provisioned = (async () => {
        const intentDigest = await executionIntentDigest({ name, space, spec: command.spec });
        const claims = await options.verifier.verifyAndConsume(command.grantToken, {
          operation: "resource.provision",
          intentDigest,
        });
        const selected = await selectOffering(options.backends, claims.offeringId);
        const currentOfferingDigest = await executionIntentDigest({
          id: selected.offering.id,
          backendId: selected.backend.id,
          kind: selected.offering.kind,
          form: selected.offering.form,
          price: selected.offering.price,
          allowances: selected.offering.allowances,
        });
        if (currentOfferingDigest !== claims.offeringDigest) {
          throw new RuntimeExecutionError("offering_unavailable", 503);
        }
        let receipt: BackendReceipt;
        try {
          receipt = await selected.backend.perform({
            kind: "provision",
            operationId: `${claims.reservationId}:${idempotencyKey}`,
            offering: selected.offering,
            resource: {
              tenantRef: claims.tenantRef,
              name,
              space,
              spec: structuredClone(command.spec),
            },
          });
        } catch (error) {
          if (error instanceof BackendError) {
            throw new RuntimeExecutionError(
              error.code === "conflict" ? "backend_conflict" : "backend_unavailable",
              error.code === "conflict" ? 409 : 503,
            );
          }
          throw new RuntimeExecutionError("backend_unavailable", 503);
        }
        const result = {
          kind: "resource.provisioned" as const,
          resource: {
            id: `resource_${claims.reservationId}`,
            tenantRef: claims.tenantRef,
            offeringId: claims.offeringId,
            backendId: selected.backend.id,
            name,
            space,
            form: structuredClone(selected.offering.form),
            state: "ready" as const,
            nativeId: receipt.nativeId,
            observed: structuredClone(receipt.observed),
            output: structuredClone(receipt.output),
            createdAt: clock().toISOString(),
          },
          suggestedUsage: {
            meter: selected.offering.price.unit,
            quantity: 1 as const,
          },
        };
        return { claims, result };
      })();
      replays.set(idempotencyKey, { fingerprint, provisioned });
      const completed = await provisioned;
      await options.committer.commit({
        claims: completed.claims,
        resource: completed.result.resource,
        usage: completed.result.suggestedUsage,
      });
      return structuredClone(completed.result);
    },
  };
}

async function selectOffering(
  backends: readonly BackendAdapter[],
  offeringId: string,
): Promise<{ readonly backend: BackendAdapter; readonly offering: BackendOffering }> {
  let selected:
    | { readonly backend: BackendAdapter; readonly offering: BackendOffering }
    | undefined;
  for (const backend of backends) {
    for (const offering of await backend.discover()) {
      if (offering.id !== offeringId || offering.available === false) continue;
      if (selected) throw new RuntimeExecutionError("offering_unavailable", 503);
      selected = { backend, offering };
    }
  }
  if (!selected) throw new RuntimeExecutionError("offering_unavailable", 503);
  return selected;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

function reference(value: string, _label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/u.test(value)) {
    throw invalid();
  }
  return value;
}

function invalid(): RuntimeExecutionError {
  return new RuntimeExecutionError("invalid_argument", 400);
}
