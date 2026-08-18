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
    /** Stable across retries of one create, cutover, or rollback. */
    readonly operationId: string;
    readonly attachment: NewResourceAttachment;
    readonly providerDeployment: ResourceDeployment;
    readonly consumerDeployment: ResourceDeployment;
  }): Promise<AttachmentResolution>;
}

export interface AttachmentRebinding {
  readonly id: string;
  readonly oldProviderDeploymentId: string;
  readonly oldConsumerDeploymentId: string;
  readonly oldResolution: AttachmentResolution;
  readonly newProviderDeploymentId: string;
  readonly newConsumerDeploymentId: string;
  readonly newResolution: AttachmentResolution;
}

export interface AttachmentStore {
  create(input: ResourceAttachment): Promise<void>;
  read(tenantId: string, id: string): Promise<ResourceAttachment | null>;
  list(
    tenantId: string,
    options: { readonly resourceUid?: string; readonly limit: number },
  ): Promise<readonly ResourceAttachment[]>;
  remove(tenantId: string, id: string): Promise<boolean>;
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
      | "attachment_unsupported"
      | "attachment_conflict",
  ) {
    super(code);
    this.name = "AttachmentError";
  }
}

export interface AttachmentService {
  createAndResolve(input: NewResourceAttachment): Promise<ResourceAttachment>;
  blocksDeletion(tenantId: string, resourceUid: string): Promise<readonly string[]>;
  read(tenantId: string, id: string): Promise<ResourceAttachment | null>;
  list(
    tenantId: string,
    options: { readonly resourceUid?: string; readonly limit: number },
  ): Promise<readonly ResourceAttachment[]>;
  remove(tenantId: string, id: string): Promise<void>;
  prepareMigrationRebindings(input: {
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly sourceDeployment: ResourceDeployment;
    readonly targetDeployment: ResourceDeployment;
    readonly operationId: string;
  }): Promise<readonly AttachmentRebinding[]>;
}

