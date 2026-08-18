import type { TakoformInterfaceRef } from "./interface-ref.ts";
import type { Clock, Row, Sql } from "./ports.ts";
import type { ResourceDeployment, ResourceDeploymentStore } from "./resource-deployments.ts";

export type AttachmentResolution =
  | { readonly kind: "credential-grant-ref"; readonly ref: string }
  | { readonly kind: "secret-ref"; readonly ref: string }
  | { readonly kind: "endpoint-ref"; readonly ref: string }
  | { readonly kind: "native-binding-ref"; readonly ref: string };

export interface ResourceAttachment {
  readonly tenantId: string;
  readonly id: string;
  readonly consumerResourceUid: string;
  readonly providerResourceUid: string;
  readonly interfaceRef: TakoformInterfaceRef;
  readonly target: string;
  readonly permissions: readonly string[];
  readonly state: "active" | "stale" | "deleted";
  readonly providerDeploymentId: string;
  readonly consumerDeploymentId: string;
  readonly resolution: AttachmentResolution;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewResourceAttachment {
  readonly tenantId: string;
  readonly id: string;
  readonly consumerResourceUid: string;
  readonly providerResourceUid: string;
  readonly interfaceRef: TakoformInterfaceRef;
  readonly target: string;
  readonly permissions: readonly string[];
}

export interface AttachmentFactory {
  readonly id: string;
  /** The provider Deployment's pack selects the factory; Form identity does not. */
  readonly providerPackRef: string;
  supports(input: {
    readonly interfaceRef: TakoformInterfaceRef;
    readonly providerDeployment: ResourceDeployment;
    readonly consumerDeployment: ResourceDeployment;
  }): boolean;
  resolve(input: {
    readonly attachment: NewResourceAttachment;
    readonly providerDeployment: ResourceDeployment;
    readonly consumerDeployment: ResourceDeployment;
  }): Promise<AttachmentResolution>;
}

export interface AttachmentStore {
  create(input: ResourceAttachment): Promise<void>;
  blocking(tenantId: string, resourceUid: string): Promise<readonly string[]>;
}

export interface AttachmentResourceView {
  readonly uid: string;
  readonly providedInterfaces: readonly TakoformInterfaceRef[];
}

export class AttachmentError extends Error {
  constructor(
    readonly code:
      | "resource_not_found"
      | "interface_not_provided"
      | "deployment_not_ready"
      | "attachment_unsupported",
  ) {
    super(code);
    this.name = "AttachmentError";
  }
}

export function createAttachmentService(options: {
  readonly store: AttachmentStore;
  readonly deployments: Pick<ResourceDeploymentStore, "active">;
  readonly factories: readonly AttachmentFactory[];
  readonly clock: Clock;
  readonly resource: (tenantId: string, uid: string) => Promise<AttachmentResourceView | null>;
}) {
  return {
    async createAndResolve(input: NewResourceAttachment): Promise<ResourceAttachment> {
      validateAttachmentInput(input);
      if (input.consumerResourceUid === input.providerResourceUid) {
        throw new AttachmentError("attachment_unsupported");
      }
      const [consumer, provider, consumerDeployment, providerDeployment] = await Promise.all([
        options.resource(input.tenantId, input.consumerResourceUid),
        options.resource(input.tenantId, input.providerResourceUid),
        options.deployments.active(input.tenantId, input.consumerResourceUid),
        options.deployments.active(input.tenantId, input.providerResourceUid),
      ]);
      if (!consumer || !provider) throw new AttachmentError("resource_not_found");
      if (
        !provider.providedInterfaces.some((candidate) =>
          sameInterface(candidate, input.interfaceRef),
        )
      ) {
        throw new AttachmentError("interface_not_provided");
      }
      if (!consumerDeployment || !providerDeployment) {
        throw new AttachmentError("deployment_not_ready");
      }
      const matchingFactories = options.factories.filter(
        (factory) =>
          factory.providerPackRef === providerDeployment.providerPackRef &&
          factory.supports({
            interfaceRef: input.interfaceRef,
            providerDeployment,
            consumerDeployment,
          }),
      );
      if (matchingFactories.length !== 1) {
        throw new AttachmentError("attachment_unsupported");
      }
      const [factory] = matchingFactories;
      if (!factory) throw new AttachmentError("attachment_unsupported");
      const resolution = await factory.resolve({
        attachment: input,
        providerDeployment,
        consumerDeployment,
      });
      const now = options.clock().toISOString();
      const attachment: ResourceAttachment = {
        ...structuredClone(input),
        state: "active",
        providerDeploymentId: providerDeployment.id,
        consumerDeploymentId: consumerDeployment.id,
        resolution: safeResolution(resolution),
        createdAt: now,
        updatedAt: now,
      };
      await options.store.create(attachment);
      return structuredClone(attachment);
    },

    async blocksDeletion(tenantId: string, resourceUid: string): Promise<readonly string[]> {
      return await options.store.blocking(tenantId, resourceUid);
    },
  };
}

function validateAttachmentInput(input: NewResourceAttachment): void {
  if (
    !safeIdentifier(input.id, 3, 128) ||
    !safeIdentifier(input.consumerResourceUid, 3, 128) ||
    !safeIdentifier(input.providerResourceUid, 3, 128) ||
    !safeIdentifier(input.target, 1, 255) ||
    input.permissions.length < 1 ||
    input.permissions.length > 32 ||
    new Set(input.permissions).size !== input.permissions.length ||
    input.permissions.some((permission) => !safeIdentifier(permission, 1, 128))
  ) {
    throw new AttachmentError("attachment_unsupported");
  }
}

function safeIdentifier(value: string, minimum: number, maximum: number): boolean {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    !hasControlCharacter(value)
  );
}

