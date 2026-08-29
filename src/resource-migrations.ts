import type { AttachmentRebinding, AttachmentService } from "./attachments.ts";
import type { Catalog, Offering } from "./catalog.ts";
import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import { canonicalJson } from "./json.ts";
import type { Clock, JsonObject, Row, Sql } from "./ports.ts";
import type {
  ProviderPack,
  TransferEndpoint,
  TransferExportReceipt,
  TransferImportReceipt,
  TransferOperationTicket,
  TransferVerificationReceipt,
} from "./provider-pack.ts";
import type { ProviderResult, ProviderTicket } from "./provider-port.ts";
import type { ResourceDeployment, ResourceDeploymentStore } from "./resource-deployments.ts";
import type { ResourceEffectKind, TakoformStore } from "./takoform/store.ts";

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
  readonly commercialTenantRef?: string;
  readonly mode: "offline" | "online";
  readonly transferFormat: string;
  readonly state: ResourceMigrationState;
  readonly verification?: MigrationVerification;
  readonly attachmentRebindings: readonly AttachmentRebinding[];
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
  readonly commercialTenantRef: string;
  readonly mode: "offline" | "online";
  readonly transferFormat: string;
}

type MigrationProvisionExecution =
  | Extract<ProviderTicket, { readonly phase: "running" }>
  | Extract<ProviderTicket, { readonly phase: "succeeded" }>;

interface MigrationExecutionProgress {
  readonly provision?: MigrationProvisionExecution;
  /** Durable target-deletion sub-operation used by cancellation. */
  readonly cancelTarget?: MigrationCancellationExecution;
  readonly export?: TransferExportReceipt | MigrationTransferExecution<TransferExportReceipt>;
  readonly import?: MigrationTransferExecution<TransferImportReceipt>;
  /** Compatibility receipt written by the pre-sub-operation coordinator. */
  readonly imported?: true;
  readonly verification?:
    | MigrationVerification
    | MigrationTransferExecution<TransferVerificationReceipt>;
}

type MigrationCancellationExecution =
  | {
      readonly phase: "dispatching";
      readonly operationId: string;
      readonly operationMode: "initial";
      readonly nativeId: string;
    }
  | {
      readonly phase: "running";
      readonly operationId: string;
      readonly operationMode: "recovery";
      readonly nativeId: string;
      readonly handle: string;
      readonly pollAfterMs: number;
    }
  | {
      readonly phase: "succeeded";
      readonly operationId: string;
      readonly operationMode: "recovery";
      readonly nativeId: string;
    };

type MigrationTransferExecution<Receipt> =
  | { readonly phase: "dispatching"; readonly operationId: string }
  | {
      readonly phase: "running";
      readonly operationId: string;
      readonly handle: string;
      readonly pollAfterMs: number;
    }
  | { readonly phase: "succeeded"; readonly operationId: string; readonly receipt: Receipt };

type MigrationExecutionAcquisition =
  | {
      readonly kind: "acquired";
      readonly mode: "initial" | "recovery";
      readonly migration: ResourceMigration;
      readonly progress: MigrationExecutionProgress;
    }
  | { readonly kind: "terminal"; readonly migration: ResourceMigration }
  | { readonly kind: "busy" }
  | { readonly kind: "not_found" };

export interface ResourceMigrationStore {
  create(input: ResourceMigration): Promise<void>;
  read(tenantId: string, id: string): Promise<ResourceMigration | null>;
  list(tenantId: string, resourceUid: string, limit: number): Promise<readonly ResourceMigration[]>;
  acquireExecution(input: {
    readonly tenantId: string;
    readonly id: string;
    readonly leaseToken: string;
    readonly leaseUntil: number;
    /** Cancellation may acquire the verified state; normal execute cannot. */
    readonly allowVerified?: boolean;
  }): Promise<MigrationExecutionAcquisition>;
  markExecutionDispatch(input: {
    readonly tenantId: string;
    readonly id: string;
    readonly leaseToken: string;
  }): Promise<boolean>;
  recordExecutionProgress(input: {
    readonly tenantId: string;
    readonly id: string;
    readonly leaseToken: string;
    readonly expected: MigrationExecutionProgress;
    readonly next: MigrationExecutionProgress;
  }): Promise<boolean>;
  releaseExecution(input: {
    readonly tenantId: string;
    readonly id: string;
    readonly leaseToken: string;
  }): Promise<boolean>;
  transferring(input: {
    readonly tenantId: string;
    readonly id: string;
    readonly leaseToken: string;
    readonly expected: MigrationExecutionProgress;
    readonly next: MigrationExecutionProgress;
  }): Promise<boolean>;
  verified(input: {
    readonly tenantId: string;
    readonly id: string;
    readonly leaseToken: string;
    readonly progress: MigrationExecutionProgress;
    readonly verification: MigrationVerification;
    readonly rollbackUntil: number;
  }): Promise<boolean>;
  cutover(
    migration: ResourceMigration,
    rebindings: readonly AttachmentRebinding[],
  ): Promise<boolean>;
  rollback(migration: ResourceMigration): Promise<boolean>;
  abandon(
    migration: ResourceMigration,
    target: ResourceDeployment | null,
    leaseToken: string,
  ): Promise<boolean>;
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
      | "recovery_required"
      | "backend_unavailable",
  ) {
    super(code);
    this.name = "ResourceMigrationError";
  }
}

export interface ResourceMigrationService {
  plan(input: PlanResourceMigration): Promise<ResourceMigration>;
  read(tenantId: string, id: string): Promise<ResourceMigration | null>;
  list(tenantId: string, resourceUid: string, limit: number): Promise<readonly ResourceMigration[]>;
  execute(tenantId: string, id: string): Promise<ResourceMigration>;
  cutover(tenantId: string, id: string): Promise<ResourceMigration>;
  rollback(tenantId: string, id: string): Promise<ResourceMigration>;
  cancel(tenantId: string, id: string): Promise<ResourceMigration>;
}

