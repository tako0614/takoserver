import {
  createProvisioningProviderPack,
  type DeploymentComposition,
} from "./deployment-composition.ts";
import { type EdgeFormBundle, edgeProviderOffering } from "./edge-forms.ts";
import type { ProviderPack } from "./provider-pack.ts";
import type { Provider } from "./provider-port.ts";
import type { ProviderRuntimeInputLeasePort } from "./provider-runtime-input-port.ts";
import { CloudflareProvider, type CloudflareProviderOptions } from "./providers/cloudflare.ts";
import type {
  SelfhostArtifacts,
  SelfhostDataPlaneMaintenance,
  SelfhostEventRuntime,
  SelfhostProviderOptions,
} from "./providers/selfhost.ts";
import { isReleasedSelfhostCronForm, MAX_SELFHOST_CRON_OWNERS } from "./providers/selfhost.ts";
import type {
  SelfhostContainerEndpointHttpsIngressPort,
  SelfhostContainerEndpointIngressCapability,
} from "./providers/selfhost-container-endpoint.ts";
import type { SelfhostContainerCapability } from "./providers/selfhost-container-lifecycle.ts";
import type { SelfhostActorPublicRuntime } from "./selfhost-actor-public-runtime.ts";
import { createSelfhostComposition } from "./selfhost-composition.ts";
import type { TakoformStore } from "./takoform/store.ts";
import type { InstalledTakoformBinding, InstalledTakoformForm } from "./takoform/types.ts";
import type { WorkerdRuntime } from "./workerd-runtime.ts";

export const RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN = "cloudflare-object-bucket-drain" as const;

export type StandaloneProviderMode =
  | "stable-selfhost"
  | typeof RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN;

export interface StandaloneProviderEnvironment {
  readonly retiredProviderMode?: string | undefined;
  readonly cloudflareAccountId?: string | undefined;
  /** Whether an env token or rotatable token-file path was configured. */
  readonly cloudflareCredentialConfigured?: boolean | undefined;
  /** Whether the private provisioner endpoint has its shared credential. */
  readonly provisionerCredentialConfigured?: boolean | undefined;
  /** DNS authority belongs to the stable production Worker entry, not this lane. */
  readonly cloudflareZones?: string | undefined;
  /** Retired implicit provider switch; every value is now refused. */
  readonly legacyEdgeForms?: string | undefined;
  readonly workerEndpointSuffix?: string | undefined;
  readonly suffixes?: string | undefined;
  readonly workerdPort?: string | undefined;
}

/**
 * Selects the ordinary Bun execution provider without inferring authority from
 * generic account/storage credentials.
 *
 * D1, R2, and standard-service adapters may use a Cloudflare account while the
 * Provider3 execution pack remains self-hosted. The old Cloudflare
 * ObjectBucket provider is available only as an explicitly named, closed
 * recovery mode for observing and deleting already-recorded beta Deployments.
 */
export function resolveStandaloneProviderMode(
  environment: StandaloneProviderEnvironment,
): StandaloneProviderMode {
  if (environment.legacyEdgeForms !== undefined) {
    throw new TypeError(
      "TAKOSERVER_EDGE_FORMS is retired; ordinary Bun always enables the stable self-host provider",
    );
  }
  if (environment.cloudflareZones !== undefined) {
    throw new TypeError(
      "TAKOSERVER_ZONES is not accepted by Bun; production Cloudflare zones belong to the Worker entry",
    );
  }

  const requested = environment.retiredProviderMode;
  if (requested === undefined) {
    return "stable-selfhost";
  }
  if (requested !== RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN) {
    throw new TypeError(
      "TAKOSERVER_RETIRED_PROVIDER_MODE must be cloudflare-object-bucket-drain when set",
    );
  }
  if (!environment.cloudflareAccountId?.trim()) {
    throw new TypeError(
      "CLOUDFLARE_ACCOUNT_ID is required for the retired Cloudflare ObjectBucket drain",
    );
  }
  if (!environment.cloudflareCredentialConfigured) {
    throw new TypeError(
      "CLOUDFLARE_API_TOKEN or TAKOSERVER_CF_TOKEN_FILE is required for the retired Cloudflare ObjectBucket drain",
    );
  }
  if (!environment.provisionerCredentialConfigured) {
    throw new TypeError(
      "TAKOSERVER_PROVISIONER_TOKEN is required for the retired Cloudflare ObjectBucket drain",
    );
  }
  if (
    environment.workerEndpointSuffix !== undefined ||
    environment.suffixes !== undefined ||
    environment.workerdPort !== undefined
  ) {
    throw new TypeError(
      "the retired Cloudflare ObjectBucket drain cannot be mixed with stable self-host provider settings",
    );
  }
  return RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN;
}

