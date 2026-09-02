import type { PricePlan, ProviderInstallation, SupplyContract } from "./catalog-compiler.ts";
import {
  compileDeploymentComposition,
  createCatalogCandidate,
  createProvisioningProviderPack,
  type DeploymentComposition,
  type DeploymentRuntimeBindingRelation,
} from "./deployment-composition.ts";
import { type EdgeFormBundle, edgeProviderOffering } from "./edge-forms.ts";
import { HOSTED_EDGE_IDENTITY_CLASSES } from "./hosted-edge-supplies.ts";
import type { Provider, ProviderOffering } from "./provider-port.ts";
import type { ProviderRuntimeInputLeasePort } from "./provider-runtime-input-port.ts";
import {
  canonicalWorkerEndpointOrigin,
  workerEndpointPublicationDefect,
  workerEndpointPublicationRemedy,
} from "./provider-worker-endpoint-origin.ts";
import {
  createSelfhostProvider,
  type SelfhostArtifacts,
  type SelfhostDataPlaneMaintenance,
  type SelfhostEventRuntime,
  type SelfhostProviderOptions,
} from "./providers/selfhost.ts";
import { SELFHOST_EDGE_OBJECTS_BINDING_REF } from "./providers/selfhost-runtime-bindings.ts";
import { createSelfhostRuntimeBindingMaterializer } from "./selfhost-runtime-binding-materializer.ts";
import {
  YURUCOMMU_IDENTITY_CAPABILITY_KINDS,
  type YurucommuIdentityCapabilityKind,
} from "./takoform/implementation-catalog.ts";
import type { InstalledTakoformForm } from "./takoform/types.ts";
import type { WorkerdRuntime } from "./workerd-runtime.ts";

/**
 * Composes what a machine standing on its own can still drain and execute.
 *
 * The whole released Edge Family goes through ONE provider and one
 * installation, for the same reason the Worker entry holds Cloudflare to one:
 * a Worker Version inherits the installation of every relation it binds, and
 * two installations on one machine would refuse the version that uses a bucket
 * and a KV namespace together.
 *
 * Stable Edge identities are the current local execution surface. Released
 * beta identities stay behind the same Provider Pack only so already-recorded
 * Deployments can be observed and deleted. `edgeForms: false` narrows both
 * surfaces to the retained ObjectBucket drain capability.
 */

/**
 * The resource class each identity Form is sold as here.
 *
 * The four hosted edge classes plus the current ObjectBucket. It is a self-host
 * map rather than the hosted one because the two Hosts no longer realize the
 * same supplies in the same way: this machine backs a bucket with files under
 * its own data root, where the hosted map describes what a reviewed Cloudflare
 * installation sells.
 */
const SELFHOST_IDENTITY_CLASSES = {
  ...HOSTED_EDGE_IDENTITY_CLASSES,
  ObjectBucket: "storage.object",
} as const;

/**
 * The identity Forms a self-host composition can actually offer.
 *
 * Derived from the one rule the composition below applies — a stable identity
 * Form becomes an Offering only when `SELFHOST_IDENTITY_CLASSES` names it —
 * rather than restated as a second list that could drift from it.
 *
 * `ObjectBucket` is inside it now. This machine realizes the supply: object
 * bodies under the data root, metadata in the control database, and a Provider
 * Pack that owns both halves of the `module-worker.object-bucket`
 * materialization, so a `bucketBindings` declaration reaches the Worker as the
 * exact `edge.objects` facade. Widening this rotates the self-host capability
 * and implementation digests, which is an explicit reconvergence obligation
 * rather than a refresh (ADR 0007).
 */
export const SELFHOST_IDENTITY_CAPABILITY_KINDS: readonly YurucommuIdentityCapabilityKind[] =
  YURUCOMMU_IDENTITY_CAPABILITY_KINDS.filter((kind) => kind in SELFHOST_IDENTITY_CLASSES);

