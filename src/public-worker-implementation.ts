import { isSha256Digest } from "./json.ts";
import type { PublicFormImplementationIdentity } from "./public-host-identity.ts";

export type {
  PublicFormImplementationIdentity,
  PublicWorkerImplementationIdentity,
} from "./public-host-identity.ts";

import {
  CLOUDFLARE_TAKOFORM_HANDLER_KINDS,
  CloudflareProvider,
  TAKOSERVER_INTRINSIC_HANDLER_KINDS,
} from "./public-form-runtime.ts";
import { currentTakoformCandidates } from "./takoform/current-candidates.ts";
import {
  deriveImplementationCatalog,
  exactPublisherFormCandidates,
  type TakoformHandlerManifest,
  type TakoformImplementationCatalog,
  type TakoformLifecycleCapabilityManifest,
  YURUCOMMU_IDENTITY_CAPABILITY_KINDS,
  yurucommuLifecycleCapabilityManifest,
} from "./takoform/implementation-catalog.ts";
import type { TakoformOperation } from "./takoform/types.ts";

const RESOURCE_OPERATION_ORDER = [
  "create",
  "read",
  "update",
  "delete",
  "import",
  "observe",
] as const satisfies readonly TakoformOperation[];
const FORM_KIND = /^[A-Z][A-Za-z0-9]{0,63}$/u;
const CURRENT_PUBLISHER_FORM_KINDS = new Set(
  exactPublisherFormCandidates(currentTakoformCandidates().forms).map(
    ({ identity }) => identity.formRef.kind,
  ),
);

export interface PublicFormImplementationConfiguration {
  readonly implementationPayloadDigest: `sha256:${string}`;
  readonly capabilities: TakoformLifecycleCapabilityManifest;
}

/**
 * The compiled public Host capability surface. It is deliberately derived
 * without a deploy target or environment so an operator cannot select P or I.
 * Target validation separately requires the provider supplies needed to make
 * this exact code-owned manifest truthful.
 */
export function publicFormCapabilityManifest(): TakoformLifecycleCapabilityManifest {
  return yurucommuLifecycleCapabilityManifest(YURUCOMMU_IDENTITY_CAPABILITY_KINDS);
}

/** Derives semantic identity from the sealed runtime payload and exact support set. */
export async function derivePublicFormImplementationIdentity(
  configuration: PublicFormImplementationConfiguration,
): Promise<PublicFormImplementationIdentity> {
  if (!isSha256Digest(configuration.implementationPayloadDigest)) {
    throw new TypeError("public Form implementation payload digest is invalid");
  }
  const catalog = await deriveRuntimeImplementationCatalog(configuration);
  return {
    implementationPayloadDigest: configuration.implementationPayloadDigest,
    capabilityDigest: catalog.capabilityDigest,
    implementationDigest: catalog.implementationDigest,
  };
}

export async function deriveRuntimeImplementationCatalog(
  configuration: PublicFormImplementationConfiguration,
): Promise<TakoformImplementationCatalog> {
  validateCapabilityManifest(configuration.capabilities);
  const implementationPayloadDigest = configuration.implementationPayloadDigest;
  if (!isSha256Digest(implementationPayloadDigest)) {
    throw new TypeError("public Form implementation payload digest is invalid");
  }
  // The publisher projection is the complete installed identity set.  Product
  // support is still narrowed by the capability/handler intersection below;
  // no Form-kind allowlist belongs in this admission path.
  const forms = exactPublisherFormCandidates(currentTakoformCandidates().forms);
  const providerOperations = providerResourceOperationHandlers(
    CloudflareProvider.prototype as unknown as Readonly<Record<string, unknown>>,
  );
  const intrinsicKinds = new Set<string>(TAKOSERVER_INTRINSIC_HANDLER_KINDS);
  const cloudflareKinds = new Set<string>(CLOUDFLARE_TAKOFORM_HANDLER_KINDS);
  const handlers: TakoformHandlerManifest = {
    apiVersion: "takoserver.form-handlers@v1",
    artifact: implementationPayloadDigest,
    forms: Object.fromEntries(
      forms.map(({ identity }) => [
        identity.formRef.kind,
        intrinsicKinds.has(identity.formRef.kind)
          ? RESOURCE_OPERATION_ORDER
          : cloudflareKinds.has(identity.formRef.kind)
            ? providerOperations
            : [],
      ]),
    ),
  };
  return await deriveImplementationCatalog({
    forms,
    capabilities: configuration.capabilities,
    handlers,
  });
}

export function parseFormAuthorityCapabilityManifest(
  value: string,
): TakoformLifecycleCapabilityManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("Form authority capability manifest is invalid");
  }
  validateCapabilityManifest(parsed);
  return structuredClone(parsed as TakoformLifecycleCapabilityManifest);
}

function validateCapabilityManifest(value: unknown): void {
  if (!isRecord(value)) throw new TypeError("Form authority capability manifest is invalid");
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "apiVersion" ||
    keys[1] !== "forms" ||
    keys[2] !== "implementation" ||
    value.apiVersion !== "takoserver.form-lifecycle-capabilities@v1" ||
    typeof value.implementation !== "string" ||
    value.implementation.length < 1 ||
    value.implementation.length > 255 ||
    !isRecord(value.forms)
  ) {
    throw new TypeError("Form authority capability manifest is invalid");
  }
  for (const [kind, operations] of Object.entries(value.forms)) {
    if (
      !FORM_KIND.test(kind) ||
      !CURRENT_PUBLISHER_FORM_KINDS.has(kind) ||
      !Array.isArray(operations) ||
      operations.some((operation) => !RESOURCE_OPERATION_ORDER.includes(operation)) ||
      new Set(operations).size !== operations.length
    ) {
      throw new TypeError("Form authority capability manifest is invalid");
    }
  }
}

/** Derives provider-backed operations from concrete runtime method presence. */
export function providerResourceOperationHandlers(
  surface: Readonly<Record<string, unknown>>,
): readonly TakoformOperation[] {
  const has = (method: string): boolean => typeof surface[method] === "function";
  return RESOURCE_OPERATION_ORDER.filter((operation) => {
    switch (operation) {
      case "create":
      case "update":
        return has("apply");
      case "read":
        return true;
      case "delete":
        return has("delete");
      case "import":
        return has("adopt");
      case "observe":
        return has("observe");
    }
    return false;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
