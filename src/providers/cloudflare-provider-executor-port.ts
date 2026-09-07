/** Credential-free service-binding contract; no executor authority implementation. */
import type { ProviderMeterDeployment, ProviderMeterUsage } from "../provider-meter-port.ts";
import type {
  ApplyInput,
  Provider,
  ProviderArtifactConsumption,
  ProviderArtifactConsumptionInput,
  ProviderNativeAbsence,
  ProviderOffering,
  ProviderSqliteMigrationIdentity,
  ProviderTicket,
  ProviderValue,
} from "../provider-port.ts";
import type { ProviderMeterError } from "./provider-meter.ts";

export type CloudflareProviderObserveInput = Parameters<Provider["observe"]>[0];
export type CloudflareProviderDeleteInput = Parameters<Provider["delete"]>[0];
export type CloudflareProviderRecoverDeleteInput = Parameters<
  NonNullable<Provider["recoverDelete"]>
>[0];
export type CloudflareProviderAdoptInput = Parameters<NonNullable<Provider["adopt"]>>[0];
export type CloudflareProviderRecoverAdoptInput = Parameters<
  NonNullable<Provider["recoverAdopt"]>
>[0];
export type CloudflareProviderPollInput = Parameters<NonNullable<Provider["poll"]>>[0];
export type CloudflareProviderVerifyNativeAbsenceInput = Parameters<
  NonNullable<Provider["verifyNativeAbsence"]>
>[0];
export type CloudflareProviderVerifyArtifactConsumptionInput = ProviderArtifactConsumptionInput;
export type CloudflareProviderSqliteMigrationReadInput = Parameters<
  NonNullable<Provider["sqliteMigrations"]>["readLedger"]
>[0];
type ProviderSqliteMigrationApplyInput = Parameters<
  NonNullable<Provider["sqliteMigrations"]>["applySuffix"]
>[0];
/** Artifact identities cross RPC; the executor resolves and verifies bytes in its own isolate. */
export type CloudflareProviderSqliteMigrationApplyInput = Omit<
  ProviderSqliteMigrationApplyInput,
  "desired" | "migrations"
> & {
  readonly desired: readonly ProviderSqliteMigrationIdentity[];
  readonly migrations: readonly ProviderSqliteMigrationIdentity[];
};

export interface CloudflareProviderMeterReadInput {
  readonly meterSourceId: string;
  readonly meters: readonly string[];
  readonly offering: ProviderOffering;
  readonly tenantId: string;
  readonly deployment: ProviderMeterDeployment;
  readonly from: string;
  readonly until: string;
}

export type CloudflareProviderMeterReadResult =
  | { readonly ok: true; readonly value: readonly ProviderMeterUsage[] }
  | { readonly ok: false; readonly error: { readonly code: ProviderMeterError["code"] } };

/**
 * The complete service-binding RPC surface. There is deliberately no `fetch`
 * bridge and no general provider escape hatch.
 */
export interface CloudflareProviderExecutorRpc {
  apply(input: ApplyInput): Promise<ProviderTicket>;
  recoverApply(input: ApplyInput): Promise<ProviderTicket>;
  convergeApply(input: ApplyInput): Promise<ProviderTicket>;
  poll(input: CloudflareProviderPollInput): Promise<ProviderTicket>;
  observe(input: CloudflareProviderObserveInput): Promise<ProviderTicket>;
  delete(input: CloudflareProviderDeleteInput): Promise<ProviderTicket>;
  recoverDelete(input: CloudflareProviderRecoverDeleteInput): Promise<ProviderTicket>;
  adopt(input: CloudflareProviderAdoptInput): Promise<ProviderTicket>;
  recoverAdopt(input: CloudflareProviderRecoverAdoptInput): Promise<ProviderTicket>;
  verifyNativeAbsence(
    input: CloudflareProviderVerifyNativeAbsenceInput,
  ): Promise<ProviderNativeAbsence>;
  verifyArtifactConsumption(
    input: CloudflareProviderVerifyArtifactConsumptionInput,
  ): Promise<ProviderArtifactConsumption>;
  readSqliteMigrationLedger(
    input: CloudflareProviderSqliteMigrationReadInput,
  ): Promise<ProviderValue<readonly ProviderSqliteMigrationIdentity[]>>;
  applySqliteMigrationSuffix(
    input: CloudflareProviderSqliteMigrationApplyInput,
  ): Promise<ProviderValue<undefined>>;
  readMeterUsage(
    input: CloudflareProviderMeterReadInput,
  ): Promise<CloudflareProviderMeterReadResult>;
}