const SUPPLY_CONTRACT_REF = "local.ownership-contract";
const PROVIDER_INSTALLATION_REF = "local.primary";

/** Forms the Host executes itself; they are never provider capabilities. */
const HOST_INTRINSIC = new Set([
  "WorkerBundle",
  "StaticAssetBundle",
  "SQLiteMigrationSet",
  "SQLiteMigrationApplication",
]);

export interface SelfhostCompositionOptions {
  /** Current stable Definitions; only the exact supported Edge subset executes locally. */
  readonly stableForms: readonly InstalledTakoformForm[];
  /** Retained beta catalog used only for observation/deletion of recorded Deployments. */
  readonly edge: EdgeFormBundle;
  readonly dataRoot: string;
  readonly runtime: WorkerdRuntime;
  readonly artifacts: SelfhostArtifacts;
  /** Whether the released Edge Family is offered. On by default upstream. */
  readonly edgeForms: boolean;
  readonly workerEndpointSuffix?: string;
  /** `https` only where this machine's workerd socket terminates TLS. */
  readonly workerEndpointScheme?: "https" | "http";
  /** The workerd socket's port, carried into the address when it is not the scheme's default. */
  readonly workerEndpointPort?: number;
  readonly suffixes?: readonly string[];
  /**
   * The one-shot seam for `requiredSensitiveVars`. Absent means this machine
   * has no sealed path for a secret, so the provider advertises no capability
   * and admission refuses the declaration before anything is provisioned.
   */
  readonly runtimeInputs?: ProviderRuntimeInputLeasePort;
  /**
   * Loopback address of this machine's KV and SQL data planes. Absent means it
   * serves none, and a Worker Version that binds one is refused at apply.
   */
  readonly dataPlaneAddress?: string;
  /** The housekeeping half of those planes: reclaiming rows and handles. */
  readonly dataPlaneMaintenance?: SelfhostDataPlaneMaintenance;
  /**
   * The pump and the scheduler, when this entry runs them. Absent means a Queue
   * Consumer and a Cron Trigger are recorded and republished but honestly
   * reported as not delivering and not firing.
   */
  readonly events?: SelfhostEventRuntime;
  readonly now: Date;
}

export interface SelfhostComposition extends DeploymentComposition {
  readonly provider: Provider;
}

