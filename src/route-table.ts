/**
 * The one declaration of this Host's HTTP surface.
 *
 * The surface used to be stated three times over: `openapi.ts` built the
 * published document from a hand-written path map, `tests/http-contract.test.ts`
 * transcribed that map back as a second list of strings to compare it against,
 * and the dispatcher matched a third set of literals and regular expressions.
 * Two lists that are written by hand and compared to each other cannot disagree
 * about a route neither of them mentions: `DELETE /v1/session` — the Console's
 * sign-out, called from `console/src/api.ts` — and the whole private
 * `/v1/sponsorship/tenants/**` seam were served and documented nowhere.
 *
 * This table is that one declaration. The published document is projected from
 * it, and the contract test derives its expectation from it and then goes to
 * the built application to check that every route declared here is one the
 * dispatcher actually knows. Deriving the dispatcher itself from this table is
 * the remaining half and lands with the resource-lifecycle consolidation.
 */

export type RouteMethod = "get" | "post" | "put" | "delete" | "head";

export interface RouteDeclaration {
  readonly method: RouteMethod;
  /** The OpenAPI path template this Host answers at. */
  readonly pattern: string;
  /**
   * The stable name of the operation. `openapi.ts` looks the published
   * description up by this name, so a documented route without a description —
   * or a description no route names — is a build-time refusal.
   */
  readonly operation: string;
  /**
   * A private product-to-product seam, served only for a caller holding this
   * Host's sponsorship service credential and answered with `not_found` for
   * everyone else. It belongs to the surface and is checked for reachability
   * like any other route, and it is deliberately absent from the published
   * document: no customer key and no browser may reach it.
   */
  readonly internal?: true;
}

