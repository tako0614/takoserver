import type { Catalog, Offering } from "./catalog.ts";
import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import type { Clock, JsonObject, Row, Sql } from "./ports.ts";
import type { ProviderPack, TransferEndpoint } from "./provider-pack.ts";
import type { ProviderResult, ProviderTicket } from "./provider-port.ts";
import type { ResourceDeploymentStore } from "./resource-deployments.ts";

export type ResourceMigrationState =
  | "planned"
  | "provisioning"
  | "transferring"
  | "verified"
  | "completed"
  | "rolled_back"
  | "failed";

export interface MigrationVerification {
  readonly schema: boolean;
  readonly rowCounts: boolean;
  readonly checksums: boolean;
  readonly evidenceDigest: `sha256:${string}`;
}

export interface ResourceMigration {
  readonly tenantId: string;
  readonly id: string;
  readonly resourceUid: string;
  readonly sourceDeploymentId: string;
  readonly targetDeploymentId: string;
  readonly targetOfferingId: string;
  readonly targetProviderPackRef: string;
  readonly targetProviderInstallationRef: string;
  readonly commercialAuthorizationRef: string;
  readonly mode: "offline" | "online";
  readonly transferFormat: string;
  readonly state: ResourceMigrationState;
  readonly verification?: MigrationVerification;
  readonly rollbackUntil?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MigrationResourceView {
  readonly uid: string;
  readonly form: TakoformV1Alpha3FormRef;
  readonly space: string;
  readonly name: string;
  readonly spec: JsonObject;
}

export interface PlanResourceMigration {
  readonly tenantId: string;
  readonly id: string;
  readonly resourceUid: string;
  readonly targetOfferingId: string;
  readonly commercialAuthorizationRef: string;
  readonly mode: "offline" | "online";
  readonly transferFormat: string;
}

export interface ResourceMigrationStore {
  create(input: ResourceMigration): Promise<void>;
  read(tenantId: string, id: string): Promise<ResourceMigration | null>;
  claim(tenantId: string, id: string): Promise<ResourceMigration | null>;
  transferring(tenantId: string, id: string): Promise<boolean>;
  verified(
    tenantId: string,
    id: string,
    verification: MigrationVerification,
    rollbackUntil: number,
  ): Promise<boolean>;
  cutover(migration: ResourceMigration): Promise<boolean>;
  rollback(migration: ResourceMigration): Promise<boolean>;
}

export class ResourceMigrationError extends Error {
  constructor(
    readonly code:
      | "resource_not_found"
      | "migration_conflict"
      | "offering_invalid"
      | "transfer_unsupported"
      | "verification_failed"
      | "attachment_rebind_required"
      | "rollback_expired"
      | "backend_unavailable",
  ) {
    super(code);
    this.name = "ResourceMigrationError";
  }
}

export function createResourceMigrationService(options: {
  readonly store: ResourceMigrationStore;
  readonly deployments: ResourceDeploymentStore;
  readonly catalog: Catalog;
  readonly packs: readonly ProviderPack[];
  readonly resource: (tenantId: string, uid: string) => Promise<MigrationResourceView | null>;
  readonly blockingAttachments: (tenantId: string, uid: string) => Promise<readonly string[]>;
  readonly clock: Clock;
  readonly rollbackWindowMilliseconds?: number;
  readonly pollBudget?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}) {
  const packs = new Map(options.packs.map((pack) => [pack.id, pack]));
  const rollbackWindow = options.rollbackWindowMilliseconds ?? 24 * 60 * 60 * 1_000;
  const pollBudget = options.pollBudget ?? 10;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const pack = (id: string): ProviderPack => {
    const found = packs.get(id);
    if (!found) throw new ResourceMigrationError("offering_invalid");
    return found;
  };

  const transferEndpoint = (
    providerPack: ProviderPack,
    direction: "export" | "import",
    mode: "offline" | "online",
    format: string,
  ): TransferEndpoint => {
    const matches = providerPack.transferEndpoints.filter(
      (endpoint) =>
        endpoint.migrationModes.includes(mode) &&
        (direction === "export"
          ? endpoint.exportFormats.includes(format)
          : endpoint.importFormats.includes(format)),
    );
    if (matches.length !== 1 || !matches[0]) {
      throw new ResourceMigrationError("transfer_unsupported");
    }
    return matches[0];
  };

  const settle = async (
    provisioner: ReturnType<ProviderPack["provisionerForOffering"]>,
    operationId: string,
    first: ProviderTicket,
  ): Promise<ProviderResult> => {
    let ticket = first;
    for (let attempt = 0; ticket.phase === "running" && attempt < pollBudget; attempt += 1) {
      if (!provisioner.poll) break;
      await sleep(ticket.pollAfterMs);
      ticket = await provisioner.poll({ operationId, handle: ticket.handle });
    }
    if (ticket.phase !== "succeeded") throw new ResourceMigrationError("backend_unavailable");
    return ticket.result;
  };

  return {
    async plan(input: PlanResourceMigration): Promise<ResourceMigration> {
      validIdentifier(input.id);
      validIdentifier(input.commercialAuthorizationRef);
      const [resource, source, target] = await Promise.all([
        options.resource(input.tenantId, input.resourceUid),
        options.deployments.active(input.tenantId, input.resourceUid),
        Promise.resolve(options.catalog.findOffering(input.targetOfferingId)),
      ]);
      if (!resource || !source) throw new ResourceMigrationError("resource_not_found");
      if (!target || !sameForm(target.form, resource.form) || target.id === source.offeringId) {
        throw new ResourceMigrationError("offering_invalid");
      }
      const sourcePack = pack(source.providerPackRef);
      const targetPack = pack(target.providerPackRef);
      transferEndpoint(sourcePack, "export", input.mode, input.transferFormat);
      transferEndpoint(targetPack, "import", input.mode, input.transferFormat);
      targetPack.provisionerForOffering(target.id);
      const now = options.clock().toISOString();
      const migration: ResourceMigration = {
        ...structuredClone(input),
        sourceDeploymentId: source.id,
        targetDeploymentId: `dep_${input.id}_target`,
        targetProviderPackRef: target.providerPackRef,
        targetProviderInstallationRef: target.providerInstallationRef,
        state: "planned",
        createdAt: now,
        updatedAt: now,
      };
      try {
        await options.store.create(migration);
      } catch {
        throw new ResourceMigrationError("migration_conflict");
      }
      return structuredClone(migration);
    },

    async execute(tenantId: string, id: string): Promise<ResourceMigration> {
      const migration = await options.store.claim(tenantId, id);
      if (
        !migration ||
        (migration.state !== "provisioning" && migration.state !== "transferring")
      ) {
        throw new ResourceMigrationError("migration_conflict");
      }
      const [resource, source] = await Promise.all([
        options.resource(tenantId, migration.resourceUid),
        options.deployments.find(tenantId, migration.sourceDeploymentId),
      ]);
      if (!resource || !source || source.state !== "active") {
        throw new ResourceMigrationError("resource_not_found");
      }
      const targetOffering = exactOffering(options.catalog, migration);
      const targetPack = pack(migration.targetProviderPackRef);
      const provisioner = targetPack.provisionerForOffering(targetOffering.id);
      let target = await options.deployments.find(tenantId, migration.targetDeploymentId);
      if (!target) {
        const providerOffering = provisioner.offerings.find(
          (offering) => offering.id === targetOffering.id,
        );
        if (!providerOffering) throw new ResourceMigrationError("offering_invalid");
        const result = await settle(
          provisioner,
          `${migration.id}:provision`,
          await provisioner.apply({
            operationId: `${migration.id}:provision`,
            offering: providerOffering,
            identity: { tenantRef: tenantId, space: resource.space, name: resource.name },
            spec: resource.spec,
          }),
        );
        await options.deployments.create({
          tenantId,
          id: migration.targetDeploymentId,
          resourceUid: migration.resourceUid,
          offeringId: targetOffering.id,
          providerPackRef: targetOffering.providerPackRef,
          providerInstallationRef: targetOffering.providerInstallationRef,
          nativeId: result.nativeId,
          state: "candidate",
          observed: result.observed,
          outputs: result.outputs,
        });
        target = await options.deployments.find(tenantId, migration.targetDeploymentId);
      }
      if (!target || target.state !== "candidate") {
        throw new ResourceMigrationError("migration_conflict");
      }
      if (migration.state === "provisioning" && !(await options.store.transferring(tenantId, id))) {
        throw new ResourceMigrationError("migration_conflict");
      }
      const sourceEndpoint = transferEndpoint(
        pack(source.providerPackRef),
        "export",
        migration.mode,
        migration.transferFormat,
      );
      const targetEndpoint = transferEndpoint(
        targetPack,
        "import",
        migration.mode,
        migration.transferFormat,
      );
      const transfer = await sourceEndpoint.export({
        operationId: `${migration.id}:export`,
        tenantId,
        source,
        format: migration.transferFormat,
      });
      await targetEndpoint.import({
        operationId: `${migration.id}:import`,
        tenantId,
        target,
        transferRef: transfer.transferRef,
        format: migration.transferFormat,
      });
      const verification = await targetEndpoint.verify({
        operationId: `${migration.id}:verify`,
        tenantId,
        source,
        target,
        requirements: { schema: true, rowCounts: true, checksums: true },
      });
      if (!verification.schema || !verification.rowCounts || !verification.checksums) {
        throw new ResourceMigrationError("verification_failed");
      }
      const rollbackUntil = options.clock().getTime() + rollbackWindow;
      if (!(await options.store.verified(tenantId, id, verification, rollbackUntil))) {
        throw new ResourceMigrationError("migration_conflict");
      }
      const verified = await options.store.read(tenantId, id);
      if (!verified) throw new ResourceMigrationError("migration_conflict");
      return verified;
    },

    async cutover(tenantId: string, id: string): Promise<ResourceMigration> {
      const migration = await options.store.read(tenantId, id);
      if (!migration || migration.state !== "verified") {
        throw new ResourceMigrationError("migration_conflict");
      }
      if ((await options.blockingAttachments(tenantId, migration.resourceUid)).length > 0) {
        throw new ResourceMigrationError("attachment_rebind_required");
      }
      if (!(await options.store.cutover(migration))) {
        throw new ResourceMigrationError("migration_conflict");
      }
      const completed = await options.store.read(tenantId, id);
      if (!completed) throw new ResourceMigrationError("migration_conflict");
      return completed;
    },

    async rollback(tenantId: string, id: string): Promise<ResourceMigration> {
      const migration = await options.store.read(tenantId, id);
      if (!migration || migration.state !== "completed") {
        throw new ResourceMigrationError("migration_conflict");
      }
      if (
        !migration.rollbackUntil ||
        Date.parse(migration.rollbackUntil) < options.clock().getTime()
      ) {
        throw new ResourceMigrationError("rollback_expired");
      }
      if ((await options.blockingAttachments(tenantId, migration.resourceUid)).length > 0) {
        throw new ResourceMigrationError("attachment_rebind_required");
      }
      if (!(await options.store.rollback(migration))) {
        throw new ResourceMigrationError("migration_conflict");
      }
      const rolledBack = await options.store.read(tenantId, id);
      if (!rolledBack) throw new ResourceMigrationError("migration_conflict");
      return rolledBack;
    },
  };
}

export function createResourceMigrationStore(sql: Sql, clock: Clock): ResourceMigrationStore {
  const now = () => clock().getTime();
  return {
    async create(input) {
      const timestamp = now();
      const result = await sql.run(
        `INSERT INTO tf_resource_migrations
           (tenant_id, id, resource_uid, source_deployment_id, target_deployment_id,
            target_offering_id, target_provider_pack_ref, target_provider_installation_ref,
            commercial_authorization_ref, mode, transfer_format, state,
            verification_json, rollback_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        [
          input.tenantId,
          input.id,
          input.resourceUid,
          input.sourceDeploymentId,
          input.targetDeploymentId,
          input.targetOfferingId,
          input.targetProviderPackRef,
          input.targetProviderInstallationRef,
          input.commercialAuthorizationRef,
          input.mode,
          input.transferFormat,
          input.state,
          timestamp,
          timestamp,
        ],
      );
      if (result.changes !== 1) throw new Error("resource_migration_create_failed");
    },

    async read(tenantId, id) {
      const rows = await sql.query(
        "SELECT * FROM tf_resource_migrations WHERE tenant_id = ? AND id = ? LIMIT 2",
        [tenantId, id],
      );
      if (rows.length > 1) throw new Error("resource_migration_ambiguous");
      return rows[0] ? migration(rows[0]) : null;
    },

    async claim(tenantId, id) {
      await sql.run(
        `UPDATE tf_resource_migrations SET state = 'provisioning', updated_at = ?
         WHERE tenant_id = ? AND id = ? AND state = 'planned'`,
        [now(), tenantId, id],
      );
      return await this.read(tenantId, id);
    },

    async transferring(tenantId, id) {
      const result = await sql.run(
        `UPDATE tf_resource_migrations SET state = 'transferring', updated_at = ?
         WHERE tenant_id = ? AND id = ? AND state = 'provisioning'`,
        [now(), tenantId, id],
      );
      return result.changes === 1;
    },

    async verified(tenantId, id, verification, rollbackUntil) {
      const result = await sql.run(
        `UPDATE tf_resource_migrations
         SET state = 'verified', verification_json = ?, rollback_until = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND state = 'transferring'`,
        [JSON.stringify(verification), rollbackUntil, now(), tenantId, id],
      );
      return result.changes === 1;
    },

    async cutover(input) {
      const timestamp = now();
      const results = await sql.batch([
        {
          sql: `UPDATE tf_resource_deployments
                SET state = 'retained', updated_at = ?
                WHERE tenant_id = ? AND resource_uid = ? AND id = ? AND state = 'active'
                  AND EXISTS (
                    SELECT 1 FROM tf_resource_migrations
                    WHERE tenant_id = ? AND id = ? AND state = 'verified'
                  )
                  AND EXISTS (
                    SELECT 1 FROM tf_resource_deployments
                    WHERE tenant_id = ? AND resource_uid = ? AND id = ? AND state = 'candidate'
                  )`,
          params: [
            timestamp,
            input.tenantId,
            input.resourceUid,
            input.sourceDeploymentId,
            input.tenantId,
            input.id,
            input.tenantId,
            input.resourceUid,
            input.targetDeploymentId,
          ],
        },
        {
          sql: `UPDATE tf_resource_deployments
                SET state = 'active', updated_at = ?
                WHERE tenant_id = ? AND resource_uid = ? AND id = ? AND state = 'candidate'
                  AND EXISTS (
                    SELECT 1 FROM tf_resource_migrations
                    WHERE tenant_id = ? AND id = ? AND state = 'verified'
                  )
                  AND EXISTS (
                    SELECT 1 FROM tf_resource_deployments
                    WHERE tenant_id = ? AND resource_uid = ? AND id = ? AND state = 'retained'
                  )`,
          params: [
            timestamp,
            input.tenantId,
            input.resourceUid,
            input.targetDeploymentId,
            input.tenantId,
            input.id,
            input.tenantId,
            input.resourceUid,
            input.sourceDeploymentId,
          ],
        },
        {
          sql: `UPDATE tf_resource_migrations SET state = 'completed', updated_at = ?
                WHERE tenant_id = ? AND id = ? AND state = 'verified'
                  AND EXISTS (
                    SELECT 1 FROM tf_resource_deployments
                    WHERE tenant_id = ? AND id = ? AND state = 'retained'
                  )
                  AND EXISTS (
                    SELECT 1 FROM tf_resource_deployments
                    WHERE tenant_id = ? AND id = ? AND state = 'active'
                  )`,
          params: [
            timestamp,
            input.tenantId,
            input.id,
            input.tenantId,
            input.sourceDeploymentId,
            input.tenantId,
            input.targetDeploymentId,
          ],
        },
      ]);
      return results[0]?.changes === 1 && results[1]?.changes === 1 && results[2]?.changes === 1;
    },

    async rollback(input) {
      const timestamp = now();
      const results = await sql.batch([
        {
          sql: `UPDATE tf_resource_deployments
                SET state = 'retained', updated_at = ?
                WHERE tenant_id = ? AND resource_uid = ? AND id = ? AND state = 'active'
                  AND EXISTS (
                    SELECT 1 FROM tf_resource_migrations
                    WHERE tenant_id = ? AND id = ? AND state = 'completed'
                      AND rollback_until >= ?
                  )
                  AND EXISTS (
                    SELECT 1 FROM tf_resource_deployments
                    WHERE tenant_id = ? AND resource_uid = ? AND id = ? AND state = 'retained'
                  )`,
          params: [
            timestamp,
            input.tenantId,
            input.resourceUid,
            input.targetDeploymentId,
            input.tenantId,
            input.id,
            timestamp,
            input.tenantId,
            input.resourceUid,
            input.sourceDeploymentId,
          ],
        },
        {
          sql: `UPDATE tf_resource_deployments
                SET state = 'active', updated_at = ?
                WHERE tenant_id = ? AND resource_uid = ? AND id = ? AND state = 'retained'
                  AND EXISTS (
                    SELECT 1 FROM tf_resource_migrations
                    WHERE tenant_id = ? AND id = ? AND state = 'completed'
                      AND rollback_until >= ?
                  )
                  AND EXISTS (
                    SELECT 1 FROM tf_resource_deployments
                    WHERE tenant_id = ? AND resource_uid = ? AND id = ? AND state = 'retained'
                  )`,
          params: [
            timestamp,
            input.tenantId,
            input.resourceUid,
            input.sourceDeploymentId,
            input.tenantId,
            input.id,
            timestamp,
            input.tenantId,
            input.resourceUid,
            input.targetDeploymentId,
          ],
        },
        {
          sql: `UPDATE tf_resource_migrations SET state = 'rolled_back', updated_at = ?
                WHERE tenant_id = ? AND id = ? AND state = 'completed'
                  AND EXISTS (
                    SELECT 1 FROM tf_resource_deployments
                    WHERE tenant_id = ? AND id = ? AND state = 'active'
                  )
                  AND EXISTS (
                    SELECT 1 FROM tf_resource_deployments
                    WHERE tenant_id = ? AND id = ? AND state = 'retained'
                  )`,
          params: [
            timestamp,
            input.tenantId,
            input.id,
            input.tenantId,
            input.sourceDeploymentId,
            input.tenantId,
            input.targetDeploymentId,
          ],
        },
      ]);
      return results[0]?.changes === 1 && results[1]?.changes === 1 && results[2]?.changes === 1;
    },
  };
}

function exactOffering(catalog: Catalog, migration: ResourceMigration): Offering {
  const offering = catalog.findOffering(migration.targetOfferingId);
  if (
    !offering ||
    offering.providerPackRef !== migration.targetProviderPackRef ||
    offering.providerInstallationRef !== migration.targetProviderInstallationRef
  ) {
    throw new ResourceMigrationError("offering_invalid");
  }
  return offering;
}

function sameForm(left: TakoformV1Alpha3FormRef, right: TakoformV1Alpha3FormRef): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.kind === right.kind &&
    left.definitionVersion === right.definitionVersion &&
    left.schemaDigest === right.schemaDigest
  );
}

function validIdentifier(value: string): void {
  if (value.length < 3 || value.length > 128 || hasControlCharacter(value)) {
    throw new ResourceMigrationError("migration_conflict");
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 0x20 || code === 0x7f);
  });
}

function migration(row: Row): ResourceMigration {
  const verification = row.verification_json;
  const rollbackUntil = row.rollback_until;
  return {
    tenantId: text(row.tenant_id),
    id: text(row.id),
    resourceUid: text(row.resource_uid),
    sourceDeploymentId: text(row.source_deployment_id),
    targetDeploymentId: text(row.target_deployment_id),
    targetOfferingId: text(row.target_offering_id),
    targetProviderPackRef: text(row.target_provider_pack_ref),
    targetProviderInstallationRef: text(row.target_provider_installation_ref),
    commercialAuthorizationRef: text(row.commercial_authorization_ref),
    mode: mode(row.mode),
    transferFormat: text(row.transfer_format),
    state: state(row.state),
    ...(typeof verification === "string"
      ? { verification: JSON.parse(verification) as MigrationVerification }
      : {}),
    ...(typeof rollbackUntil === "number"
      ? { rollbackUntil: new Date(rollbackUntil).toISOString() }
      : {}),
    createdAt: new Date(integer(row.created_at)).toISOString(),
    updatedAt: new Date(integer(row.updated_at)).toISOString(),
  };
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("resource_migration_row_invalid");
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("resource_migration_row_invalid");
  }
  return value;
}

function mode(value: unknown): ResourceMigration["mode"] {
  if (value !== "offline" && value !== "online") {
    throw new Error("resource_migration_row_invalid");
  }
  return value;
}

function state(value: unknown): ResourceMigrationState {
  if (
    value !== "planned" &&
    value !== "provisioning" &&
    value !== "transferring" &&
    value !== "verified" &&
    value !== "completed" &&
    value !== "rolled_back" &&
    value !== "failed"
  ) {
    throw new Error("resource_migration_row_invalid");
  }
  return value;
}