export function createResourceMigrationService(options: {
  readonly store: ResourceMigrationStore;
  readonly deployments: ResourceDeploymentStore;
  readonly catalog: Catalog;
  readonly packs: readonly ProviderPack[];
  readonly resource: (tenantId: string, uid: string) => Promise<MigrationResourceView | null>;
  readonly attachments: Pick<AttachmentService, "blocksDeletion" | "prepareMigrationRebindings">;
  readonly clock: Clock;
  readonly rollbackWindowMilliseconds?: number;
  readonly pollBudget?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly executionLeaseMilliseconds?: number;
  /** Optional Resource-incarnation/provider-effect ledger owned by Takoserver. */
  readonly effects?: Pick<TakoformStore, "reserveResourceIncarnation" | "recordResourceEffect">;
}): ResourceMigrationService {
  const packs = new Map(options.packs.map((pack) => [pack.id, pack]));
  const rollbackWindow = options.rollbackWindowMilliseconds ?? 24 * 60 * 60 * 1_000;
  const pollBudget = options.pollBudget ?? 10;
  const executionLeaseMilliseconds = options.executionLeaseMilliseconds ?? 30_000;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  if (
    !Number.isSafeInteger(executionLeaseMilliseconds) ||
    executionLeaseMilliseconds < 1 ||
    executionLeaseMilliseconds > 3_600_000
  ) {
    throw new TypeError("executionLeaseMilliseconds must be an integer from 1 to 3600000");
  }

  const pack = (id: string): ProviderPack => {
    const found = packs.get(id);
    if (!found) throw new ResourceMigrationError("offering_invalid");
    return found;
  };

  const recordEffect = async (input: {
    readonly tenantId: string;
    readonly resource: MigrationResourceView;
    readonly resourceUid: string;
    readonly effectId: string;
    readonly kind: ResourceEffectKind;
    readonly phase: "planned" | "dispatched" | "succeeded" | "cancelled";
    readonly operationMode: "initial" | "recovery";
    readonly providerPackRef?: string;
    readonly providerInstallationRef?: string;
    readonly nativeId?: string;
  }): Promise<void> => {
    if (!options.effects) return;
    const address = {
      tenantId: input.tenantId,
      space: input.resource.space,
      apiVersion: input.resource.form.apiVersion,
      kind: input.resource.form.kind,
      name: input.resource.name,
    };
    if (
      !(await options.effects.reserveResourceIncarnation({
        tenantId: input.tenantId,
        resourceUid: input.resourceUid,
        address,
        formRef: input.resource.form,
      }))
    ) {
      throw new ResourceMigrationError("migration_conflict");
    }
    if (
      !(await options.effects.recordResourceEffect({
        tenantId: input.tenantId,
        resourceUid: input.resourceUid,
        effectId: input.effectId,
        kind: input.kind,
        phase: input.phase,
        operationMode: input.operationMode,
        ...(input.providerPackRef ? { providerPackRef: input.providerPackRef } : {}),
        ...(input.providerInstallationRef
          ? { providerInstallationRef: input.providerInstallationRef }
          : {}),
        ...(input.nativeId ? { nativeId: input.nativeId } : {}),
      }))
    ) {
      throw new ResourceMigrationError("migration_conflict");
    }
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

  const settleCancellation = async (input: {
    readonly migration: ResourceMigration;
    readonly target: ResourceDeployment;
    readonly resource: MigrationResourceView;
    readonly providerOffering: ReturnType<
      ProviderPack["provisionerForOffering"]
    >["offerings"][number];
    readonly provisioner: ReturnType<ProviderPack["provisionerForOffering"]>;
    readonly leaseToken: string;
    readonly progress: MigrationExecutionProgress;
  }): Promise<MigrationExecutionProgress> => {
    const operationId = `${input.migration.id}:cancel-target`;
    let progress = input.progress;
    let execution = progress.cancelTarget;
    const persist = async (next: MigrationExecutionProgress): Promise<void> => {
      const normalized = migrationExecutionProgress(canonicalJson(next));
      if (
        !(await options.store.recordExecutionProgress({
          tenantId: input.migration.tenantId,
          id: input.migration.id,
          leaseToken: input.leaseToken,
          expected: progress,
          next: normalized,
        }))
      ) {
        throw new ResourceMigrationError("migration_conflict");
      }
      progress = normalized;
      execution = normalized.cancelTarget;
    };
    const markSucceeded = async (): Promise<void> => {
      await recordEffect({
        tenantId: input.migration.tenantId,
        resource: input.resource,
        resourceUid: input.migration.resourceUid,
        effectId: operationId,
        kind: "cancel-delete",
        phase: "succeeded",
        operationMode: "recovery",
        providerPackRef: input.migration.targetProviderPackRef,
        providerInstallationRef: input.migration.targetProviderInstallationRef,
        nativeId: input.target.nativeId,
      });
      await persist({
        ...progress,
        cancelTarget: {
          phase: "succeeded",
          operationId,
          operationMode: "recovery",
          nativeId: input.target.nativeId,
        },
      });
    };
    const acceptTicket = async (ticket: ProviderTicket): Promise<void> => {
      if (ticket.phase === "failed") {
        if (ticket.failure.code === "not_found") {
          await markSucceeded();
          return;
        }
        throw new ResourceMigrationError("backend_unavailable");
      }
      if (ticket.phase === "succeeded") {
        // A cancellation is terminal only when the provider proved that the
        // exact native identity is absent. Retained/ambiguous success must
        // remain actionable instead of deleting the candidate row blindly.
        if (ticket.result.disposition === "retained" || ticket.result.observed.deleted !== true) {
          throw new ResourceMigrationError("recovery_required");
        }
        await markSucceeded();
        return;
      }
      await persist({
        ...progress,
        cancelTarget: {
          phase: "running",
          operationId,
          operationMode: "recovery",
          nativeId: input.target.nativeId,
          handle: ticket.handle,
          pollAfterMs: ticket.pollAfterMs,
        },
      });
    };

    if (!execution) {
      // The marker is written before dispatch. If the process dies after a
      // provider accepted DELETE, recovery sees a dispatching marker and will
      // fail closed rather than issuing a second DELETE.
      await recordEffect({
        tenantId: input.migration.tenantId,
        resource: input.resource,
        resourceUid: input.migration.resourceUid,
        effectId: operationId,
        kind: "cancel-delete",
        phase: "planned",
        operationMode: "initial",
        providerPackRef: input.migration.targetProviderPackRef,
        providerInstallationRef: input.migration.targetProviderInstallationRef,
        nativeId: input.target.nativeId,
      });
      await persist({
        ...progress,
        cancelTarget: {
          phase: "dispatching",
          operationId,
          operationMode: "initial",
          nativeId: input.target.nativeId,
        },
      });
      await recordEffect({
        tenantId: input.migration.tenantId,
        resource: input.resource,
        resourceUid: input.migration.resourceUid,
        effectId: operationId,
        kind: "cancel-delete",
        phase: "dispatched",
        operationMode: "initial",
        providerPackRef: input.migration.targetProviderPackRef,
        providerInstallationRef: input.migration.targetProviderInstallationRef,
        nativeId: input.target.nativeId,
      });
      let ticket: ProviderTicket;
      try {
        ticket = await input.provisioner.delete({
          operationId,
          operationMode: "initial",
          offering: input.providerOffering,
          nativeId: input.target.nativeId,
          identity: {
            tenantRef: input.migration.tenantId,
            space: input.resource.space,
            name: input.resource.name,
          },
        });
      } catch {
        throw new ResourceMigrationError("backend_unavailable");
      }
      await acceptTicket(ticket);
    }

    if (
      !execution ||
      execution.operationId !== operationId ||
      execution.nativeId !== input.target.nativeId
    ) {
      throw new ResourceMigrationError("migration_conflict");
    }
    if (execution.phase === "dispatching") {
      // The dispatch marker is durable evidence that the initial DELETE may
      // already have crossed the provider boundary. Only an explicit,
      // read-only recovery capability may resolve it; never issue DELETE a
      // second time from recovery.
      if (!input.provisioner.recoverDelete) {
        throw new ResourceMigrationError("recovery_required");
      }
      let ticket: ProviderTicket;
      try {
        ticket = await input.provisioner.recoverDelete({
          operationId,
          operationMode: "recovery",
          offering: input.providerOffering,
          nativeId: input.target.nativeId,
          identity: {
            tenantRef: input.migration.tenantId,
            space: input.resource.space,
            name: input.resource.name,
          },
        });
      } catch {
        throw new ResourceMigrationError("backend_unavailable");
      }
      await acceptTicket(ticket);
    }
    for (
      let pollAttempt = 0;
      execution.phase === "running" && pollAttempt < pollBudget;
      pollAttempt += 1
    ) {
      try {
        await sleep(execution.pollAfterMs);
        const ticket = input.provisioner.poll
          ? await input.provisioner.poll({
              operationId,
              handle: execution.handle,
            })
          : input.provisioner.recoverDelete
            ? await input.provisioner.recoverDelete({
                operationId,
                operationMode: "recovery",
                providerHandle: execution.handle,
                offering: input.providerOffering,
                nativeId: input.target.nativeId,
                identity: {
                  tenantRef: input.migration.tenantId,
                  space: input.resource.space,
                  name: input.resource.name,
                },
              })
            : (() => {
                throw new ResourceMigrationError("recovery_required");
              })();
        await acceptTicket(ticket);
      } catch (error) {
        if (error instanceof ResourceMigrationError) throw error;
        throw new ResourceMigrationError("backend_unavailable");
      }
    }
    if (execution?.phase !== "succeeded") {
      throw new ResourceMigrationError("backend_unavailable");
    }
    return progress;
  };

  const migrationExecution = async (tenantId: string, id: string): Promise<ResourceMigration> => {
    const leaseToken = `migration_${crypto.randomUUID().replaceAll("-", "")}`;
    let acquired: MigrationExecutionAcquisition;
    try {
      acquired = await options.store.acquireExecution({
        tenantId,
        id,
        leaseToken,
        leaseUntil: options.clock().getTime() + executionLeaseMilliseconds,
      });
    } catch {
      throw new ResourceMigrationError("backend_unavailable");
    }
    if (acquired.kind === "terminal") return acquired.migration;
    if (acquired.kind !== "acquired") {
      throw new ResourceMigrationError("migration_conflict");
    }

    const migration = acquired.migration;
    let progress = acquired.progress;
    let leaseHeld = true;
    const recordProgress = async (next: MigrationExecutionProgress): Promise<void> => {
      const normalized = migrationExecutionProgress(canonicalJson(next));
      if (
        !(await options.store.recordExecutionProgress({
          tenantId,
          id,
          leaseToken,
          expected: progress,
          next: normalized,
        }))
      ) {
        throw new ResourceMigrationError("migration_conflict");
      }
      progress = normalized;
    };

    try {
      const [resource, source] = await Promise.all([
        options.resource(tenantId, migration.resourceUid),
        options.deployments.find(tenantId, migration.sourceDeploymentId),
      ]);
      if (!resource || !source || source.state !== "active") {
        throw new ResourceMigrationError("resource_not_found");
      }
      // Prove the retained source tuple before provisioning a target or
      // exporting bytes. A stale catalog/installation/native identity must
      // fail closed with no provider call rather than guessing an authority.
      const sourceBinding = exactSourceDeployment(resource, source, pack, options.catalog);
      const sourceEndpoint = transferEndpoint(
        sourceBinding.pack,
        "export",
        migration.mode,
        migration.transferFormat,
      );
      const targetOffering = exactOffering(options.catalog, migration);
      const targetPack = pack(migration.targetProviderPackRef);
      const provisioner = targetPack.provisionerForOffering(targetOffering.id);
      const providerOffering = provisioner.offerings.find(
        (offering) => offering.id === targetOffering.id,
      );
      if (!providerOffering) throw new ResourceMigrationError("offering_invalid");
      const provisionOperationId = `${migration.id}:provision`;

      const persistProvision = async (
        ticket: ProviderTicket,
      ): Promise<MigrationProvisionExecution> => {
        if (ticket.phase === "failed") {
          throw new ResourceMigrationError("backend_unavailable");
        }
        if (ticket.phase === "succeeded") {
          await recordEffect({
            tenantId,
            resource,
            resourceUid: migration.resourceUid,
            effectId: provisionOperationId,
            kind: "provision",
            phase: "succeeded",
            operationMode: acquired.mode,
            providerPackRef: migration.targetProviderPackRef,
            providerInstallationRef: migration.targetProviderInstallationRef,
            nativeId: ticket.result.nativeId,
          });
        }
        const next = { ...progress, provision: structuredClone(ticket) };
        // Append the terminal effect before advancing execution progress. A
        // crash between these writes leaves a dispatched/open effect that the
        // next executor can reconcile, never a terminal progress with an
        // unaccounted provider side effect.
        await recordProgress(next);
        const persisted = progress.provision;
        if (!persisted) throw new ResourceMigrationError("migration_conflict");
        return persisted;
      };

      let target = await options.deployments.find(tenantId, migration.targetDeploymentId);
      let provision = progress.provision;
      if (target) {
        if (provision?.phase === "running") {
          throw new ResourceMigrationError("migration_conflict");
        }
        const acknowledged = provision?.phase === "succeeded" ? provision.result : undefined;
        if (
          acquired.mode === "initial" ||
          !exactCandidate(target, migration, targetOffering, acknowledged)
        ) {
          throw new ResourceMigrationError("migration_conflict");
        }
        if (provision?.phase !== "succeeded") {
          await recordEffect({
            tenantId,
            resource,
            resourceUid: migration.resourceUid,
            effectId: provisionOperationId,
            kind: "provision",
            phase: "planned",
            operationMode: "recovery",
            providerPackRef: migration.targetProviderPackRef,
            providerInstallationRef: migration.targetProviderInstallationRef,
          });
          await recordEffect({
            tenantId,
            resource,
            resourceUid: migration.resourceUid,
            effectId: provisionOperationId,
            kind: "provision",
            phase: "dispatched",
            operationMode: "recovery",
            providerPackRef: migration.targetProviderPackRef,
            providerInstallationRef: migration.targetProviderInstallationRef,
            nativeId: target.nativeId,
          });
          provision = await persistProvision({
            phase: "succeeded",
            result: {
              nativeId: target.nativeId,
              observed: target.observed,
              outputs: target.outputs,
            },
          });
        }
      } else {
        if (!provision) {
          if (acquired.mode !== "initial") {
            // Once the migration has crossed its dispatch boundary, replaying
            // apply without an opaque provider receipt could duplicate the
            // resource.  Recovery is poll/readback-only; an operator must
            // repair an execution whose receipt was never persisted.
            throw new ResourceMigrationError("recovery_required");
          }
          await recordEffect({
            tenantId,
            resource,
            resourceUid: migration.resourceUid,
            effectId: provisionOperationId,
            kind: "provision",
            phase: "planned",
            operationMode: "initial",
            providerPackRef: migration.targetProviderPackRef,
            providerInstallationRef: migration.targetProviderInstallationRef,
          });
          if (
            !(await options.store.markExecutionDispatch({
              tenantId,
              id,
              leaseToken,
            }))
          ) {
            throw new ResourceMigrationError("migration_conflict");
          }
          await recordEffect({
            tenantId,
            resource,
            resourceUid: migration.resourceUid,
            effectId: provisionOperationId,
            kind: "provision",
            phase: "dispatched",
            operationMode: "initial",
            providerPackRef: migration.targetProviderPackRef,
            providerInstallationRef: migration.targetProviderInstallationRef,
          });
          provision = await persistProvision(
            await provisioner.apply({
              operationId: provisionOperationId,
              operationMode: acquired.mode,
              offering: providerOffering,
              identity: { tenantRef: tenantId, space: resource.space, name: resource.name },
              spec: resource.spec,
            }),
          );
        }
        for (
          let pollAttempt = 0;
          provision.phase === "running" && pollAttempt < pollBudget;
          pollAttempt += 1
        ) {
          if (!provisioner.poll) break;
          await sleep(provision.pollAfterMs);
          provision = await persistProvision(
            await provisioner.poll({
              operationId: provisionOperationId,
              handle: provision.handle,
            }),
          );
        }
        if (provision.phase !== "succeeded") {
          throw new ResourceMigrationError("backend_unavailable");
        }
        const result = provision.result;
        try {
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
        } catch (error) {
          const existing = await options.deployments.find(tenantId, migration.targetDeploymentId);
          if (!existing || !exactCandidate(existing, migration, targetOffering, result))
            throw error;
        }
        target = await options.deployments.find(tenantId, migration.targetDeploymentId);
      }
      if (
        !target ||
        provision?.phase !== "succeeded" ||
        !exactCandidate(target, migration, targetOffering, provision.result)
      ) {
        throw new ResourceMigrationError("migration_conflict");
      }
      const targetEndpoint = transferEndpoint(
        targetPack,
        "import",
        migration.mode,
        migration.transferFormat,
      );
      const exportOperationId = `${migration.id}:export`;
      let exportInitiallyDispatched = false;
      if (migration.state !== "transferring") {
        await recordEffect({
          tenantId,
          resource,
          resourceUid: migration.resourceUid,
          effectId: exportOperationId,
          kind: "transfer-export",
          phase: "planned",
          operationMode: "initial",
          providerPackRef: source.providerPackRef,
          providerInstallationRef: source.providerInstallationRef,
          nativeId: source.nativeId,
        });
        const next = migrationExecutionProgress(
          canonicalJson({
            ...progress,
            export: { phase: "dispatching", operationId: exportOperationId },
          }),
        );
        if (
          !(await options.store.transferring({
            tenantId,
            id,
            leaseToken,
            expected: progress,
            next,
          }))
        ) {
          throw new ResourceMigrationError("migration_conflict");
        }
        progress = next;
        exportInitiallyDispatched = true;
        await recordEffect({
          tenantId,
          resource,
          resourceUid: migration.resourceUid,
          effectId: exportOperationId,
          kind: "transfer-export",
          phase: "dispatched",
          operationMode: "initial",
          providerPackRef: source.providerPackRef,
          providerInstallationRef: source.providerInstallationRef,
          nativeId: source.nativeId,
        });
      } else if (!progress.export) {
        // A pre-0025 executor may already have crossed a transfer boundary
        // without leaving a sub-operation identity. Recovery cannot guess.
        throw new ResourceMigrationError("recovery_required");
      }
      let exportExecution = progress.export;
      if (
        isTransferExecution(exportExecution) &&
        exportExecution.operationId !== exportOperationId
      ) {
        throw new ResourceMigrationError("migration_conflict");
      }
      const persistExportTicket = async (
        ticket: TransferExportReceipt | TransferOperationTicket<TransferExportReceipt>,
      ): Promise<MigrationTransferExecution<TransferExportReceipt>> => {
        if ("phase" in ticket && ticket.phase === "failed") {
          throw new ResourceMigrationError("backend_unavailable");
        }
        const execution: MigrationTransferExecution<TransferExportReceipt> =
          "phase" in ticket && ticket.phase === "running"
            ? {
                phase: "running",
                operationId: exportOperationId,
                handle: ticket.handle,
                pollAfterMs: ticket.pollAfterMs,
              }
            : {
                phase: "succeeded",
                operationId: exportOperationId,
                receipt: "phase" in ticket ? ticket.receipt : ticket,
              };
        if (execution.phase === "succeeded") {
          await recordEffect({
            tenantId,
            resource,
            resourceUid: migration.resourceUid,
            effectId: exportOperationId,
            kind: "transfer-export",
            phase: "succeeded",
            operationMode: "recovery",
            providerPackRef: source.providerPackRef,
            providerInstallationRef: source.providerInstallationRef,
            nativeId: source.nativeId,
          });
        }
        await recordProgress({ ...progress, export: execution });
        const persisted = progress.export;
        if (!isTransferExecution(persisted)) {
          throw new ResourceMigrationError("migration_conflict");
        }
        return persisted;
      };
      if (exportInitiallyDispatched) {
        exportExecution = await persistExportTicket(
          await sourceEndpoint.export({
            operationId: exportOperationId,
            operationMode: "initial",
            tenantId,
            source,
            format: migration.transferFormat,
          }),
        );
      }
      for (
        let pollAttempt = 0;
        isTransferExecution(exportExecution) &&
        exportExecution.phase !== "succeeded" &&
        pollAttempt < pollBudget;
        pollAttempt += 1
      ) {
        if (!sourceEndpoint.recoverExport) {
          throw new ResourceMigrationError("recovery_required");
        }
        if (exportExecution.phase === "running") await sleep(exportExecution.pollAfterMs);
        exportExecution = await persistExportTicket(
          await sourceEndpoint.recoverExport({
            operationId: exportOperationId,
            operationMode: "recovery",
            ...(exportExecution.phase === "running" ? { handle: exportExecution.handle } : {}),
            tenantId,
            source,
            format: migration.transferFormat,
          }),
        );
      }
      const exportReceipt = isTransferExecution(exportExecution)
        ? exportExecution.phase === "succeeded"
          ? exportExecution.receipt
          : undefined
        : exportExecution;
      if (!exportReceipt) throw new ResourceMigrationError("backend_unavailable");
      const importOperationId = `${migration.id}:import`;
      let importExecution = progress.import;
      if (importExecution && importExecution.operationId !== importOperationId) {
        throw new ResourceMigrationError("migration_conflict");
      }
      const persistImportTicket = async (
        ticket: Awaited<ReturnType<TransferEndpoint["import"]>>,
      ): Promise<MigrationTransferExecution<TransferImportReceipt>> => {
        if (ticket !== undefined && ticket.phase === "failed") {
          throw new ResourceMigrationError("backend_unavailable");
        }
        const execution: MigrationTransferExecution<TransferImportReceipt> =
          ticket === undefined
            ? { phase: "succeeded", operationId: importOperationId, receipt: {} }
            : ticket.phase === "running"
              ? {
                  phase: "running",
                  operationId: importOperationId,
                  handle: ticket.handle,
                  pollAfterMs: ticket.pollAfterMs,
                }
              : {
                  phase: "succeeded",
                  operationId: importOperationId,
                  receipt: ticket.receipt,
                };
        if (execution.phase === "succeeded") {
          await recordEffect({
            tenantId,
            resource,
            resourceUid: migration.resourceUid,
            effectId: importOperationId,
            kind: "transfer-import",
            phase: "succeeded",
            operationMode: "recovery",
            providerPackRef: target.providerPackRef,
            providerInstallationRef: target.providerInstallationRef,
            nativeId: target.nativeId,
          });
        }
        await recordProgress({ ...progress, import: execution });
        const persisted = progress.import;
        if (!persisted) throw new ResourceMigrationError("migration_conflict");
        return persisted;
      };
      if (!progress.imported && !importExecution) {
        await recordEffect({
          tenantId,
          resource,
          resourceUid: migration.resourceUid,
          effectId: importOperationId,
          kind: "transfer-import",
          phase: "planned",
          operationMode: "initial",
          providerPackRef: target.providerPackRef,
          providerInstallationRef: target.providerInstallationRef,
          nativeId: target.nativeId,
        });
        await recordProgress({
          ...progress,
          import: { phase: "dispatching", operationId: importOperationId },
        });
        await recordEffect({
          tenantId,
          resource,
          resourceUid: migration.resourceUid,
          effectId: importOperationId,
          kind: "transfer-import",
          phase: "dispatched",
          operationMode: "initial",
          providerPackRef: target.providerPackRef,
          providerInstallationRef: target.providerInstallationRef,
          nativeId: target.nativeId,
        });
        importExecution = await persistImportTicket(
          await targetEndpoint.import({
            operationId: importOperationId,
            operationMode: "initial",
            tenantId,
            target,
            transferRef: exportReceipt.transferRef,
            format: migration.transferFormat,
          }),
        );
      }
      for (
        let pollAttempt = 0;
        !progress.imported && importExecution?.phase !== "succeeded" && pollAttempt < pollBudget;
        pollAttempt += 1
      ) {
        if (!targetEndpoint.recoverImport) {
          throw new ResourceMigrationError("recovery_required");
        }
        if (importExecution?.phase === "running") await sleep(importExecution.pollAfterMs);
        importExecution = await persistImportTicket(
          await targetEndpoint.recoverImport({
            operationId: importOperationId,
            operationMode: "recovery",
            ...(importExecution?.phase === "running" ? { handle: importExecution.handle } : {}),
            tenantId,
            target,
            transferRef: exportReceipt.transferRef,
            format: migration.transferFormat,
          }),
        );
      }
      if (!progress.imported && importExecution?.phase !== "succeeded") {
        throw new ResourceMigrationError("backend_unavailable");
      }
      const verificationOperationId = `${migration.id}:verify`;
      let verificationExecution = progress.verification;
      if (
        isTransferExecution(verificationExecution) &&
        verificationExecution.operationId !== verificationOperationId
      ) {
        throw new ResourceMigrationError("migration_conflict");
      }
      const persistVerificationTicket = async (
        ticket: TransferVerificationReceipt | TransferOperationTicket<TransferVerificationReceipt>,
      ): Promise<MigrationTransferExecution<TransferVerificationReceipt>> => {
        if ("phase" in ticket && ticket.phase === "failed") {
          throw new ResourceMigrationError("backend_unavailable");
        }
        const execution: MigrationTransferExecution<TransferVerificationReceipt> =
          "phase" in ticket && ticket.phase === "running"
            ? {
                phase: "running",
                operationId: verificationOperationId,
                handle: ticket.handle,
                pollAfterMs: ticket.pollAfterMs,
              }
            : {
                phase: "succeeded",
                operationId: verificationOperationId,
                receipt: "phase" in ticket ? ticket.receipt : ticket,
              };
        if (execution.phase === "succeeded") {
          await recordEffect({
            tenantId,
            resource,
            resourceUid: migration.resourceUid,
            effectId: verificationOperationId,
            kind: "verify",
            phase: "succeeded",
            operationMode: "recovery",
            providerPackRef: target.providerPackRef,
            providerInstallationRef: target.providerInstallationRef,
            nativeId: target.nativeId,
          });
        }
        await recordProgress({ ...progress, verification: execution });
        const persisted = progress.verification;
        if (!isTransferExecution(persisted)) {
          throw new ResourceMigrationError("migration_conflict");
        }
        return persisted;
      };
      if (!verificationExecution) {
        await recordEffect({
          tenantId,
          resource,
          resourceUid: migration.resourceUid,
          effectId: verificationOperationId,
          kind: "verify",
          phase: "planned",
          operationMode: "initial",
          providerPackRef: target.providerPackRef,
          providerInstallationRef: target.providerInstallationRef,
          nativeId: target.nativeId,
        });
        await recordProgress({
          ...progress,
          verification: { phase: "dispatching", operationId: verificationOperationId },
        });
        await recordEffect({
          tenantId,
          resource,
          resourceUid: migration.resourceUid,
          effectId: verificationOperationId,
          kind: "verify",
          phase: "dispatched",
          operationMode: "initial",
          providerPackRef: target.providerPackRef,
          providerInstallationRef: target.providerInstallationRef,
          nativeId: target.nativeId,
        });
        verificationExecution = await persistVerificationTicket(
          await targetEndpoint.verify({
            operationId: verificationOperationId,
            operationMode: "initial",
            tenantId,
            source,
            target,
            requirements: { schema: true, rowCounts: true, checksums: true },
          }),
        );
      }
      for (
        let pollAttempt = 0;
        isTransferExecution(verificationExecution) &&
        verificationExecution.phase !== "succeeded" &&
        pollAttempt < pollBudget;
        pollAttempt += 1
      ) {
        if (!targetEndpoint.recoverVerify) {
          throw new ResourceMigrationError("recovery_required");
        }
        if (verificationExecution.phase === "running") {
          await sleep(verificationExecution.pollAfterMs);
        }
        verificationExecution = await persistVerificationTicket(
          await targetEndpoint.recoverVerify({
            operationId: verificationOperationId,
            operationMode: "recovery",
            ...(verificationExecution.phase === "running"
              ? { handle: verificationExecution.handle }
              : {}),
            tenantId,
            source,
            target,
            requirements: { schema: true, rowCounts: true, checksums: true },
          }),
        );
      }
      const verification = isTransferExecution(verificationExecution)
        ? verificationExecution.phase === "succeeded"
          ? verificationExecution.receipt
          : undefined
        : verificationExecution;
      if (!verification) throw new ResourceMigrationError("backend_unavailable");
      if (!verification.schema || !verification.rowCounts || !verification.checksums) {
        throw new ResourceMigrationError("verification_failed");
      }
      const rollbackUntil = options.clock().getTime() + rollbackWindow;
      if (
        !(await options.store.verified({
          tenantId,
          id,
          leaseToken,
          progress,
          verification,
          rollbackUntil,
        }))
      ) {
        throw new ResourceMigrationError("migration_conflict");
      }
      leaseHeld = false;
      const verified = await options.store.read(tenantId, id);
      if (!verified) throw new ResourceMigrationError("migration_conflict");
      return verified;
    } catch (error) {
      if (leaseHeld) {
        try {
          await options.store.releaseExecution({ tenantId, id, leaseToken });
        } catch {
          // The original outcome remains authoritative; an expired lease is recoverable.
        }
      }
      if (error instanceof ResourceMigrationError) throw error;
      throw new ResourceMigrationError("backend_unavailable");
    }
  };

  return {
    async plan(input: PlanResourceMigration): Promise<ResourceMigration> {
      validIdentifier(input.id);
      validIdentifier(input.commercialAuthorizationRef);
      validIdentifier(input.commercialTenantRef);
      const [resource, source, target] = await Promise.all([
        options.resource(input.tenantId, input.resourceUid),
        options.deployments.active(input.tenantId, input.resourceUid),
        Promise.resolve(options.catalog.findOffering(input.targetOfferingId)),
      ]);
      if (!resource || !source) throw new ResourceMigrationError("resource_not_found");
      if (!target || !sameForm(target.form, resource.form) || target.id === source.offeringId) {
        throw new ResourceMigrationError("offering_invalid");
      }
      const sourcePack = exactSourceDeployment(resource, source, pack, options.catalog);
      const targetPack = pack(target.providerPackRef);
      transferEndpoint(sourcePack.pack, "export", input.mode, input.transferFormat);
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
        attachmentRebindings: [],
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

    async read(tenantId, id): Promise<ResourceMigration | null> {
      return await options.store.read(tenantId, id);
    },

    async list(tenantId, resourceUid, limit): Promise<readonly ResourceMigration[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw new ResourceMigrationError("migration_conflict");
      }
      return await options.store.list(tenantId, resourceUid, limit);
    },

    async execute(tenantId: string, id: string): Promise<ResourceMigration> {
      return await migrationExecution(tenantId, id);
    },

    async cutover(tenantId: string, id: string): Promise<ResourceMigration> {
      const migration = await options.store.read(tenantId, id);
      if (migration?.state === "completed") return migration;
      if (!migration) {
        throw new ResourceMigrationError("migration_conflict");
      }
      if (migration.state !== "verified") {
        throw new ResourceMigrationError("migration_conflict");
      }
      const [source, target] = await Promise.all([
        options.deployments.find(tenantId, migration.sourceDeploymentId),
        options.deployments.find(tenantId, migration.targetDeploymentId),
      ]);
      if (source?.state !== "active" || target?.state !== "candidate") {
        throw new ResourceMigrationError("migration_conflict");
      }
      let rebindings: readonly AttachmentRebinding[];
      try {
        rebindings = await options.attachments.prepareMigrationRebindings({
          tenantId,
          resourceUid: migration.resourceUid,
          sourceDeployment: source,
          targetDeployment: target,
          operationId: `migration:${migration.id}:cutover`,
        });
      } catch {
        throw new ResourceMigrationError("attachment_rebind_required");
      }
      const blocking = await options.attachments.blocksDeletion(tenantId, migration.resourceUid);
      if (
        !sameIds(
          blocking,
          rebindings.map((item) => item.id),
        )
      ) {
        throw new ResourceMigrationError("attachment_rebind_required");
      }
      if (!(await options.store.cutover(migration, rebindings))) {
        throw new ResourceMigrationError("migration_conflict");
      }
      const completed = await options.store.read(tenantId, id);
      if (!completed) throw new ResourceMigrationError("migration_conflict");
      return completed;
    },

    async rollback(tenantId: string, id: string): Promise<ResourceMigration> {
      const migration = await options.store.read(tenantId, id);
      if (migration?.state === "rolled_back") return migration;
      if (!migration) {
        throw new ResourceMigrationError("migration_conflict");
      }
      if (migration.state !== "completed") {
        throw new ResourceMigrationError("migration_conflict");
      }
      if (
        !migration.rollbackUntil ||
        Date.parse(migration.rollbackUntil) < options.clock().getTime()
      ) {
        throw new ResourceMigrationError("rollback_expired");
      }
      const blocking = await options.attachments.blocksDeletion(tenantId, migration.resourceUid);
      if (
        !sameIds(
          blocking,
          migration.attachmentRebindings.map((item) => item.id),
        )
      ) {
        throw new ResourceMigrationError("attachment_rebind_required");
      }
      if (!(await options.store.rollback(migration))) {
        throw new ResourceMigrationError("migration_conflict");
      }
      const rolledBack = await options.store.read(tenantId, id);
      if (!rolledBack) throw new ResourceMigrationError("migration_conflict");
      return rolledBack;
    },

    async cancel(tenantId: string, id: string): Promise<ResourceMigration> {
      const before = await options.store.read(tenantId, id);
      if (before?.state === "failed") return before;
      if (!before || before.state === "completed" || before.state === "rolled_back") {
        throw new ResourceMigrationError("migration_conflict");
      }
      const leaseToken = `migration_cancel_${crypto.randomUUID().replaceAll("-", "")}`;
      let acquired: MigrationExecutionAcquisition;
      try {
        acquired = await options.store.acquireExecution({
          tenantId,
          id,
          leaseToken,
          leaseUntil: options.clock().getTime() + executionLeaseMilliseconds,
          allowVerified: true,
        });
      } catch {
        throw new ResourceMigrationError("backend_unavailable");
      }
      if (acquired.kind === "terminal") {
        if (acquired.migration.state === "failed") return acquired.migration;
        throw new ResourceMigrationError("migration_conflict");
      }
      if (acquired.kind !== "acquired") {
        throw new ResourceMigrationError("migration_conflict");
      }
      const migration = acquired.migration;
      let leaseHeld = true;
      try {
        const target = await options.deployments.find(tenantId, migration.targetDeploymentId);
        if (!target) {
          // Once provider execution has begun, an absent Deployment row is an
          // acknowledgement gap. Never release its commercial hold or claim
          // that the candidate was removed without an authoritative receipt.
          if (migration.state !== "planned") {
            throw new ResourceMigrationError("backend_unavailable");
          }
        } else if (target.state === "candidate") {
          const resource = await options.resource(tenantId, migration.resourceUid);
          if (!resource) throw new ResourceMigrationError("resource_not_found");
          const targetOffering = exactOffering(options.catalog, migration);
          const provisioner = pack(migration.targetProviderPackRef).provisionerForOffering(
            targetOffering.id,
          );
          const providerOffering = provisioner.offerings.find(
            (offering) => offering.id === targetOffering.id,
          );
          if (!providerOffering) throw new ResourceMigrationError("offering_invalid");
          await settleCancellation({
            migration,
            target,
            resource,
            providerOffering,
            provisioner,
            leaseToken,
            progress: acquired.progress,
          });
        } else if (target.state !== "deleted") {
          throw new ResourceMigrationError("migration_conflict");
        }
        if (!(await options.store.abandon(migration, target ?? null, leaseToken))) {
          throw new ResourceMigrationError("migration_conflict");
        }
        leaseHeld = false;
        const cancelled = await options.store.read(tenantId, id);
        if (!cancelled) throw new ResourceMigrationError("migration_conflict");
        return cancelled;
      } finally {
        if (leaseHeld) {
          try {
            await options.store.releaseExecution({ tenantId, id, leaseToken });
          } catch {
            // A lost lease leaves the durable marker for a later repair.
          }
        }
      }
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
            commercial_authorization_ref, commercial_tenant_ref, mode, transfer_format, state,
            verification_json, rollback_until, execution_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '{}', ?, ?)`,
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
          input.commercialTenantRef ?? null,
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

    async list(tenantId, resourceUid, limit) {
      const rows = await sql.query(
        `SELECT * FROM tf_resource_migrations
         WHERE tenant_id = ? AND resource_uid = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
        [tenantId, resourceUid, limit],
      );
      return rows.map(migration);
    },

    async acquireExecution(input) {
      const timestamp = now();
      if (input.leaseUntil <= timestamp) {
        throw new TypeError("migration execution lease must be in the future");
      }
      validExecutionReference(input.leaseToken, 3, 128);
      const initial = await sql.run(
        `UPDATE tf_resource_migrations
         SET execution_lease_token = ?, execution_lease_until = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND state = 'planned'
           AND execution_started_at IS NULL
           AND (execution_lease_token IS NULL OR execution_lease_until <= ?)`,
        [input.leaseToken, input.leaseUntil, timestamp, input.tenantId, input.id, timestamp],
      );
      let mode: "initial" | "recovery" | undefined = initial.changes === 1 ? "initial" : undefined;
      if (!mode) {
        const recoveryStates = input.allowVerified
          ? "'provisioning', 'transferring', 'verified'"
          : "'provisioning', 'transferring'";
        const recovery = await sql.run(
          `UPDATE tf_resource_migrations
           SET execution_lease_token = ?, execution_lease_until = ?, updated_at = ?
           WHERE tenant_id = ? AND id = ? AND state IN (${recoveryStates})
             AND execution_started_at IS NOT NULL
             AND (execution_lease_token IS NULL OR execution_lease_until <= ?)`,
          [input.leaseToken, input.leaseUntil, timestamp, input.tenantId, input.id, timestamp],
        );
        if (recovery.changes === 1) mode = "recovery";
      }
      if (mode) {
        const rows = await sql.query(
          `SELECT * FROM tf_resource_migrations
           WHERE tenant_id = ? AND id = ? AND execution_lease_token = ? LIMIT 2`,
          [input.tenantId, input.id, input.leaseToken],
        );
        if (rows.length !== 1 || !rows[0]) throw new Error("resource_migration_lease_lost");
        return {
          kind: "acquired",
          mode,
          migration: migration(rows[0]),
          progress: migrationExecutionProgress(rows[0].execution_json),
        };
      }
      const rows = await sql.query(
        "SELECT * FROM tf_resource_migrations WHERE tenant_id = ? AND id = ? LIMIT 2",
        [input.tenantId, input.id],
      );
      if (rows.length > 1) throw new Error("resource_migration_ambiguous");
      if (!rows[0]) return { kind: "not_found" };
      const current = migration(rows[0]);
      return current.state === "verified" ||
        current.state === "completed" ||
        current.state === "rolled_back"
        ? { kind: "terminal", migration: current }
        : { kind: "busy" };
    },

    async markExecutionDispatch(input) {
      const timestamp = now();
      const result = await sql.run(
        `UPDATE tf_resource_migrations
         SET state = 'provisioning', execution_started_at = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND state = 'planned'
           AND execution_started_at IS NULL
           AND execution_lease_token = ? AND execution_lease_until > ?`,
        [timestamp, timestamp, input.tenantId, input.id, input.leaseToken, timestamp],
      );
      return result.changes === 1;
    },

    async recordExecutionProgress(input) {
      const timestamp = now();
      const result = await sql.run(
        `UPDATE tf_resource_migrations
         SET execution_json = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?
           AND state IN ('provisioning', 'transferring', 'verified')
           AND execution_started_at IS NOT NULL
           AND execution_lease_token = ? AND execution_lease_until > ?
           AND execution_json = ?`,
        [
          canonicalJson(input.next),
          timestamp,
          input.tenantId,
          input.id,
          input.leaseToken,
          timestamp,
          canonicalJson(input.expected),
        ],
      );
      return result.changes === 1;
    },

    async releaseExecution(input) {
      const result = await sql.run(
        `UPDATE tf_resource_migrations
         SET execution_lease_token = NULL, execution_lease_until = NULL, updated_at = ?
         WHERE tenant_id = ? AND id = ?
           AND state IN ('planned', 'provisioning', 'transferring', 'verified')
           AND execution_lease_token = ?`,
        [now(), input.tenantId, input.id, input.leaseToken],
      );
      return result.changes === 1;
    },

    async transferring(input) {
      const timestamp = now();
      const result = await sql.run(
        `UPDATE tf_resource_migrations
         SET state = 'transferring', execution_json = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND state = 'provisioning'
           AND execution_started_at IS NOT NULL
           AND execution_lease_token = ? AND execution_lease_until > ?
           AND execution_json = ?`,
        [
          canonicalJson(input.next),
          timestamp,
          input.tenantId,
          input.id,
          input.leaseToken,
          timestamp,
          canonicalJson(input.expected),
        ],
      );
      return result.changes === 1;
    },

    async verified(input) {
      const timestamp = now();
      const result = await sql.run(
        `UPDATE tf_resource_migrations
         SET state = 'verified', verification_json = ?, rollback_until = ?, updated_at = ?,
             execution_lease_token = NULL, execution_lease_until = NULL
         WHERE tenant_id = ? AND id = ? AND state = 'transferring'
           AND execution_started_at IS NOT NULL
           AND execution_lease_token = ? AND execution_lease_until > ?
           AND execution_json = ?`,
        [
          JSON.stringify(input.verification),
          input.rollbackUntil,
          timestamp,
          input.tenantId,
          input.id,
          input.leaseToken,
          timestamp,
          canonicalJson(input.progress),
        ],
      );
      return result.changes === 1;
    },

    async cutover(input, rebindings) {
      const timestamp = now();
      const oldAttachmentGuards = rebindings.flatMap((item) => [
        {
          sql: ` AND EXISTS (
                   SELECT 1 FROM tf_resource_attachments
                   WHERE tenant_id = ? AND id = ? AND state = 'active'
                     AND provider_deployment_id = ? AND consumer_deployment_id = ?
                     AND resolution_json = ?
                 )`,
          params: [
            input.tenantId,
            item.id,
            item.oldProviderDeploymentId,
            item.oldConsumerDeploymentId,
            JSON.stringify(item.oldResolution),
          ],
        },
      ]);
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
                  )${oldAttachmentGuards.map((guard) => guard.sql).join("")}`,
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
            ...oldAttachmentGuards.flatMap((guard) => guard.params),
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
        ...rebindings.map((item) => ({
          sql: `UPDATE tf_resource_attachments
                SET provider_deployment_id = ?, consumer_deployment_id = ?,
                    resolution_json = ?, updated_at = ?
                WHERE tenant_id = ? AND id = ? AND state = 'active'
                  AND provider_deployment_id = ? AND consumer_deployment_id = ?
                  AND resolution_json = ?`,
          params: [
            item.newProviderDeploymentId,
            item.newConsumerDeploymentId,
            JSON.stringify(item.newResolution),
            timestamp,
            input.tenantId,
            item.id,
            item.oldProviderDeploymentId,
            item.oldConsumerDeploymentId,
            JSON.stringify(item.oldResolution),
          ],
        })),
        {
          sql: `UPDATE tf_resource_migrations
                SET state = 'completed', attachment_rebindings_json = ?, updated_at = ?
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
            JSON.stringify(rebindings),
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
      return results.every((result) => result.changes === 1);
    },

    async rollback(input) {
      const timestamp = now();
      const newAttachmentGuards = input.attachmentRebindings.map((item) => ({
        sql: ` AND EXISTS (
                 SELECT 1 FROM tf_resource_attachments
                 WHERE tenant_id = ? AND id = ? AND state = 'active'
                   AND provider_deployment_id = ? AND consumer_deployment_id = ?
                   AND resolution_json = ?
               )`,
        params: [
          input.tenantId,
          item.id,
          item.newProviderDeploymentId,
          item.newConsumerDeploymentId,
          JSON.stringify(item.newResolution),
        ],
      }));
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
                  )${newAttachmentGuards.map((guard) => guard.sql).join("")}`,
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
            ...newAttachmentGuards.flatMap((guard) => guard.params),
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
        ...input.attachmentRebindings.map((item) => ({
          sql: `UPDATE tf_resource_attachments
                SET provider_deployment_id = ?, consumer_deployment_id = ?,
                    resolution_json = ?, updated_at = ?
                WHERE tenant_id = ? AND id = ? AND state = 'active'
                  AND provider_deployment_id = ? AND consumer_deployment_id = ?
                  AND resolution_json = ?`,
          params: [
            item.oldProviderDeploymentId,
            item.oldConsumerDeploymentId,
            JSON.stringify(item.oldResolution),
            timestamp,
            input.tenantId,
            item.id,
            item.newProviderDeploymentId,
            item.newConsumerDeploymentId,
            JSON.stringify(item.newResolution),
          ],
        })),
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
      return results.every((result) => result.changes === 1);
    },

    async abandon(input, target, leaseToken) {
      const timestamp = now();
      validExecutionReference(leaseToken, 3, 128);
      const openStates = "'planned', 'provisioning', 'transferring', 'verified'";
      if (!target) {
        const result = await sql.run(
          `UPDATE tf_resource_migrations
           SET state = 'failed', execution_lease_token = NULL, execution_lease_until = NULL,
               updated_at = ?
           WHERE tenant_id = ? AND id = ? AND state = 'planned'
             AND execution_lease_token = ? AND execution_lease_until > ?
             AND NOT EXISTS (
               SELECT 1 FROM tf_resource_deployments
               WHERE tenant_id = ? AND id = ?
             )`,
          [
            timestamp,
            input.tenantId,
            input.id,
            leaseToken,
            timestamp,
            input.tenantId,
            input.targetDeploymentId,
          ],
        );
        return result.changes === 1;
      }
      if (target.state === "deleted") {
        const result = await sql.run(
          `UPDATE tf_resource_migrations
           SET state = 'failed', execution_lease_token = NULL, execution_lease_until = NULL,
               updated_at = ?
           WHERE tenant_id = ? AND id = ? AND state IN (${openStates})
             AND execution_lease_token = ? AND execution_lease_until > ?
             AND EXISTS (
               SELECT 1 FROM tf_resource_deployments
               WHERE tenant_id = ? AND id = ? AND native_id = ? AND state = 'deleted'
             )`,
          [
            timestamp,
            input.tenantId,
            input.id,
            leaseToken,
            timestamp,
            input.tenantId,
            input.targetDeploymentId,
            target.nativeId,
          ],
        );
        return result.changes === 1;
      }
      if (target.state !== "candidate") return false;
      const results = await sql.batch([
        {
          sql: `UPDATE tf_resource_deployments SET state = 'deleted', updated_at = ?
                WHERE tenant_id = ? AND id = ? AND native_id = ? AND state = 'candidate'
                  AND EXISTS (
                    SELECT 1 FROM tf_resource_migrations
                    WHERE tenant_id = ? AND id = ? AND state IN (${openStates})
                      AND execution_lease_token = ? AND execution_lease_until > ?
                  )`,
          params: [
            timestamp,
            input.tenantId,
            input.targetDeploymentId,
            target.nativeId,
            input.tenantId,
            input.id,
            leaseToken,
            timestamp,
          ],
        },
        {
          sql: `UPDATE tf_resource_migrations
                SET state = 'failed', execution_lease_token = NULL, execution_lease_until = NULL,
                    updated_at = ?
                WHERE tenant_id = ? AND id = ? AND state IN (${openStates})
                  AND execution_lease_token = ? AND execution_lease_until > ?
                  AND EXISTS (
                    SELECT 1 FROM tf_resource_deployments
                    WHERE tenant_id = ? AND id = ? AND native_id = ? AND state = 'deleted'
                  )`,
          params: [
            timestamp,
            input.tenantId,
            input.id,
            leaseToken,
            timestamp,
            input.tenantId,
            input.targetDeploymentId,
            target.nativeId,
          ],
        },
      ]);
      return results.length === 2 && results.every((result) => result.changes === 1);
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

/**
 * Resolves the complete authority tuple for a retained source Deployment.
 *
 * A migration may only export from the exact offering/installation that was
 * persisted on the Deployment. This check is deliberately pure: it touches
 * the catalog and installed pack only, so catalog drift is rejected before any
 * provider transfer or target provisioning call can occur.
 */
function exactSourceDeployment(
  resource: MigrationResourceView,
  source: ResourceDeployment,
  packFor: (id: string) => ProviderPack,
  catalog: Catalog,
): { readonly offering: Offering; readonly pack: ProviderPack } {
  const offering = catalog.findOffering(source.offeringId);
  if (
    !offering ||
    offering.providerPackRef !== source.providerPackRef ||
    offering.providerInstallationRef !== source.providerInstallationRef ||
    !sameForm(offering.form, resource.form) ||
    source.nativeId.length < 1 ||
    source.nativeId.length > 4_096 ||
    hasControlCharacter(source.nativeId)
  ) {
    throw new ResourceMigrationError("offering_invalid");
  }
  let providerPack: ProviderPack;
  try {
    providerPack = packFor(source.providerPackRef);
    const provisioner = providerPack.provisionerForOffering(source.offeringId);
    const providerOffering = provisioner.offerings.find(
      (candidate) => candidate.id === source.offeringId,
    );
    if (
      !providerOffering ||
      providerOffering.kind !== offering.kind ||
      !sameForm(providerOffering.form, offering.form)
    ) {
      throw new ResourceMigrationError("offering_invalid");
    }
  } catch (error) {
    if (error instanceof ResourceMigrationError) throw error;
    throw new ResourceMigrationError("offering_invalid");
  }
  return { offering, pack: providerPack };
}

function exactCandidate(
  target: ResourceDeployment,
  migration: ResourceMigration,
  offering: Offering,
  result?: ProviderResult,
): boolean {
  return (
    target.tenantId === migration.tenantId &&
    target.id === migration.targetDeploymentId &&
    target.resourceUid === migration.resourceUid &&
    target.offeringId === offering.id &&
    target.providerPackRef === offering.providerPackRef &&
    target.providerInstallationRef === offering.providerInstallationRef &&
    target.state === "candidate" &&
    (result === undefined ||
      (target.nativeId === result.nativeId &&
        canonicalJson(target.observed) === canonicalJson(result.observed) &&
        canonicalJson(target.outputs) === canonicalJson(result.outputs)))
  );
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

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 0x20 || code === 0x7f);
  });
}

function migration(row: Row): ResourceMigration {
  migrationExecutionProgress(row.execution_json);
  const verification = row.verification_json;
  const rollbackUntil = row.rollback_until;
  const attachmentRebindings = row.attachment_rebindings_json;
  const commercialTenantRef = row.commercial_tenant_ref;
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
    ...(typeof commercialTenantRef === "string" ? { commercialTenantRef } : {}),
    mode: mode(row.mode),
    transferFormat: text(row.transfer_format),
    state: state(row.state),
    attachmentRebindings:
      typeof attachmentRebindings === "string"
        ? persistedAttachmentRebindings(attachmentRebindings)
        : [],
    ...(typeof verification === "string"
      ? { verification: persistedVerification(verification) }
      : {}),
    ...(typeof rollbackUntil === "number"
      ? { rollbackUntil: new Date(rollbackUntil).toISOString() }
      : {}),
    createdAt: new Date(integer(row.created_at)).toISOString(),
    updatedAt: new Date(integer(row.updated_at)).toISOString(),
  };
}

function persistedVerification(value: string): MigrationVerification {
  return persistedVerificationObject(parsedObject(value));
}

function persistedVerificationObject(parsed: Record<string, unknown>): MigrationVerification {
  exactPersistedKeys(parsed, ["schema", "rowCounts", "checksums", "evidenceDigest"]);
  if (
    typeof parsed.schema !== "boolean" ||
    typeof parsed.rowCounts !== "boolean" ||
    typeof parsed.checksums !== "boolean" ||
    typeof parsed.evidenceDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(parsed.evidenceDigest)
  ) {
    invalidPersistedMigration();
  }
  return {
    schema: parsed.schema as boolean,
    rowCounts: parsed.rowCounts as boolean,
    checksums: parsed.checksums as boolean,
    evidenceDigest: parsed.evidenceDigest as `sha256:${string}`,
  };
}

function migrationExecutionProgress(value: unknown): MigrationExecutionProgress {
  if (typeof value !== "string") invalidPersistedMigration();
  const parsed = parsedObject(value);
  permittedPersistedKeys(parsed, [
    "provision",
    "cancelTarget",
    "export",
    "import",
    "imported",
    "verification",
  ]);
  const provision = parsed.provision;
  const cancellation = parsed.cancelTarget;
  const exported = parsed.export;
  const importOperation = parsed.import;
  const imported = parsed.imported;
  const verification = parsed.verification;
  let provisionReceipt: MigrationProvisionExecution | undefined;
  if (provision !== undefined) {
    const ticket = persistedObject(provision);
    if (ticket.phase === "running") {
      exactPersistedKeys(ticket, ["phase", "handle", "pollAfterMs"]);
      provisionReceipt = {
        phase: "running",
        handle: persistedReference(ticket.handle, 1, 4_096),
        pollAfterMs: persistedInteger(ticket.pollAfterMs, 0, 86_400_000),
      };
    } else if (ticket.phase === "succeeded") {
      exactPersistedKeys(ticket, ["phase", "result"]);
      const result = persistedObject(ticket.result);
      permittedPersistedKeys(result, ["nativeId", "observed", "outputs", "disposition"]);
      if (
        result.disposition !== undefined &&
        result.disposition !== "deleted" &&
        result.disposition !== "retained"
      ) {
        invalidPersistedMigration();
      }
      provisionReceipt = {
        phase: "succeeded",
        result: {
          nativeId: persistedReference(result.nativeId, 1, 4_096),
          observed: persistedJsonObject(result.observed),
          outputs: persistedJsonObject(result.outputs),
          ...(result.disposition === "deleted" || result.disposition === "retained"
            ? { disposition: result.disposition }
            : {}),
        },
      };
    } else {
      invalidPersistedMigration();
    }
  }
  const cancelTargetReceipt =
    cancellation === undefined ? undefined : persistedCancellationExecution(cancellation);
  let exportReceipt: MigrationExecutionProgress["export"];
  if (exported !== undefined) {
    const receipt = persistedObject(exported);
    if ("phase" in receipt) {
      exportReceipt = persistedTransferExecution(receipt, (value) => {
        exactPersistedKeys(value, ["transferRef"]);
        return { transferRef: persistedReference(value.transferRef, 1, 8_192) };
      });
    } else {
      exactPersistedKeys(receipt, ["transferRef"]);
      exportReceipt = { transferRef: persistedReference(receipt.transferRef, 1, 8_192) };
    }
  }
  if (
    (imported !== undefined && imported !== true) ||
    (imported === true && importOperation !== undefined)
  ) {
    invalidPersistedMigration();
  }
  const importReceipt =
    importOperation === undefined
      ? undefined
      : persistedTransferExecution(importOperation, (value) => {
          permittedPersistedKeys(value, ["receiptRef"]);
          return {
            ...(value.receiptRef === undefined
              ? {}
              : { receiptRef: persistedReference(value.receiptRef, 1, 8_192) }),
          };
        });
  const verificationReceipt =
    verification === undefined
      ? undefined
      : typeof verification === "object" && verification !== null && "phase" in verification
        ? persistedTransferExecution(verification, persistedVerificationObject)
        : persistedVerificationObject(persistedObject(verification));
  return {
    ...(provisionReceipt ? { provision: provisionReceipt } : {}),
    ...(cancelTargetReceipt ? { cancelTarget: cancelTargetReceipt } : {}),
    ...(exportReceipt ? { export: exportReceipt } : {}),
    ...(importReceipt ? { import: importReceipt } : {}),
    ...(imported === true ? { imported: true } : {}),
    ...(verificationReceipt ? { verification: verificationReceipt } : {}),
  };
}

function isTransferExecution<Receipt>(
  value: Receipt | MigrationTransferExecution<Receipt> | undefined,
): value is MigrationTransferExecution<Receipt> {
  return typeof value === "object" && value !== null && "phase" in value;
}

function persistedCancellationExecution(value: unknown): MigrationCancellationExecution {
  const execution = persistedObject(value);
  if (execution.phase === "dispatching") {
    exactPersistedKeys(execution, ["phase", "operationId", "operationMode", "nativeId"]);
    if (execution.operationMode !== "initial") invalidPersistedMigration();
    return {
      phase: "dispatching",
      operationId: persistedReference(execution.operationId, 1, 512),
      operationMode: "initial",
      nativeId: persistedReference(execution.nativeId, 1, 4_096),
    };
  }
  if (execution.phase === "running") {
    exactPersistedKeys(execution, [
      "phase",
      "operationId",
      "operationMode",
      "nativeId",
      "handle",
      "pollAfterMs",
    ]);
    if (execution.operationMode !== "recovery") invalidPersistedMigration();
    return {
      phase: "running",
      operationId: persistedReference(execution.operationId, 1, 512),
      operationMode: "recovery",
      nativeId: persistedReference(execution.nativeId, 1, 4_096),
      handle: persistedReference(execution.handle, 1, 8_192),
      pollAfterMs: persistedInteger(execution.pollAfterMs, 0, 86_400_000),
    };
  }
  if (execution.phase === "succeeded") {
    exactPersistedKeys(execution, ["phase", "operationId", "operationMode", "nativeId"]);
    if (execution.operationMode !== "recovery") invalidPersistedMigration();
    return {
      phase: "succeeded",
      operationId: persistedReference(execution.operationId, 1, 512),
      operationMode: "recovery",
      nativeId: persistedReference(execution.nativeId, 1, 4_096),
    };
  }
  return invalidPersistedMigration();
}

function persistedTransferExecution<Receipt>(
  value: unknown,
  receipt: (value: Record<string, unknown>) => Receipt,
): MigrationTransferExecution<Receipt> {
  const execution = persistedObject(value);
  if (execution.phase === "dispatching") {
    exactPersistedKeys(execution, ["phase", "operationId"]);
    return {
      phase: "dispatching",
      operationId: persistedReference(execution.operationId, 1, 512),
    };
  }
  if (execution.phase === "running") {
    exactPersistedKeys(execution, ["phase", "operationId", "handle", "pollAfterMs"]);
    return {
      phase: "running",
      operationId: persistedReference(execution.operationId, 1, 512),
      handle: persistedReference(execution.handle, 1, 8_192),
      pollAfterMs: persistedInteger(execution.pollAfterMs, 0, 86_400_000),
    };
  }
  if (execution.phase === "succeeded") {
    exactPersistedKeys(execution, ["phase", "operationId", "receipt"]);
    return {
      phase: "succeeded",
      operationId: persistedReference(execution.operationId, 1, 512),
      receipt: receipt(persistedObject(execution.receipt)),
    };
  }
  return invalidPersistedMigration();
}

function persistedAttachmentRebindings(value: string): readonly AttachmentRebinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalidPersistedMigration();
  }
  if (!Array.isArray(parsed) || parsed.length > 100) invalidPersistedMigration();
  const seen = new Set<string>();
  return parsed.map((candidate) => {
    const item = persistedObject(candidate);
    exactPersistedKeys(item, [
      "id",
      "oldProviderDeploymentId",
      "oldConsumerDeploymentId",
      "oldResolution",
      "newProviderDeploymentId",
      "newConsumerDeploymentId",
      "newResolution",
    ]);
    const id = persistedReference(item.id, 3, 128);
    if (seen.has(id)) invalidPersistedMigration();
    seen.add(id);
    return {
      id,
      oldProviderDeploymentId: persistedReference(item.oldProviderDeploymentId, 3, 128),
      oldConsumerDeploymentId: persistedReference(item.oldConsumerDeploymentId, 3, 128),
      oldResolution: persistedResolution(item.oldResolution),
      newProviderDeploymentId: persistedReference(item.newProviderDeploymentId, 3, 128),
      newConsumerDeploymentId: persistedReference(item.newConsumerDeploymentId, 3, 128),
      newResolution: persistedResolution(item.newResolution),
    };
  });
}

function persistedResolution(value: unknown): AttachmentRebinding["oldResolution"] {
  const parsed = persistedObject(value);
  exactPersistedKeys(parsed, ["kind", "ref"]);
  if (
    parsed.kind !== "credential-grant-ref" &&
    parsed.kind !== "secret-ref" &&
    parsed.kind !== "endpoint-ref" &&
    parsed.kind !== "native-binding-ref"
  ) {
    invalidPersistedMigration();
  }
  return {
    kind: parsed.kind as AttachmentRebinding["oldResolution"]["kind"],
    ref: persistedReference(parsed.ref, 1, 512),
  };
}

function parsedObject(value: string): Record<string, unknown> {
  try {
    return persistedObject(JSON.parse(value));
  } catch (error) {
    if (error instanceof Error && error.message === "resource_migration_row_invalid") throw error;
    return invalidPersistedMigration();
  }
}

function persistedObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidPersistedMigration();
  }
  return value as Record<string, unknown>;
}

function exactPersistedKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalidPersistedMigration();
  }
}

function permittedPersistedKeys(
  value: Record<string, unknown>,
  permitted: readonly string[],
): void {
  const allowed = new Set(permitted);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalidPersistedMigration();
}

function persistedInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalidPersistedMigration();
  }
  return value;
}

function persistedJsonObject(value: unknown): JsonObject {
  return persistedObject(value) as JsonObject;
}

function persistedReference(value: unknown, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    hasControlCharacter(value)
  ) {
    return invalidPersistedMigration();
  }
  return value;
}

function validExecutionReference(value: string, minimum: number, maximum: number): void {
  if (value.length < minimum || value.length > maximum || hasControlCharacter(value)) {
    throw new Error("resource_migration_execution_invalid");
  }
}

function invalidPersistedMigration(): never {
  throw new Error("resource_migration_row_invalid");
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