export function createSelfhostComposition(
  options: SelfhostCompositionOptions,
): SelfhostComposition {
  const objectBucketOffering = edgeProviderOffering(options.edge.objectBucket.form, {
    id: "storage.object.standard",
    displayName: "Object bucket",
    regions: ["global"],
  });

  const identityOfferings: { offering: ProviderOffering; resourceClass: string }[] = [];
  const technicalOfferings: ProviderOffering[] = [objectBucketOffering];

  if (options.edgeForms) {
    for (const form of options.stableForms) {
      if (form.identity.formRef.apiVersion !== "edge.forms.takoform.com") continue;
      const kind = form.identity.formRef.kind;
      if (form.role === "identity") {
        if (!(kind in SELFHOST_IDENTITY_CLASSES)) continue;
        const resourceClass =
          SELFHOST_IDENTITY_CLASSES[kind as keyof typeof SELFHOST_IDENTITY_CLASSES];
        const offering = edgeProviderOffering(form, {
          id: `${resourceClass}.stable-v1.standard`,
          regions: ["global"],
        });
        identityOfferings.push({ offering, resourceClass });
        technicalOfferings.push(offering);
        continue;
      }
      if (HOST_INTRINSIC.has(kind) || !SELFHOST_EDGE_RELATION_KINDS.has(kind)) continue;
      technicalOfferings.push(
        edgeProviderOffering(form, { id: `selfhost.edge.stable-v1.${kind.toLowerCase()}` }),
      );
    }
    for (const form of options.edge.forms) {
      const kind = form.identity.formRef.kind;
      if (form.role === "identity") {
        if (!(kind in HOSTED_EDGE_IDENTITY_CLASSES)) continue;
        const resourceClass =
          HOSTED_EDGE_IDENTITY_CLASSES[kind as keyof typeof HOSTED_EDGE_IDENTITY_CLASSES];
        const offering = edgeProviderOffering(form, {
          id: `${resourceClass}.standard`,
          regions: ["global"],
        });
        technicalOfferings.push(offering);
        continue;
      }
      if (HOST_INTRINSIC.has(kind)) continue;
      // The relation-owned Forms are provider capabilities, not retail items.
      // Exactly one technical projection per exact Form, so the provider
      // driver can inherit it from the identity Deployment.
      technicalOfferings.push(
        edgeProviderOffering(form, { id: `selfhost.edge.${kind.toLowerCase()}` }),
      );
    }
  }

  const provider = createSelfhostProvider({
    offerings: technicalOfferings,
    dataRoot: options.dataRoot,
    runtime: options.runtime,
    artifacts: options.artifacts,
    ...(options.workerEndpointSuffix ? { workerEndpointSuffix: options.workerEndpointSuffix } : {}),
    ...(options.workerEndpointScheme ? { workerEndpointScheme: options.workerEndpointScheme } : {}),
    ...(options.workerEndpointPort === undefined
      ? {}
      : { workerEndpointPort: options.workerEndpointPort }),
    ...(options.suffixes ? { suffixes: options.suffixes } : {}),
    ...(options.runtimeInputs ? { runtimeInputs: options.runtimeInputs } : {}),
    ...(options.dataPlaneAddress ? { dataPlaneAddress: options.dataPlaneAddress } : {}),
    ...(options.dataPlaneMaintenance ? { dataPlaneMaintenance: options.dataPlaneMaintenance } : {}),
    ...(options.events ? { events: options.events } : {}),
  } satisfies SelfhostProviderOptions);

  const supplyContract: SupplyContract = {
    id: SUPPLY_CONTRACT_REF,
    providerType: "selfhost",
    permittedResourceClasses: [
      ...new Set([
        // Named unconditionally because the retained v1beta1 drain is a
        // technical capability of this same contract even where no current
        // bucket is sold. It is the class the current ObjectBucket offering
        // also carries, so one Set covers both rather than a literal beside a
        // Set that can no longer subtract it.
        "storage.object",
        ...identityOfferings.map((entry) => entry.resourceClass),
      ]),
    ].sort(),
    deliveryModes: ["managed-endpoint"],
    customerAccess: "operator-only",
    whiteLabelAllowed: false,
    endUserTermsRequired: false,
    regions: ["global"],
    validFrom: "2026-01-01T00:00:00.000Z",
    evidenceRef: "selfhost-ownership:local",
  };

  const providerInstallation: ProviderInstallation = {
    id: PROVIDER_INSTALLATION_REF,
    providerPackRef: provider.id,
    supplyContractRef: supplyContract.id,
    state: "active",
    regions: [{ id: "global", capacity: "available" }],
  };

  // Both halves of the object Binding, always. The exporter refuses anything
  // that is not a bucket this provider derived, so attaching it to a drain-only
  // composition advertises nothing: the retained v1beta1 identity is recorded
  // under an address-derived name the exporter does not accept.
  const pack = createProvisioningProviderPack({
    provider,
    providerType: "selfhost",
    capabilities: {
      runtimeBindingMaterializer: createSelfhostRuntimeBindingMaterializer(provider.id),
    },
  });

  const pricePlans: PricePlan[] = [];
  const candidates = identityOfferings.map(({ offering, resourceClass }) => {
    // Self-host sells to its own operator: creating a resource on a machine
    // they already pay for costs nothing at the catalog.
    const pricePlan: PricePlan = {
      id: `${offering.id}.price-v1`,
      currency: "USD",
      provisioning: { meter: "resource.create", amountMinor: 0 },
      meters: [],
    };
    pricePlans.push(pricePlan);
    return createCatalogCandidate(offering, {
      providerPackRef: pack.id,
      providerInstallationRef: providerInstallation.id,
      supplyContractRef: supplyContract.id,
      pricePlanRef: pricePlan.id,
      resourceClass,
      deliveryMode: "managed-endpoint",
      supportPolicyRef: "support:operator:standard",
      abusePolicyRef: "abuse:operator:standard",
      portability:
        resourceClass === "storage.object"
          ? {
              api: "portable",
              exportFormats: [],
              importFormats: [],
              migrationModes: [],
            }
          : {
              api: "portable",
              exportFormats: [],
              importFormats: [],
              migrationModes: [],
            },
      isolation: "dedicated-resource",
    });
  });

  // A bucket Offering exists only where something on this machine can consume
  // it. The pack owns the export and the import, and the Worker backend behind
  // it is a wrapper, so the declaration reaches the Worker as the exact
  // `edge.objects` facade rather than a provider-native client (ADR 0005).
  const runtimeBindingRelations: DeploymentRuntimeBindingRelation[] = identityOfferings
    .filter(({ offering }) => offering.form.kind === "ObjectBucket")
    .map(({ offering }) => ({
      targetOfferingId: offering.id,
      consumerProviderPackRef: pack.id,
      bindingRef: SELFHOST_EDGE_OBJECTS_BINDING_REF,
    }));

  const compiled = compileDeploymentComposition({
    candidates,
    providerPacks: [pack],
    providerInstallations: [providerInstallation],
    supplyContracts: [supplyContract],
    pricePlans,
    runtimeBindingRelations,
    now: options.now,
  });

  // Only stable identities entered `candidates`; released beta Forms remain
  // technical drain capabilities and therefore cannot appear at `/v1` or
  // `/provision/v1`. The current ObjectBucket is a candidate now — this machine
  // realizes the supply — while the retained v1beta1 identity stays
  // recovery-only under its own address-derived names.
  return { ...compiled, provider };
}

