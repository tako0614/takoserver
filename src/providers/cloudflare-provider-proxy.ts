import type { JsonObject } from "../ports.ts";
import type { MeterSource } from "../provider-meter-port.ts";
import type {
  ApplyInput,
  Provider,
  ProviderArtifactConsumption,
  ProviderNativeAbsence,
  ProviderNativeReadbackDescriptor,
  ProviderNativeReadbackInput,
  ProviderOffering,
  ProviderRelation,
  ProviderTicket,
} from "../provider-port.ts";
import { MAX_PROVIDER_RUNTIME_INPUT_BINDINGS } from "../provider-runtime-input-port.ts";
import { canonicalWorkerEndpointOrigin } from "../provider-worker-endpoint-origin.ts";
import {
  type CloudflareProviderMeterSourceDescriptor,
  cloudflareProviderMeterSourceForOfferingKind,
} from "./cloudflare-edge-meter-contract.ts";
import {
  type CloudflareProviderExecutorRpc,
  isCloudflareProviderArtifactConsumption,
} from "./cloudflare-provider-executor-rpc.ts";
import {
  cloudflareWfpOwnsOffering,
  createCloudflareNativeReadbackDescriptor,
} from "./cloudflare-readback-descriptor.ts";
import { ProviderMeterError } from "./provider-meter.ts";

export interface CloudflareProviderProxyOptions {
  readonly id?: string;
  readonly offerings: readonly ProviderOffering[];
  readonly recoveryOfferings?: readonly ProviderOffering[];
  readonly managedBaseDomain: string;
  /** Static capability projection; no secret or lease value enters this object. */
  readonly runtimeInputs?: boolean;
  readonly binding: CloudflareProviderExecutorRpc;
}

/**
 * Credential-free Provider surface retained in the public API Worker.
 *
 * Static catalog and endpoint facts stay local. Only the explicitly typed
 * provider operations cross the private service binding; artifact bytes and
 * runtime-input plaintext are resolved inside the executor from shared D1/R2.
 */
export class CloudflareProviderProxy implements Provider {
  readonly id: string;
  readonly offerings: readonly ProviderOffering[];
  readonly recoveryOfferings?: readonly ProviderOffering[];
  readonly runtimeInputCapabilities?: { readonly maximumBindings: number };
  readonly workerEndpointOriginReservations: NonNullable<
    Provider["workerEndpointOriginReservations"]
  >;
  readonly #binding: CloudflareProviderExecutorRpc;

  constructor(options: CloudflareProviderProxyOptions) {
    this.id = options.id ?? "cloudflare";
    this.offerings = structuredClone(options.offerings);
    if (options.recoveryOfferings) {
      this.recoveryOfferings = structuredClone(options.recoveryOfferings);
    }
    if (options.runtimeInputs) {
      this.runtimeInputCapabilities = {
        maximumBindings: MAX_PROVIDER_RUNTIME_INPUT_BINDINGS,
      };
    }
    this.#binding = options.binding;
    const managedBaseDomain = normalizeManagedBaseDomain(options.managedBaseDomain);
    this.workerEndpointOriginReservations = {
      derive: async ({ requestedSubdomain }) => {
        const canonicalPublicOrigin = canonicalWorkerEndpointOrigin(
          requestedSubdomain,
          managedBaseDomain,
        );
        return canonicalPublicOrigin ? { canonicalPublicOrigin } : null;
      },
      // A WfP installation sells names beneath the managed base domain. The
      // Host must therefore hold a caller-requested reservation; it may not
      // invent an address from a Worker name.
      hostMintedSubdomain: async () => null,
    };
  }

  apply(input: ApplyInput): Promise<ProviderTicket> {
    return this.#binding.apply(input);
  }

  recoverApply(input: ApplyInput): Promise<ProviderTicket> {
    return this.#binding.recoverApply(input);
  }

  convergeApply(input: ApplyInput): Promise<ProviderTicket> {
    return this.#binding.convergeApply(input);
  }

  poll(input: Parameters<NonNullable<Provider["poll"]>>[0]): Promise<ProviderTicket> {
    return this.#binding.poll(input);
  }

  observe(input: {
    readonly offering: ProviderOffering;
    readonly nativeId: string;
    readonly identity: import("../provider-port.ts").ResourceIdentity;
    readonly spec: JsonObject;
    readonly relations?: readonly ProviderRelation[];
  }): Promise<ProviderTicket> {
    return this.#binding.observe(input);
  }