/** Every path this Host answers at, in the order the document publishes them. */
export const ROUTES: readonly RouteDeclaration[] = [
  { method: "get", pattern: "/", operation: "console" },
  { method: "get", pattern: "/openapi.json", operation: "openapiDocument" },
  { method: "get", pattern: "/.well-known/takoserver", operation: "productDiscovery" },
  { method: "get", pattern: "/.well-known/takoform/v1", operation: "takoformDiscovery" },
  { method: "get", pattern: "/v1/identity/providers", operation: "identityProviders" },
  {
    method: "post",
    pattern: "/v1/operator-owner-proof",
    operation: "proveOperatorOrganizationOwner",
  },
  { method: "post", pattern: "/v1/sessions", operation: "createSession" },
  { method: "delete", pattern: "/v1/session", operation: "endSession" },
  { method: "get", pattern: "/v1/me", operation: "readPrincipal" },
  { method: "get", pattern: "/v1/ai/models", operation: "listAiModels" },
  { method: "post", pattern: "/v1/ai/chat/completions", operation: "createAiChatCompletion" },
  { method: "get", pattern: "/v1/forms", operation: "listHostForms" },
  { method: "post", pattern: "/v1/organizations", operation: "createOrganization" },
  {
    method: "post",
    pattern: "/v1/organizations/{organizationId}/api-keys",
    operation: "createApiKey",
  },
  {
    method: "get",
    pattern: "/v1/organizations/{organizationId}/api-keys",
    operation: "listApiKeys",
  },
  {
    method: "put",
    pattern: "/v1/worker-endpoint-origin-reservations/{reservationId}",
    operation: "prepareWorkerEndpointOriginReservation",
  },
  {
    method: "get",
    pattern: "/v1/worker-endpoint-origin-reservations/{reservationId}",
    operation: "readWorkerEndpointOriginReservation",
  },
  {
    method: "delete",
    pattern: "/v1/worker-endpoint-origin-reservations/{reservationId}",
    operation: "releaseWorkerEndpointOriginReservation",
  },
  {
    method: "put",
    pattern: "/v1/worker-endpoint-origin-reservations/{reservationId}/activation",
    operation: "activateWorkerEndpointOrigin",
  },
  {
    method: "delete",
    pattern: "/v1/worker-endpoint-origin-reservations/{reservationId}/activation",
    operation: "deactivateWorkerEndpointOrigin",
  },
  {
    method: "put",
    pattern: "/v1/takoform/worker-runtime-input-preparations/{operationKey}",
    operation: "prepareWorkerRuntimeInput",
  },
  {
    method: "get",
    pattern: "/v1/takoform/worker-runtime-input-preparations/{operationKey}",
    operation: "readWorkerRuntimeInput",
  },
  {
    method: "delete",
    pattern: "/v1/takoform/worker-runtime-input-preparations/{operationKey}",
    operation: "revokeWorkerRuntimeInput",
  },
  {
    method: "get",
    pattern: "/v1/organizations/{organizationId}/resources",
    operation: "listOrganizationResources",
  },
  {
    method: "get",
    pattern: "/v1/organizations/{organizationId}/resources/{resourceUid}",
    operation: "readOrganizationResource",
  },
  {
    method: "get",
    pattern: "/v1/organizations/{organizationId}/resources/{resourceUid}/execution-evidence",
    operation: "readResourceExecutionEvidence",
  },
  {
    method: "get",
    pattern: "/v1/organizations/{organizationId}/resources/{resourceUid}/native-residual",
    operation: "readNativeResidual",
  },
  {
    method: "get",
    pattern: "/v1/organizations/{organizationId}/artifact-consumer-repairs/{deploymentId}",
    operation: "readArtifactConsumerRepair",
  },
  {
    method: "post",
    pattern: "/v1/organizations/{organizationId}/artifact-consumer-repairs/{deploymentId}",
    operation: "applyArtifactConsumerRepair",
  },
  {
    method: "get",
    pattern: "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations",
    operation: "listResourceMigrations",
  },
  {
    method: "post",
    pattern: "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations",
    operation: "planResourceMigration",
  },
  {
    method: "get",
    pattern: "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations/{migrationId}",
    operation: "readResourceMigration",
  },
  {
    method: "post",
    pattern:
      "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations/{migrationId}/execute",
    operation: "executeResourceMigration",
  },
  {
    method: "post",
    pattern:
      "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations/{migrationId}/cutover",
    operation: "cutoverResourceMigration",
  },
  {
    method: "post",
    pattern:
      "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations/{migrationId}/rollback",
    operation: "rollbackResourceMigration",
  },
  {
    method: "post",
    pattern:
      "/v1/organizations/{organizationId}/resources/{resourceUid}/migrations/{migrationId}/cancel",
    operation: "cancelResourceMigration",
  },
  {
    method: "get",
    pattern: "/v1/organizations/{organizationId}/attachments",
    operation: "listAttachments",
  },
  {
    method: "post",
    pattern: "/v1/organizations/{organizationId}/attachments",
    operation: "createAttachment",
  },
  {
    method: "get",
    pattern: "/v1/organizations/{organizationId}/attachments/{attachmentId}",
    operation: "readAttachment",
  },
  {
    method: "delete",
    pattern: "/v1/organizations/{organizationId}/attachments/{attachmentId}",
    operation: "deleteAttachment",
  },
  {
    method: "get",
    pattern: "/v1/organizations/{organizationId}/operations",
    operation: "listOrganizationOperations",
  },
  {
    method: "delete",
    pattern: "/v1/organizations/{organizationId}/api-keys/{apiKeyId}",
    operation: "revokeApiKey",
  },
  {
    method: "get",
    pattern: "/v1/organizations/{organizationId}/wallet",
    operation: "readWallet",
  },
  {
    method: "post",
    pattern: "/v1/organizations/{organizationId}/wallet/checkout",
    operation: "beginWalletCheckout",
  },
  {
    method: "post",
    pattern: "/v1/organizations/{organizationId}/wallet/funding",
    operation: "creditWalletFromSettlement",
  },
  { method: "get", pattern: "/v1/catalog", operation: "listOfferings" },
  { method: "post", pattern: "/v1/reseller/quotes", operation: "createResellerQuote" },
  { method: "post", pattern: "/v1/reseller/reservations", operation: "createResellerReservation" },
  {
    method: "post",
    pattern: "/v1/reseller/reservations/{reservationId}/capture",
    operation: "captureResellerReservation",
  },
  {
    method: "post",
    pattern: "/v1/reseller/reservations/{reservationId}/release",
    operation: "releaseResellerReservation",
  },
  {
    method: "post",
    pattern: "/v1/reseller/reservations/{reservationId}/provision-tokens",
    operation: "mintProvisionToken",
  },
  {
    method: "post",
    pattern: "/v1/reseller/reservations/{reservationId}/takoform-run-tokens",
    operation: "mintTakoformRunToken",
  },
  {
    method: "get",
    pattern: "/v1/reseller/reservations/{reservationId}/usage-statement",
    operation: "readUsageStatement",
  },

  // The private sponsorship seam. One first-party product holds the service
  // credential; every other caller is answered `not_found`.
  {
    method: "post",
    pattern: "/v1/sponsorship/tenants/{tenantRef}",
    operation: "bindSponsoredTenant",
    internal: true,
  },
  {
    method: "get",
    pattern: "/v1/sponsorship/tenants/{tenantRef}/wallet",
    operation: "readSponsoredTenantWallet",
    internal: true,
  },
  {
    method: "post",
    pattern: "/v1/sponsorship/tenants/{tenantRef}/takoform-run-credentials",
    operation: "issueSponsoredTakoformRunCredential",
    internal: true,
  },
  {
    method: "post",
    pattern: "/v1/sponsorship/tenants/{tenantRef}/interface-oauth-resources/authorize",
    operation: "authorizeSponsoredInterfaceOauthResource",
    internal: true,
  },
  {
    method: "get",
    pattern: "/v1/sponsorship/tenants/{tenantRef}/inventory",
    operation: "listSponsoredTenantInventory",
    internal: true,
  },
  {
    method: "post",
    pattern: "/v1/sponsorship/tenants/{tenantRef}/funding",
    operation: "fundSponsoredTenant",
    internal: true,
  },
  {
    method: "get",
    pattern: "/v1/sponsorship/tenants/{tenantRef}/resources",
    operation: "listSponsoredResources",
    internal: true,
  },
  {
    method: "put",
    pattern: "/v1/sponsorship/tenants/{tenantRef}/resources/{resourceUid}",
    operation: "setSponsoredResourceBillingMode",
    internal: true,
  },
  {
    method: "delete",
    pattern: "/v1/sponsorship/tenants/{tenantRef}/resources/{resourceUid}",
    operation: "deleteSponsoredResource",
    internal: true,
  },
];

