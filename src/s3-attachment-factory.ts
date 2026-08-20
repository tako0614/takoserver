import type { AttachmentFactory, AttachmentResolution } from "./attachments.ts";
import type { TakoformInterfaceRef } from "./interface-ref.ts";
import type { S3Access, S3CredentialIssuer } from "./s3-port.ts";

/** Resolves an ObjectBucket Attachment to the existing authenticated S3 grant endpoint. */
export function createS3AttachmentFactory(options: {
  readonly providerPackRef: string;
  readonly interfaceRef: TakoformInterfaceRef;
  readonly issuer: S3CredentialIssuer;
}): AttachmentFactory {
  return {
    id: `${options.providerPackRef}-s3-credentials`,
    providerPackRef: options.providerPackRef,
    supports({ interfaceRef, providerDeployment }) {
      return (
        sameInterface(interfaceRef, options.interfaceRef) &&
        authority(options.issuer, providerDeployment, "read-only")
      );
    },
    async resolve({ attachment, providerDeployment }): Promise<AttachmentResolution> {
      if (!sameInterface(attachment.interfaceRef, options.interfaceRef)) {
        throw new TypeError("S3 attachment interface mismatch");
      }
      const access = attachment.permissions.some((permission) =>
        ["write", "mutate", "delete"].includes(permission),
      )
        ? "read-write"
        : "read-only";
      if (!authority(options.issuer, providerDeployment, access)) {
        throw new TypeError("S3 attachment credential authority unavailable");
      }
      return {
        kind: "credential-grant-ref",
        ref: `/v1/organizations/${encodeURIComponent(attachment.tenantId)}/resources/${encodeURIComponent(attachment.providerResourceUid)}/s3-credentials`,
      };
    },
  };
}

function authority(
  issuer: S3CredentialIssuer,
  deployment: Parameters<AttachmentFactory["supports"]>[0]["providerDeployment"],
  access: S3Access,
): boolean {
  return Boolean(
    issuer.limits({
      organizationId: deployment.tenantId,
      resourceUid: deployment.resourceUid,
      deploymentId: deployment.id,
      offeringId: deployment.offeringId,
      providerPackRef: deployment.providerPackRef,
      providerInstallationRef: deployment.providerInstallationRef,
      nativeId: deployment.nativeId,
      access,
    }),
  );
}

function sameInterface(left: TakoformInterfaceRef, right: TakoformInterfaceRef): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.name === right.name &&
    left.version === right.version &&
    left.schemaDigest === right.schemaDigest
  );
}