  delete(input: Parameters<Provider["delete"]>[0]): Promise<ProviderTicket> {
    return this.#binding.delete(input);
  }

  recoverDelete(
    input: Parameters<NonNullable<Provider["recoverDelete"]>>[0],
  ): Promise<ProviderTicket> {
    return this.#binding.recoverDelete(input);
  }

  adopt(input: Parameters<NonNullable<Provider["adopt"]>>[0]): Promise<ProviderTicket> {
    return this.#binding.adopt(input);
  }

  recoverAdopt(
    input: Parameters<NonNullable<Provider["recoverAdopt"]>>[0],
  ): Promise<ProviderTicket> {
    return this.#binding.recoverAdopt(input);
  }

  createNativeReadbackDescriptor(
    input: ProviderNativeReadbackInput,
  ): ProviderNativeReadbackDescriptor {
    return createCloudflareNativeReadbackDescriptor({
      providerId: this.id,
      placement: cloudflareWfpOwnsOffering(input.offering)
        ? "workers-for-platforms"
        : "ordinary-workers",
      readback: input,
    });
  }

  verifyNativeAbsence(
    input: Parameters<NonNullable<Provider["verifyNativeAbsence"]>>[0],
  ): Promise<ProviderNativeAbsence> {
    return this.#binding.verifyNativeAbsence(input);
  }

  async verifyArtifactConsumption(
    input: Parameters<NonNullable<Provider["verifyArtifactConsumption"]>>[0],
  ): Promise<ProviderArtifactConsumption> {
    const result: unknown = await this.#binding.verifyArtifactConsumption(input);
    return isCloudflareProviderArtifactConsumption(result)
      ? result
      : { outcome: "unknown", reason: "malformed", retryable: false };
  }

  readonly sqliteMigrations = {
    readLedger: (input: Parameters<NonNullable<Provider["sqliteMigrations"]>["readLedger"]>[0]) =>
      this.#binding.readSqliteMigrationLedger(input),
    applySuffix: (input: Parameters<NonNullable<Provider["sqliteMigrations"]>["applySuffix"]>[0]) =>
      this.#binding.applySqliteMigrationSuffix({
        ...input,
        desired: input.desired.map(({ path, digest }) => ({ path, digest })),
        migrations: input.migrations.map(({ path, digest }) => ({ path, digest })),
      }),
  };
}

/**
 * Value-free catalog MeterSources. Each read crosses only the bounded typed
 * executor RPC; the public Worker never imports Cloudflare analytics transport
 * or holds a parent-account credential.
 */
export function createCloudflareProviderMeterProxySources(input: {
  readonly offerings: readonly ProviderOffering[];
  readonly binding: CloudflareProviderExecutorRpc;
}): readonly MeterSource[] {
  const bySource = new Map<
    string,
    {
      readonly descriptor: CloudflareProviderMeterSourceDescriptor;
      readonly offerings: ProviderOffering[];
    }
  >();
  for (const offering of input.offerings) {
    const descriptor = cloudflareProviderMeterSourceForOfferingKind(offering.form.kind);
    if (!descriptor) continue;
    const current = bySource.get(descriptor.id);
    if (current) {
      current.offerings.push(structuredClone(offering));
    } else {
      bySource.set(descriptor.id, {
        descriptor,
        offerings: [structuredClone(offering)],
      });
    }
  }
  return [...bySource.values()].map(({ descriptor, offerings }) => ({
    ...descriptor,
    meters: [...descriptor.meters],
    async read({ tenantId, deployment, from, until }) {
      const matching = offerings.filter(
        (offering) =>
          offering.id === deployment.offeringId &&
          cloudflareProviderMeterSourceForOfferingKind(offering.form.kind)?.id === descriptor.id,
      );
      if (tenantId !== deployment.tenantId || matching.length !== 1) {
        throw new ProviderMeterError("upstream_invalid");
      }
      const result = await input.binding.readMeterUsage({
        meterSourceId: descriptor.id,
        meters: descriptor.meters,
        offering: matching[0] as ProviderOffering,
        tenantId,
        deployment,
        from,
        until,
      });
      if (!result.ok) throw new ProviderMeterError(result.error.code);
      return result.value;
    },
  }));
}

function normalizeManagedBaseDomain(value: string): string {
  const normalized = value.toLowerCase().replace(/\.$/u, "");
  if (
    normalized.length > 253 ||
    normalized.includes("workers.dev") ||
    !normalized.includes(".") ||
    normalized.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  ) {
    throw new TypeError("invalid Cloudflare managed base domain");
  }
  return normalized;
}