const SELFHOST_EDGE_RELATION_KINDS = new Set([
  "WorkerVersion",
  "WorkerDeployment",
  "WorkerCustomDomain",
  "WorkerEndpoint",
  "WorkerCronTrigger",
  "QueueConsumer",
]);

/**
 * Environment variables an operator sets to give this machine's Worker socket a
 * certificate. Named here so the entry, the docs, and the diagnostic agree.
 *
 * [ADR 0009](../docs/adr/0009-a-self-host-publishes-the-scheme-its-socket-serves.md).
 */
export const SELFHOST_TLS_ENVIRONMENT = {
  certificateFile: "TAKOSERVER_WORKERD_TLS_CERT_FILE",
  privateKeyFile: "TAKOSERVER_WORKERD_TLS_KEY_FILE",
  certificate: "TAKOSERVER_WORKERD_TLS_CERT",
  privateKey: "TAKOSERVER_WORKERD_TLS_KEY",
} as const;

/**
 * Whether a Worker endpoint suffix names this machine and nothing else.
 *
 * The same tree `yurucommu-core`'s public-origin rule treats as loopback, and
 * for the same reason: `localhost` and everything under it can only ever be the
 * machine asking, so plain HTTP there is not a downgrade.
 */
function loopbackSuffix(suffix: string): boolean {
  const name = suffix.toLowerCase().replace(/\.$/u, "");
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name === "127.0.0.1" ||
    name === "::1" ||
    name === "[::1]"
  );
}

