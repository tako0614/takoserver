import { expect, test } from "bun:test";
import type { NewResourceAttachment } from "../src/attachments.ts";
import type { TakoformInterfaceRef } from "../src/interface-ref.ts";
import type { ResourceDeployment } from "../src/resource-deployments.ts";
import { createS3AttachmentFactory } from "../src/s3-attachment-factory.ts";
import type { S3Access, S3CredentialAuthority } from "../src/s3-port.ts";

const S3 = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "object.s3.takoform.com",
  version: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
} as const;

const providerDeployment = deployment({
  id: "dep_bucket",
  resourceUid: "resource_bucket",
  offeringId: "storage.s3.wasabi.ap-northeast",
  providerPackRef: "wasabi",
  providerInstallationRef: "wasabi.production",
  nativeId: "wasabi:ap-northeast-1:private-native-bucket",
});
const consumerDeployment = deployment({
  id: "dep_worker",
  resourceUid: "resource_worker",
  offeringId: "compute.edge.test",
  providerPackRef: "compute",
  providerInstallationRef: "compute.test",
  nativeId: "worker:private-native-id",
});
const attachment: NewResourceAttachment = {
  tenantId: "organization_123",
  id: "attachment_assets",
  consumerResourceUid: consumerDeployment.resourceUid,
  providerResourceUid: providerDeployment.resourceUid,
  interfaceRef: S3,
  target: "ASSETS",
  permissions: ["read", "write"],
};

test("S3 Attachment resolves only the exact provider deployment to the authenticated grant route", async () => {
  const requested: Array<S3CredentialAuthority> = [];
  const factory = createS3AttachmentFactory({
    providerPackRef: "wasabi",
    interfaceRef: S3,
    issuer: {
      limits(input) {
        requested.push(input);
        return { minimumSeconds: 60, maximumSeconds: 900, defaultSeconds: 300 };
      },
      async issue() {
        throw new Error("resolution must not issue credentials");
      },
    },
  });

  expect(factory.supports({ interfaceRef: S3, providerDeployment, consumerDeployment })).toBe(true);
  const resolution = await factory.resolve({
    operationId: "attachment:create:attachment_assets",
    attachment,
    providerDeployment,
    consumerDeployment,
  });

  expect(resolution).toEqual({
    kind: "credential-grant-ref",
    ref: "/v1/organizations/organization_123/resources/resource_bucket/s3-credentials",
  });
  expect(requested.at(-1)).toMatchObject({
    organizationId: "organization_123",
    resourceUid: "resource_bucket",
    deploymentId: "dep_bucket",
    offeringId: "storage.s3.wasabi.ap-northeast",
    providerPackRef: "wasabi",
    providerInstallationRef: "wasabi.production",
    access: "read-write",
  });
  expect(JSON.stringify(resolution)).not.toContain(providerDeployment.nativeId);
  expect(JSON.stringify(resolution)).not.toContain(consumerDeployment.nativeId);
});

test("S3 Attachment fails closed for another interface, provider, or access authority", async () => {
  const allowedAccess: S3Access = "read-only";
  const factory = createS3AttachmentFactory({
    providerPackRef: "wasabi",
    interfaceRef: S3,
    issuer: {
      limits(input) {
        return input.providerPackRef === "wasabi" && input.access === allowedAccess
          ? { minimumSeconds: 60, maximumSeconds: 900, defaultSeconds: 300 }
          : null;
      },
      async issue() {
        throw new Error("not used");
      },
    },
  });
  const foreignInterface: TakoformInterfaceRef = {
    ...S3,
    schemaDigest: `sha256:${"b".repeat(64)}`,
  };

  expect(
    factory.supports({ interfaceRef: foreignInterface, providerDeployment, consumerDeployment }),
  ).toBe(false);
  expect(
    factory.supports({
      interfaceRef: S3,
      providerDeployment: { ...providerDeployment, providerPackRef: "cloudflare" },
      consumerDeployment,
    }),
  ).toBe(false);
  expect(
    factory.resolve({
      operationId: "attachment:create:attachment_assets",
      attachment,
      providerDeployment,
      consumerDeployment,
    }),
  ).rejects.toThrow("S3 attachment credential authority unavailable");
});

function deployment(
  identity: Pick<
    ResourceDeployment,
    "id" | "resourceUid" | "offeringId" | "providerPackRef" | "providerInstallationRef" | "nativeId"
  >,
): ResourceDeployment {
  return {
    tenantId: "organization_123",
    ...identity,
    state: "active",
    observed: {},
    outputs: {},
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
}
