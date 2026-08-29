import { INTEGRATION_FORM_PACKAGES } from "../generated/takoform-integration-form-packages.ts";
import type { JsonObject, ObjectStore, Sql } from "../ports.ts";
import type { PublicHostIdentityRpc } from "../public-host-identity.ts";
import { createIntegrationFixtureEvidenceVerifier } from "./form-authority-verification.ts";
import type { FormPackageInput } from "./form-packages.ts";
import {
  createExactFormPackageSource,
  createFormAuthorityComposition,
  type FormAuthorityComposition,
  type FormAuthorityEndpointConfiguration,
} from "./host-admission-endpoint.ts";

/**
 * Integration-only fixture bridge. Callers must reject the environment before
 * acquiring credentials or reading bindings, then pass the already-selected
 * D1/R2 adapters here.
 */
export async function createIntegrationFormAuthorityComposition(input: {
  readonly configuration: FormAuthorityEndpointConfiguration;
  readonly bindings: {
    readonly sql: Sql;
    readonly objects: ObjectStore;
    readonly publicHostIdentity: PublicHostIdentityRpc;
  };
}): Promise<FormAuthorityComposition> {
  if (input.configuration.environment !== "integration") {
    throw new TypeError("integration Form authority refuses every non-integration environment");
  }
  const packages = integrationFormPackages();
  const verifier = createIntegrationFixtureEvidenceVerifier({
    packages: packages.map((pkg) => ({
      formRef: pkg.formRef,
      packageDigest: pkg.packageDigest,
    })),
  });
  return createFormAuthorityComposition({
    ...input,
    verifier,
    packages: createExactFormPackageSource(packages),
  });
}

function integrationFormPackages(): readonly FormPackageInput[] {
  return INTEGRATION_FORM_PACKAGES.map((pkg) => ({
    packageDigest: pkg.packageDigest,
    formRef: structuredClone(pkg.formRef),
    manifest: structuredClone(pkg.manifest) as JsonObject,
    files: pkg.files.map((file) => ({
      path: file.path,
      digest: file.digest,
      ...("mediaType" in file ? { mediaType: file.mediaType } : {}),
      bytes: decodeBase64(file.base64),
    })),
  }));
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