export interface StandaloneProviderComposition {
  readonly mode: StandaloneProviderMode;
  readonly providers: readonly Provider[];
  readonly providerPacks: readonly ProviderPack[];
  readonly offerings: DeploymentComposition["offerings"];
  readonly containerEndpointIngress?: SelfhostContainerEndpointIngressCapability;
}

/**
 * Reads the complete, current Cron owner projection from the same canonical
 * resource inventory used by the Host. The self-host provider uses this only
 * to rehydrate pre-owner-map script state; it is never a second ledger.
 */
export function createSelfhostCronOwnerReader(input: {
  readonly inventory: Pick<TakoformStore, "resourcesByRelation">;
  /** Canonical current and retained edge Forms available to this composition. */
  readonly forms: readonly InstalledTakoformForm[];
}): NonNullable<SelfhostProviderOptions["listCronOwners"]> {
  return async ({ tenantRef, space, workerResourceUid, form, limit }) => {
    const cronForms = input.forms.filter(
      (candidate) =>
        isReleasedSelfhostCronForm(candidate.identity.formRef) &&
        sameCronFormRef(form, candidate.identity.formRef),
    );
    const cronForm = cronForms.length === 1 ? cronForms[0] : undefined;
    const workerForms = cronForm
      ? input.forms.filter(
          (candidate) =>
            candidate.identity.formRef.apiVersion === cronForm.identity.formRef.apiVersion &&
            candidate.identity.formRef.kind === "ModuleWorker",
        )
      : [];
    const workerForm = workerForms.length === 1 ? workerForms[0] : undefined;
    if (
      !cronForm ||
      !workerForm ||
      !tenantRef.trim() ||
      !space.trim() ||
      !workerResourceUid.trim() ||
      !sameCronFormRef(form, cronForm.identity.formRef) ||
      !Number.isSafeInteger(limit) ||
      limit !== MAX_SELFHOST_CRON_OWNERS + 1
    ) {
      return { complete: false };
    }

    try {
      const related = await input.inventory.resourcesByRelation({
        tenantId: tenantRef,
        space,
        sourceApiVersion: cronForm.identity.formRef.apiVersion,
        sourceKind: cronForm.identity.formRef.kind,
        relation: "/worker",
        targetUid: workerResourceUid,
        limit,
      });
      // A full page may have hidden another owner. Do not mistake it for a
      // complete projection, even when the result happens to contain 65 rows.
      if (related.length >= limit) return { complete: false };

      const owners: { resourceUid: string; cron: string }[] = [];
      const seenUids = new Set<string>();
      for (const entry of related) {
        const resource = entry.resource;
        const workerRelations = entry.relations.filter(
          (relation) => relation.pointer === "/worker" || relation.relation === "/worker",
        );
        const relation = workerRelations[0];
        const uid = resource.metadata.uid;
        const cron = resource.spec.cron;
        if (
          resource.apiVersion !== cronForm.identity.formRef.apiVersion ||
          resource.kind !== cronForm.identity.formRef.kind ||
          resource.form.formRef.apiVersion !== cronForm.identity.formRef.apiVersion ||
          resource.form.formRef.kind !== cronForm.identity.formRef.kind ||
          resource.form.formRef.definitionVersion !== cronForm.identity.formRef.definitionVersion ||
          resource.form.formRef.schemaDigest !== cronForm.identity.formRef.schemaDigest ||
          resource.form.packageDigest !== cronForm.identity.packageDigest ||
          resource.form.implementationDigest !== cronForm.identity.implementationDigest ||
          resource.metadata.space !== space ||
          typeof uid !== "string" ||
          !uid.trim() ||
          seenUids.has(uid) ||
          typeof cron !== "string" ||
          workerRelations.length !== 1 ||
          !relation ||
          relation.pointer !== "/worker" ||
          relation.relation !== "/worker" ||
          relation.targetUid !== workerResourceUid ||
          relation.targetApiVersion !== workerForm.identity.formRef.apiVersion ||
          relation.targetKind !== workerForm.identity.formRef.kind ||
          relation.targetFormRef.apiVersion !== workerForm.identity.formRef.apiVersion ||
          relation.targetFormRef.kind !== workerForm.identity.formRef.kind ||
          relation.targetFormRef.definitionVersion !==
            workerForm.identity.formRef.definitionVersion ||
          relation.targetFormRef.schemaDigest !== workerForm.identity.formRef.schemaDigest
        ) {
          return { complete: false };
        }
        seenUids.add(uid);
        owners.push({ resourceUid: uid, cron });
      }
      return { complete: true, owners };
    } catch {
      return { complete: false };
    }
  };
}