export function createAttachmentService(options: {
  readonly store: AttachmentStore;
  readonly deployments: Pick<ResourceDeploymentStore, "active">;
  readonly factories: readonly AttachmentFactory[];
  readonly clock: Clock;
  readonly resource: (tenantId: string, uid: string) => Promise<AttachmentResourceView | null>;
}): AttachmentService {
  const resolve = async (
    attachment: NewResourceAttachment,
    providerDeployment: ResourceDeployment,
    consumerDeployment: ResourceDeployment,
    operationId: string,
  ): Promise<AttachmentResolution> => {
    const matchingFactories = options.factories.filter(
      (factory) =>
        factory.providerPackRef === providerDeployment.providerPackRef &&
        factory.supports({
          interfaceRef: attachment.interfaceRef,
          providerDeployment,
          consumerDeployment,
        }),
    );
    if (matchingFactories.length !== 1) {
      throw new AttachmentError("attachment_unsupported");
    }
    const [factory] = matchingFactories;
    if (!factory) throw new AttachmentError("attachment_unsupported");
    return safeResolution(
      await factory.resolve({
        operationId,
        attachment,
        providerDeployment,
        consumerDeployment,
      }),
    );
  };

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
      const resolution = await resolve(
        input,
        providerDeployment,
        consumerDeployment,
        `attachment:create:${input.id}`,
      );
      const now = options.clock().toISOString();
      const attachment: ResourceAttachment = {
        ...structuredClone(input),
        state: "active",
        providerDeploymentId: providerDeployment.id,
        consumerDeploymentId: consumerDeployment.id,
        resolution,
        createdAt: now,
        updatedAt: now,
      };
      await options.store.create(attachment);
      return structuredClone(attachment);
    },

    async blocksDeletion(tenantId: string, resourceUid: string): Promise<readonly string[]> {
      return await options.store.blocking(tenantId, resourceUid);
    },

    async read(tenantId: string, id: string): Promise<ResourceAttachment | null> {
      return await options.store.read(tenantId, id);
    },

    async list(
      tenantId: string,
      listOptions: { readonly resourceUid?: string; readonly limit: number },
    ): Promise<readonly ResourceAttachment[]> {
      if (
        !Number.isSafeInteger(listOptions.limit) ||
        listOptions.limit < 1 ||
        listOptions.limit > 200
      ) {
        throw new AttachmentError("attachment_unsupported");
      }
      return await options.store.list(tenantId, listOptions);
    },

    async remove(tenantId: string, id: string): Promise<void> {
      if (!(await options.store.remove(tenantId, id))) {
        throw new AttachmentError("resource_not_found");
      }
    },

    async prepareMigrationRebindings(input): Promise<readonly AttachmentRebinding[]> {
      if (
        input.sourceDeployment.resourceUid !== input.resourceUid ||
        input.targetDeployment.resourceUid !== input.resourceUid
      ) {
        throw new AttachmentError("deployment_not_ready");
      }
      const held = await options.store.list(input.tenantId, {
        resourceUid: input.resourceUid,
        limit: 101,
      });
      if (held.length > 100) throw new AttachmentError("attachment_unsupported");
      return await Promise.all(
        held.map(async (attachment): Promise<AttachmentRebinding> => {
          if (attachment.state !== "active") {
            throw new AttachmentError("deployment_not_ready");
          }
          const providerMoves = attachment.providerResourceUid === input.resourceUid;
          const consumerMoves = attachment.consumerResourceUid === input.resourceUid;
          if (providerMoves === consumerMoves) {
            throw new AttachmentError("attachment_unsupported");
          }
          const otherResourceUid = providerMoves
            ? attachment.consumerResourceUid
            : attachment.providerResourceUid;
          const other = await options.deployments.active(input.tenantId, otherResourceUid);
          if (!other) throw new AttachmentError("deployment_not_ready");
          if (
            (providerMoves &&
              (attachment.providerDeploymentId !== input.sourceDeployment.id ||
                attachment.consumerDeploymentId !== other.id)) ||
            (consumerMoves &&
              (attachment.consumerDeploymentId !== input.sourceDeployment.id ||
                attachment.providerDeploymentId !== other.id))
          ) {
            throw new AttachmentError("deployment_not_ready");
          }
          const providerDeployment = providerMoves ? input.targetDeployment : other;
          const consumerDeployment = consumerMoves ? input.targetDeployment : other;
          const next = await resolve(
            attachment,
            providerDeployment,
            consumerDeployment,
            `${input.operationId}:${attachment.id}`,
          );
          return {
            id: attachment.id,
            oldProviderDeploymentId: attachment.providerDeploymentId,
            oldConsumerDeploymentId: attachment.consumerDeploymentId,
            oldResolution: attachment.resolution,
            newProviderDeploymentId: providerDeployment.id,
            newConsumerDeploymentId: consumerDeployment.id,
            newResolution: next,
          };
        }),
      );
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
    input.permissions.some((permission) => !safeIdentifier(permission, 1, 128)) ||
    input.interfaceRef.apiVersion !== "interfaces.takoform.com/v1alpha1" ||
    !safeIdentifier(input.interfaceRef.name, 1, 255) ||
    !safeIdentifier(input.interfaceRef.version, 1, 64) ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.interfaceRef.schemaDigest)
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
        `INSERT OR IGNORE INTO tf_resource_attachments
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
      if (written.changes !== 1) throw new AttachmentError("attachment_conflict");
    },

    async read(tenantId, id): Promise<ResourceAttachment | null> {
      const rows = await sql.query(
        `SELECT * FROM tf_resource_attachments
         WHERE tenant_id = ? AND id = ? AND state <> 'deleted' LIMIT 2`,
        [tenantId, id],
      );
      if (rows.length > 1) throw new Error("resource_attachment_ambiguous");
      return rows[0] ? attachment(rows[0]) : null;
    },

    async list(tenantId, options): Promise<readonly ResourceAttachment[]> {
      const rows = options.resourceUid
        ? await sql.query(
            `SELECT * FROM tf_resource_attachments
             WHERE tenant_id = ? AND state <> 'deleted'
               AND (consumer_resource_uid = ? OR provider_resource_uid = ?)
             ORDER BY created_at, id LIMIT ?`,
            [tenantId, options.resourceUid, options.resourceUid, options.limit],
          )
        : await sql.query(
            `SELECT * FROM tf_resource_attachments
             WHERE tenant_id = ? AND state <> 'deleted'
             ORDER BY created_at, id LIMIT ?`,
            [tenantId, options.limit],
          );
      return rows.map(attachment);
    },

    async remove(tenantId, id): Promise<boolean> {
      const changed = await sql.run(
        `UPDATE tf_resource_attachments SET state = 'deleted', updated_at = ?
         WHERE tenant_id = ? AND id = ? AND state <> 'deleted'`,
        [clock().getTime(), tenantId, id],
      );
      return changed.changes === 1;
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

function attachment(row: Row): ResourceAttachment {
  return {
    tenantId: text(row, "tenant_id"),
    id: text(row, "id"),
    consumerResourceUid: text(row, "consumer_resource_uid"),
    providerResourceUid: text(row, "provider_resource_uid"),
    interfaceRef: interfaceRef(row.interface_ref_json),
    target: text(row, "target"),
    permissions: stringList(row.permissions_json),
    state: attachmentState(row.state),
    providerDeploymentId: text(row, "provider_deployment_id"),
    consumerDeploymentId: text(row, "consumer_deployment_id"),
    resolution: resolution(row.resolution_json),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function interfaceRef(value: unknown): TakoformInterfaceRef {
  const parsed = jsonRecord(value);
  if (
    parsed.apiVersion !== "interfaces.takoform.com/v1alpha1" ||
    typeof parsed.name !== "string" ||
    typeof parsed.version !== "string" ||
    typeof parsed.schemaDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(parsed.schemaDigest)
  ) {
    throw new Error("resource_attachment_row_invalid");
  }
  return parsed as unknown as TakoformInterfaceRef;
}

function stringList(value: unknown): readonly string[] {
  const parsed: unknown = JSON.parse(serialized(value));
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("resource_attachment_row_invalid");
  }
  return parsed;
}

function resolution(value: unknown): AttachmentResolution {
  const parsed = jsonRecord(value);
  return safeResolution(parsed as unknown as AttachmentResolution);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(serialized(value));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("resource_attachment_row_invalid");
  }
  return parsed as Record<string, unknown>;
}

function serialized(value: unknown): string {
  if (typeof value !== "string") throw new Error("resource_attachment_row_invalid");
  return value;
}

function attachmentState(value: unknown): ResourceAttachment["state"] {
  if (value !== "active" && value !== "stale" && value !== "deleted") {
    throw new Error("resource_attachment_row_invalid");
  }
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("resource_attachment_row_invalid");
  }
  return new Date(value).toISOString();
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