/**
 * The scheme this machine publishes Worker endpoints under, and what an
 * operator has to be told about it.
 *
 * The scheme follows the socket and nothing else. With a certificate, workerd
 * terminates TLS and the address is `https://`. Without one the socket speaks
 * plain HTTP and the address is `http://` — truthfully, because an `https://`
 * address the runtime cannot serve is one nothing answers on.
 *
 * The warning exists because the consequence is not local. A Worker that
 * establishes its own public identity from the request URL — the rule
 * `yurucommu-core` applies — accepts plain HTTP only on the loopback tree. On
 * any other suffix, an untrusted `http` origin establishes nothing at all, and
 * the instance cannot federate, sign, or address itself. That is a sentence an
 * operator must read at boot rather than discover from a Worker that serves
 * `/healthz` and nothing that needs an identity.
 */
export function selfhostWorkerEndpointScheme(input: {
  readonly workerEndpointSuffix?: string | undefined;
  readonly tlsConfigured: boolean;
}): { readonly scheme: "https" | "http"; readonly warning?: string } {
  if (input.tlsConfigured) return { scheme: "https" };
  const suffix = input.workerEndpointSuffix?.trim() || "localhost";
  if (loopbackSuffix(suffix)) return { scheme: "http" };
  return {
    scheme: "http",
    warning:
      `Worker endpoints are published as http://<script>.${suffix} because no TLS ` +
      "certificate is configured for the Worker socket. That suffix is not loopback, so a " +
      "Worker that derives its public identity from the request URL will establish no origin " +
      "at all: federated identity, signing, and self-addressing cannot work there. Configure " +
      `${SELFHOST_TLS_ENVIRONMENT.certificateFile} and ${SELFHOST_TLS_ENVIRONMENT.privateKeyFile} ` +
      `(or ${SELFHOST_TLS_ENVIRONMENT.certificate} and ${SELFHOST_TLS_ENVIRONMENT.privateKey} with ` +
      "the PEM text) to serve https.",
  };
}

/**
 * A script label of the exact shape this provider derives, for asking the
 * publication rule a question at boot.
 *
 * `hostMintedSubdomain` answers `sw-` plus twenty hex bytes, so the longest
 * name this machine can ever produce is this one. Asking with a real shape is
 * what lets the boot diagnostic catch a suffix that pushes the address past the
 * Form's length bound, rather than only the scheme and the port.
 */
const SPECIMEN_SCRIPT_LABEL = `sw-${"0".repeat(40)}`;

/**
 * Whether this machine can mint a `WorkerEndpoint` at all, and what to say.
 *
 * Separate from `selfhostWorkerEndpointScheme` because it answers a different
 * question. That one says what this socket serves, which is always true and
 * always publishable *to the Worker*. This one asks whether the published
 * `WorkerEndpoint` Form can carry the resulting address — it cannot carry
 * plain HTTP, and it cannot carry a port — so a deployment that terminates TLS
 * somewhere other than 443, and says nothing about it, creates no Worker
 * endpoint. Everything else on the machine still works, which is why this is a
 * diagnostic rather than a boot failure.
 */
export function selfhostWorkerEndpointPublication(input: {
  readonly workerEndpointSuffix?: string | undefined;
  readonly scheme: "https" | "http";
  readonly port?: number | undefined;
}): { readonly publishable: boolean; readonly diagnostic?: string } {
  const suffix = input.workerEndpointSuffix?.trim() || "localhost";
  const origin = canonicalWorkerEndpointOrigin(
    SPECIMEN_SCRIPT_LABEL,
    suffix,
    input.scheme,
    input.port,
  );
  const defect = origin === null ? "hostname" : workerEndpointPublicationDefect(origin);
  if (!defect) return { publishable: true };
  // The specimen label stands back down to `<script>`, so the sentence shows
  // the exact shape without pretending a particular Worker exists.
  const address = (origin ?? `${input.scheme}://${SPECIMEN_SCRIPT_LABEL}.${suffix}`).replace(
    SPECIMEN_SCRIPT_LABEL,
    "<script>",
  );
  return {
    publishable: false,
    diagnostic:
      `Worker endpoints would be published as ${address}. ` +
      workerEndpointPublicationRemedy(defect),
  };
}