function sameCronFormRef(
  actual: Parameters<NonNullable<SelfhostProviderOptions["listCronOwners"]>>[0]["form"],
  expected: InstalledTakoformForm["identity"]["formRef"],
): boolean {
  return (
    actual.apiVersion === expected.apiVersion &&
    actual.kind === expected.kind &&
    actual.definitionVersion === expected.definitionVersion &&
    actual.schemaDigest === expected.schemaDigest
  );
}

export function createStandaloneProviderComposition(input: {
  readonly mode: StandaloneProviderMode;
  readonly stableForms: readonly InstalledTakoformForm[];
  readonly stableBindings?: readonly InstalledTakoformBinding[];
  readonly edge: EdgeFormBundle;
  readonly dataRoot: string;
  readonly runtime: WorkerdRuntime;
  readonly actorRuntime?: SelfhostActorPublicRuntime;
  /** Opt-in native execution; no Form or Offering is synthesized from configuration. */
  readonly container?: SelfhostContainerCapability;
  readonly containerEndpointIngress?: SelfhostContainerEndpointHttpsIngressPort;
  /** Whether the entry verified the exact closed-graph workerd artifact. */
  readonly workerRuntimeAvailable?: boolean;
  readonly artifacts: SelfhostArtifacts;
  readonly workerEndpointSuffix?: string;
  /** `https` only where this machine's workerd socket terminates TLS. */
  readonly workerEndpointScheme?: "https" | "http";
  /** The workerd socket's port, carried into the address when it is not the scheme's default. */
  readonly workerEndpointPort?: number;
  readonly suffixes?: readonly string[];
  /** Present only when this deployment has an operator-configured seal key ring. */
  readonly runtimeInputs?: ProviderRuntimeInputLeasePort;
  /** Loopback address of the KV and SQL data planes, when this entry serves them. */
  readonly dataPlaneAddress?: string;
  /** The housekeeping half of those planes, composed with the address or not at all. */
  readonly dataPlaneMaintenance?: SelfhostDataPlaneMaintenance;
  /** The pump and the scheduler, when this entry runs them. */
  readonly events?: SelfhostEventRuntime;
  /** One-time rehydration from canonical Host resource ownership for legacy Cron state. */
  readonly listCronOwners?: SelfhostProviderOptions["listCronOwners"];
  readonly now: Date;
  readonly retiredCloudflare?: Omit<CloudflareProviderOptions, "offerings">;
}): StandaloneProviderComposition {
  if (input.mode === "stable-selfhost") {
    if (input.retiredCloudflare) {
      throw new TypeError(
        "stable self-host provider cannot be mixed with retired Cloudflare drain configuration",
      );
    }
    const composition = createSelfhostComposition({
      stableForms: input.stableForms,
      ...(input.stableBindings ? { stableBindings: input.stableBindings } : {}),
      edge: input.edge,
      dataRoot: input.dataRoot,
      runtime: input.runtime,
      ...(input.actorRuntime ? { actorRuntime: input.actorRuntime } : {}),
      ...(input.container ? { container: input.container } : {}),
      ...(input.containerEndpointIngress
        ? { containerEndpointIngress: input.containerEndpointIngress }
        : {}),
      ...(input.workerRuntimeAvailable === undefined
        ? {}
        : { workerRuntimeAvailable: input.workerRuntimeAvailable }),
      artifacts: input.artifacts,
      edgeForms: true,
      ...(input.workerEndpointSuffix ? { workerEndpointSuffix: input.workerEndpointSuffix } : {}),
      ...(input.workerEndpointScheme ? { workerEndpointScheme: input.workerEndpointScheme } : {}),
      ...(input.workerEndpointPort === undefined
        ? {}
        : { workerEndpointPort: input.workerEndpointPort }),
      ...(input.suffixes ? { suffixes: input.suffixes } : {}),
      ...(input.runtimeInputs ? { runtimeInputs: input.runtimeInputs } : {}),
      ...(input.dataPlaneAddress ? { dataPlaneAddress: input.dataPlaneAddress } : {}),
      ...(input.dataPlaneMaintenance ? { dataPlaneMaintenance: input.dataPlaneMaintenance } : {}),
      ...(input.events ? { events: input.events } : {}),
      ...(input.listCronOwners ? { listCronOwners: input.listCronOwners } : {}),
      now: input.now,
    });
    return {
      mode: input.mode,
      providers: [composition.provider],
      providerPacks: composition.providerPacks,
      offerings: composition.offerings,
      ...(composition.containerEndpointIngress
        ? { containerEndpointIngress: composition.containerEndpointIngress }
        : {}),
    };
  }

  if (!input.retiredCloudflare) {
    throw new TypeError("retired Cloudflare ObjectBucket drain configuration is required");
  }
  if (input.runtimeInputs) {
    throw new TypeError(
      "the retired Cloudflare ObjectBucket drain consumes no runtime-input lease",
    );
  }
  if (input.container) {
    throw new TypeError("the retired Cloudflare drain cannot compose a local Container runtime");
  }
  if (input.dataPlaneAddress) {
    throw new TypeError("the retired Cloudflare ObjectBucket drain publishes no Worker Version");
  }
  if (
    input.workerEndpointSuffix !== undefined ||
    input.workerEndpointScheme !== undefined ||
    input.workerEndpointPort !== undefined ||
    input.suffixes !== undefined
  ) {
    throw new TypeError(
      "retired Cloudflare ObjectBucket drain cannot be mixed with stable self-host provider settings",
    );
  }
  const objectBucketOffering = edgeProviderOffering(input.edge.objectBucket.form, {
    id: "storage.object.standard",
    displayName: "Object bucket",
    regions: ["global"],
  });
  const provider = new CloudflareProvider({
    ...input.retiredCloudflare,
    offerings: [],
    recoveryOfferings: [objectBucketOffering],
  });
  const pack = createProvisioningProviderPack({ provider, providerType: "cloudflare" });

  // Reconstruct only the historical technical Provider Pack. A commercial
  // candidate is deliberately never created: doing so, even to discard it,
  // would give a recovery adapter a sale-authority shape it does not own.
  return {
    mode: input.mode,
    providers: [provider],
    providerPacks: [pack],
    offerings: [],
  };
}