/** The one stable Takoform Host lane this Host serves. */
export const TAKOFORM_LANES = ["v1"] as const;

/** Every Takoform Host route, relative to a lane mount. */
export const TAKOFORM_ROUTES: readonly RouteDeclaration[] = [
  { method: "get", pattern: "/forms", operation: "takoformResolveForm" },
  {
    method: "get",
    pattern: "/form-definitions/{group}/{kind}",
    operation: "takoformReadFormDefinition",
  },
  { method: "get", pattern: "/support/forms", operation: "takoformListSupportProfiles" },
  {
    method: "get",
    pattern: "/support/forms/{group}/{kind}/{definitionVersion}",
    operation: "takoformReadSupportProfile",
  },
  {
    method: "get",
    pattern: "/support/interfaces/{name}/{version}",
    operation: "takoformReadInterfaceContract",
  },
  {
    method: "get",
    pattern: "/support/bindings/{name}/{version}",
    operation: "takoformReadBindingContract",
  },
  { method: "post", pattern: "/resources/validate", operation: "takoformValidateResource" },
  { method: "post", pattern: "/resources/prepare", operation: "takoformPrepareResource" },
  { method: "get", pattern: "/resources/{group}/{kind}/{name}", operation: "takoformReadResource" },
  {
    method: "put",
    pattern: "/resources/{group}/{kind}/{name}",
    operation: "takoformApplyResource",
  },
  {
    method: "delete",
    pattern: "/resources/{group}/{kind}/{name}",
    operation: "takoformDeleteResource",
  },
  {
    method: "post",
    pattern: "/resources/{group}/{kind}/{name}/observe",
    operation: "takoformObserveResource",
  },
  {
    method: "post",
    pattern: "/resources/{group}/{kind}/{name}/import",
    operation: "takoformImportResource",
  },
  { method: "get", pattern: "/operations/{operationId}", operation: "takoformReadOperation" },
  {
    method: "post",
    pattern: "/operations/{operationId}/cancel",
    operation: "takoformCancelOperation",
  },
  { method: "post", pattern: "/artifacts/uploads", operation: "takoformStartArtifactUpload" },
  {
    method: "delete",
    pattern: "/artifacts/uploads/{uploadId}",
    operation: "takoformAbandonArtifactUpload",
  },
  {
    method: "post",
    pattern: "/artifacts/uploads/{uploadId}/commit",
    operation: "takoformCommitArtifactUpload",
  },
  {
    method: "put",
    pattern: "/artifacts/uploads/{uploadId}/blobs/{digest}",
    operation: "takoformUploadArtifactBlob",
  },
  { method: "get", pattern: "/artifacts/{digest}", operation: "takoformReadArtifactManifest" },
  { method: "head", pattern: "/artifacts/blobs/{digest}", operation: "takoformHeadArtifactBlob" },
];

/** The mounted path of one Takoform Host route on one lane. */
export function takoformRoutePattern(lane: string, pattern: string): string {
  return `/apis/forms.takoform.com/${lane}${pattern}`;
}