export function createAttachmentStore(sql: Sql, clock: Clock): AttachmentStore {
  return {
    async create(input): Promise<void> {
      const now = clock().getTime();
      const written = await sql.run(
        `INSERT INTO tf_resource_attachments
           (tenant_id, id, consumer_resource_uid, provider_resource_uid,
            interface_ref_json, target, permissions_json, state,
            provider_deployment_id, consumer_deployment_id, resolution_json,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.tenantId,
          input.id,
          input.consumerResourceUid,
          input.providerResourceUid,
          JSON.stringify(input.interfaceRef),
          input.target,
          JSON.stringify(input.permissions),
          input.state,
          input.providerDeploymentId,
          input.consumerDeploymentId,
          JSON.stringify(input.resolution),
          now,
          now,
        ],
      );
      if (written.changes !== 1) throw new Error("resource_attachment_create_failed");
    },

    async blocking(tenantId, resourceUid): Promise<readonly string[]> {
      const rows = await sql.query(
        `SELECT id FROM tf_resource_attachments
         WHERE tenant_id = ? AND state <> 'deleted'
           AND (consumer_resource_uid = ? OR provider_resource_uid = ?)
         ORDER BY id LIMIT 101`,
        [tenantId, resourceUid, resourceUid],
      );
      if (rows.length > 100) throw new Error("resource_attachment_inventory_too_large");
      return rows.map((row) => text(row, "id"));
    },
  };
}

function sameInterface(left: TakoformInterfaceRef, right: TakoformInterfaceRef): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.name === right.name &&
    left.version === right.version &&
    left.schemaDigest === right.schemaDigest
  );
}

function safeResolution(value: AttachmentResolution): AttachmentResolution {
  if (
    value.kind !== "credential-grant-ref" &&
    value.kind !== "secret-ref" &&
    value.kind !== "endpoint-ref" &&
    value.kind !== "native-binding-ref"
  ) {
    throw new AttachmentError("attachment_unsupported");
  }
  if (
    typeof value.ref !== "string" ||
    value.ref.length < 3 ||
    value.ref.length > 512 ||
    hasControlCharacter(value.ref)
  ) {
    throw new AttachmentError("attachment_unsupported");
  }
  return { kind: value.kind, ref: value.ref };
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 0x20 || code === 0x7f);
  });
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("resource_attachment_row_invalid");
  return value;
}
