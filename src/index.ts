/**
 * The public surface for embedders and tests.
 *
 * This is a curated list, not a barrel over every file: internal residue and
 * duplicate vocabulary are deliberately not re-exported, so what a consumer can
 * reach is a decision rather than an accident.
 */

export {
  type AiGateway,
  AiGatewayError,
  type AiModel,
  type AiUsage,
} from "./ai-port.ts";
export { type App, type AppPorts, buildApp, type TickReport } from "./app.ts";
export {
  AttachmentError,
  type AttachmentFactory,
  type AttachmentResolution,
  type AttachmentResourceView,
  type AttachmentStore,
  createAttachmentService,
  createAttachmentStore,
  type NewResourceAttachment,
  type ResourceAttachment,
} from "./attachments.ts";
export {
  type Accounts,
  type Actor,
  API_KEY_SCOPES,
  type ApiKey,
  type ApiKeyScope,
  AuthError,
  createAccounts,
  type ExternalIdentityVerifier,
  type IdentityProvider,
  type Organization,
  type Principal,
} from "./auth.ts";
export { type Catalog, createCatalog, type Offering, type OfferingPrice } from "./catalog.ts";
export {
  createEphemeralSql,
  createInMemoryTakoformHost,
  createTakoformHost,
} from "./compat.ts";
export { ControlError, createControlRoutes } from "./control.ts";
export { createDataAiRoutes, type DataAiRoutes } from "./data-ai.ts";
export { bytesDigest, canonicalDigest, canonicalJson } from "./json.ts";
export {
  createLedger,
  type FundingSettlementVerifier,
  type Ledger,
  type LedgerEntry,
  LedgerError,
  type Wallet,
} from "./ledger.ts";
export { createMemoryObjectStore } from "./objects-mem.ts";
export { createR2ObjectStore } from "./objects-r2.ts";
export { openApiDocument, openApiPaths } from "./openapi.ts";
export type {
  Clock,
  JsonObject,
  JsonValue,
  ObjectStore,
  Sql,
  SqlWrite,
} from "./ports.ts";
export {
  createOpenAiGateway,
  type OpenAiGatewayOptions,
  type OpenAiModelConfig,
  parseOpenAiModelConfig,
} from "./providers/openai.ts";
export {
  createReseller,
  type Quote,
  type Reseller,
  ResellerError,
  type Reservation,
  type UsageStatement,
} from "./reseller.ts";
export {
  createResourceDeploymentStore,
  type NewResourceDeployment,
  type ResourceDeployment,
  type ResourceDeploymentState,
  type ResourceDeploymentStore,
} from "./resource-deployments.ts";
export { createRouter, type Router } from "./router.ts";
export {
  type S3Access,
  S3CredentialError,
  type S3CredentialIssue,
  type S3CredentialIssuer,
  type S3CredentialSet,
  validateS3CredentialSet,
} from "./s3-port.ts";
export { createD1Sql } from "./sql-d1.ts";
export { createMemorySql, createSqliteSql } from "./sql-sqlite.ts";
export { parseStrictJson, StrictJsonError } from "./strict-json.ts";
export { createTakoformArtifacts } from "./takoform/artifacts.ts";
export { InMemoryTakoformResourceDriver } from "./takoform/memory-driver.ts";
export type {
  InstalledTakoformForm,
  TakoformDiagnostic,
  TakoformDriverReceipt,
  TakoformHost,
  TakoformHostPrincipal,
  TakoformResourceDriver,
  TakoformStoredResource,
  TakoformV1Alpha3FormRef,
} from "./takoform/types.ts";
export { TakoformHostError } from "./takoform/types.ts";
export {
  TAKOFORM_EDGE_OBJECTS_INTERFACE,
  TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM,
  TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_INSTALLED_FORM,
} from "./takoform-released-provider.ts";
export {
  createTokenService,
  type SigningKey,
  TokenError,
  type TokenService,
} from "./token.ts";
