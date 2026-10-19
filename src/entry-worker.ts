import { type App, type AppPorts, buildApp } from "./app.ts";
import { auth103NativeSourceCodeSelected } from "./auth103-native-origin-source.ts";
import { createAuth103SourceClock } from "./auth103-source-clock.ts";
import { parseBillingConfig } from "./billing-config.ts";
import { createCatalog } from "./catalog.ts";
import { buildEdgeForms } from "./edge-forms.ts";
import { errorEnvelopeResponse } from "./error-envelope.ts";
import {
  createWorkerRequestConsumersWithFinancialAuthSourceClock,
  readWorkerRequestFinancialAuthConsumerPort,
} from "./financial-auth-consumer.ts";
import {
  createCanonicalHostedBillingComposition,
  type HostedBillingComposition,
  type HostedOnDemandConfiguration,
} from "./hosted-billing-composition.ts";
import {
  type HostedBillingFinancialRealm,
  verifyHostedBillingFinancialRealm,
} from "./hosted-billing-realm.ts";
import { assertHostedPricingMatchesBilling, parseHostedPricing } from "./hosted-pricing.ts";
import { resolveIdentity } from "./identity-setup.ts";
import {
  INTEGRATION_E2E_ORGANIZATION_ID,
  type IntegrationE2eCredentialAuthorityConfig,
  resolveIntegrationE2eCredentialAuthorityConfig,
} from "./integration-e2e-credential-authority.ts";
import {
  type IntegrationOrganizationBootstrapConfig,
  resolveIntegrationOrganizationBootstrapConfig,
} from "./integration-organization-bootstrap.ts";
import {
  createMoneyCutoverSql,
  inspectMoneyCutoverGuard,
  MONEY_CUTOVER_WRITER_POLICY,
} from "./money-cutover-sql.ts";
import { createR2ObjectStore } from "./objects-r2.ts";
import {
  createOperatorPaymentsReconcileVerifier,
  createOperatorSettlement,
} from "./operator-credentials.ts";
import { assertOrgBillingSchema } from "./org-billing.ts";
import { parseOrgOnDemandTerms } from "./org-on-demand-terms.ts";
import { paymentSettingsFromEnvironment } from "./payment-settings.ts";
import { resolvePayment } from "./payment-setup.ts";
import type { Clock, ObjectStoreAccess, Sql } from "./ports.ts";
import type { CloudflareProviderExecutorRpc } from "./providers/cloudflare-provider-executor-port.ts";
import type { CloudflareWorkersAiBinding } from "./providers/cloudflare-workers-ai.ts";
import { embeddedPublicFormImplementationIdentity } from "./public-form-implementation-build.ts";
import { selectPublicHostFormSource } from "./public-host-form-source.ts";
import type {
  PublicFormImplementationIdentity,
  PublicWorkerImplementationIdentity,
} from "./public-host-identity.ts";
import { createResourceDeploymentStore } from "./resource-deployments.ts";
import { createRuntimeInputAuthority } from "./runtime-input-preparations.ts";
import {
  parseRuntimeInputKeyAuthority,
  parseRuntimeInputSealKeyRing,
} from "./runtime-input-seal-keyring.ts";
import {
  createFinancialActionConsentR1Reader,
  readFinancialActionConsentR1RequestCaptures,
} from "./shared-financial-retained-r1.ts";
import { loadSigningKey } from "./signing-key.ts";
import { createD1Sql } from "./sql-d1.ts";
import { parseStrictJson } from "./strict-json.ts";
import { assertStripeBillingSchema } from "./stripe-billing.ts";
import { createStripeBillingClient } from "./stripe-billing-client.ts";
import { assertStripeModeRealm, parseStripeMode } from "./stripe-mode-realm.ts";
import { createTakoformArtifacts } from "./takoform/artifacts.ts";
import { createTakoformStore } from "./takoform/store.ts";
import { parseTakoformV2ApplicationConfig } from "./takoform-v2/config.ts";
import type { V2HostAcceptance } from "./takoform-v2/host-acceptance.ts";
import { drainV2Operations } from "./takoform-v2/worker-wake.ts";
import { createWorkerDataServices } from "./worker-data-services.ts";
import {
  createWorkerEndpointOriginReservationBindingHandle,
  createWorkerEndpointOriginReservations,
} from "./worker-endpoint-origin-reservations.ts";
import { createWorkerProductionComposition } from "./worker-production-composition.ts";
import {
  captureWorkerSharedAuthStaging,
  createWorkerPrimaryRequestSql,
  createWorkerRequestSql,
  readWorkerRequestFinancialInputs,
  type WorkerRequestDatabase,
  type WorkerRequestSql,
  type WorkerSharedAuthStaging,
} from "./worker-request-composition.ts";
import { captureWorkerRequestNativeRpTransport } from "./worker-request-native-rp-transport.ts";

/**
 * The Cloudflare Workers entry.
 *
 * This serves the public product and keeps Host state, artifacts, and sealed
 * runtime-input preparation. Parent-provider credentials are deliberately not
 * part of this environment: reviewed Cloudflare operations cross one typed,
 * route-less service binding, and providers without such an executor fail
 * closed before the Worker serves.
 */

export interface WorkerEnv {
  readonly AI?: CloudflareWorkersAiBinding;
  readonly STATE_DB: WorkerRequestDatabase;
  readonly OBJECTS: Parameters<typeof createR2ObjectStore>[0];
  readonly WORKER_VERSION: { readonly id: string };
  readonly PUBLIC_ORIGIN?: string;
  /** Non-secret exact v2 documentation and optional complete Form composition. */
  readonly TAKOSERVER_TAKOFORM_V2_CONFIG?: string;
  /** Stable operator-managed canonical base64url cursor HMAC key. */
  readonly TAKOSERVER_TAKOFORM_V2_CURSOR_KEY?: string;
  /** Exact deploy lane. Integration-only operator routes refuse every other value. */
  readonly TAKOSERVER_ENVIRONMENT?: string;
  /** Public half of the dedicated operator proof key for the JIT pair lifecycle. */
  readonly TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK?: string;
  /** Existing organization to which the JIT writer/evidence pair is pinned. */
  readonly TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID?: string;
  /** Exact source and built artifact identities injected by the owning deploy surface. */
  readonly TAKOSERVER_SOURCE_COMMIT?: string;
  readonly TAKOSERVER_WORKER_ARTIFACT_DIGEST?: string;
  /** Temporary fail-closed 0042/0043 deployment bridge; never a steady mode. */
  readonly TAKOSERVER_ARTIFACT_BLOB_IO_MODE?: string;
  /** Whole-Host schema maintenance; never a serving runtime mode. */
  readonly TAKOSERVER_SCHEMA_MAINTENANCE_MODE?: string;
  readonly TAKOSERVER_MONEY_CUTOVER_WRITER_POLICY?: string;
  readonly TAKOSERVER_MONEY_CUTOVER_WRITER_EPOCH?: string;
  /** Where this deployment's console is served, if it has one. */
  readonly TAKOSERVER_CONSOLE_ORIGIN?: string;
  /** Versioned JSON Organization billing tariff; absent disables the new wallet API. */
  readonly TAKOSERVER_BILLING_CONFIG?: string;
  /** Explicit deployment-wide financial realm; absent means TEST. */
  readonly TAKOSERVER_STRIPE_MODE?: string;
  /** Explicit hosted-only pricing JSON; its native Price must match the selected Stripe realm. */
  readonly TAKOSERVER_HOSTED_PRICING?: string;
  /** Exact opt-in to the separately qualified Hosted TEST payment composition. */
  readonly TAKOSERVER_HOSTED_BILLING?: string;
  /** Explicit inline terms/card-flow JSON; accepted only with canonical-test. */
  readonly TAKOSERVER_HOSTED_BILLING_ON_DEMAND?: string;
  /** Non-secret deployment-selected account and stable billing authority. */
  readonly TAKOSERVER_HOSTED_BILLING_ACCOUNT_ID?: string;
  readonly TAKOSERVER_HOSTED_BILLING_AUTHORITY?: string;
  /** Public half of the operator key, as an Ed25519 JWK. */
  readonly OPERATOR_PUBLIC_JWK?: string;
  /**
   * Public half of an identity-only operator key.
   *
   * Unlike the legacy OPERATOR_PUBLIC_JWK, this key may sign login assertions
   * but never wallet-funding assertions.
   */
  readonly OPERATOR_IDENTITY_PUBLIC_JWK?: string;
  /** Public OAuth client id. Its presence turns Google sign-in on. */
  readonly GOOGLE_CLIENT_ID?: string;
  /** Shared company identity issuer and this product's public OIDC client. */
  readonly TAKOS_ID_ISSUER?: string;
  readonly TAKOS_ID_CLIENT_ID?: string;
  /** Stripe secret key. The deploy target must separately authorize Checkout. */
  readonly STRIPE_SECRET_KEY?: string;
  /** Exact operator intent to expose Stripe Checkout on this deployment. */
  readonly TAKOSERVER_STRIPE_CHECKOUT_ENABLED?: string;
  /** Signing secret of the Stripe webhook endpoint. The target must separately authorize it. */
  readonly STRIPE_WEBHOOK_SECRET?: string;
  /** Exact operator intent to receive Stripe webhooks on this deployment. */
  readonly TAKOSERVER_STRIPE_WEBHOOK_ENABLED?: string;
  /** Non-secret payment settings; absent ones take their documented defaults. */
  readonly TAKOSERVER_STRIPE_CHECKOUT_MINIMUM_MINOR?: string;
  readonly TAKOSERVER_STRIPE_CHECKOUT_MAXIMUM_MINOR?: string;
  readonly TAKOSERVER_STRIPE_WEBHOOK_TOLERANCE_SECONDS?: string;
  readonly TAKOSERVER_STRIPE_RECONCILE_LOOKBACK_SECONDS?: string;
  /** Key id whose public half is registered for verification. */
  readonly TAKOSERVER_SIGNING_KEY_ID?: string;
  /** Private half, as an Ed25519 JWK. A secret. */
  readonly TAKOSERVER_SIGNING_KEY?: string;
  /** Private model mapping and retail price configuration. */
  readonly TAKOSERVER_AI_MODELS?: string;
  /** Versioned, non-secret commercial composition emitted by takoserver-private. */
  readonly TAKOSERVER_OBJECT_BUCKET_SUPPLIES?: string;
  /** Reviewed Cloudflare sales for released identity Forms other than storage. */
  readonly TAKOSERVER_EDGE_SUPPLIES?: string;
  /** Unpublished source qualification only; defaults to the released Forms. */
  readonly TAKOSERVER_FORM_SOURCE_CANDIDATE?: string;
  /** Typed private provider authority; never an HTTP bearer bridge. */
  readonly CLOUDFLARE_PROVIDER_EXECUTOR?: CloudflareProviderExecutorRpc;
  /** Non-secret endpoint suffix used for synchronous public address derivation. */
  readonly TAKOSERVER_MANAGED_BASE_DOMAIN?: string;
  /** Operator-private runtime-input ring; trusted v2 Form hooks also derive private custody. */
  readonly TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING?: string;
}

/**
 * Sign-in and funding both need a fact the server cannot determine alone.
 *
 * Sign-in is answered by Google where an OAuth client is configured, and
 * otherwise by the operator's signature. Funding has no such provider yet, so
 * it is the operator's signature or nothing — and nothing means refusing. That
 * refusal is the point: a stub that said yes would credit any amount while
 * looking exactly like a finished product.
 */
export function operatorCredentialKeys(env: {
  readonly OPERATOR_PUBLIC_JWK?: string;
  readonly OPERATOR_IDENTITY_PUBLIC_JWK?: string;
}): {
  readonly identity?: { readonly kty: string; readonly crv: string; readonly x: string };
  readonly settlement?: { readonly kty: string; readonly crv: string; readonly x: string };
} {
  const legacy = env.OPERATOR_PUBLIC_JWK
    ? (JSON.parse(env.OPERATOR_PUBLIC_JWK) as { kty: string; crv: string; x: string })
    : undefined;
  const identity = env.OPERATOR_IDENTITY_PUBLIC_JWK
    ? (JSON.parse(env.OPERATOR_IDENTITY_PUBLIC_JWK) as {
        kty: string;
        crv: string;
        x: string;
      })
    : legacy;
  return {
    ...(identity ? { identity } : {}),
    ...(legacy ? { settlement: legacy } : {}),
  };
}

function canonicalHostedBillingSelected(selection: string | undefined): boolean {
  if (selection !== undefined && selection !== "" && selection !== "canonical-test") {
    throw new TypeError("TAKOSERVER_HOSTED_BILLING must be canonical-test or absent");
  }
  return selection === "canonical-test";
}

function parseHostedOnDemandEnvironment(
  raw: string | undefined,
  canonicalHostedBilling: boolean,
): HostedOnDemandConfiguration | undefined {
  if (raw === undefined) return undefined;
  if (!canonicalHostedBilling) {
    throw new TypeError("TAKOSERVER_HOSTED_BILLING_ON_DEMAND requires canonical-test");
  }
  try {
    if (typeof raw !== "string") throw new TypeError();
    const bytes = new TextEncoder().encode(raw);
    const value = parseStrictJson(bytes, bytes.byteLength);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError();
    const fields = value as Record<string, unknown>;
    if (
      Object.keys(fields).length !== 3 ||
      !["terms", "cardSetupReturnUrls", "setupDisclosureRevision"].every((key) =>
        Object.hasOwn(fields, key),
      ) ||
      typeof fields.setupDisclosureRevision !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(fields.setupDisclosureRevision)
    )
      throw new TypeError();
    const terms = parseOrgOnDemandTerms(fields.terms);
    const urls = fields.cardSetupReturnUrls;
    if (typeof urls !== "object" || urls === null || Array.isArray(urls)) throw new TypeError();
    const returns = urls as Record<string, unknown>;
    if (
      Object.keys(returns).length !== 2 ||
      !["successUrl", "cancelUrl"].every((key) => Object.hasOwn(returns, key))
    )
      throw new TypeError();
    const returnUrl = (value: unknown): string => {
      if (typeof value !== "string" || value.length > 2048) throw new TypeError();
      const parsed = new URL(value);
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.hash ||
        [...parsed.searchParams.keys()].some((key) => /secret|token/iu.test(key))
      )
        throw new TypeError();
      return value;
    };
    const successUrl = returnUrl(returns.successUrl);
    const cancelUrl = returnUrl(returns.cancelUrl);
    if (new URL(successUrl).origin !== new URL(cancelUrl).origin) throw new TypeError();
    return Object.freeze({
      terms,
      cardSetupReturnUrls: Object.freeze({ successUrl, cancelUrl }),
      setupDisclosureRevision: fields.setupDisclosureRevision,
    });
  } catch {
    throw new TypeError("TAKOSERVER_HOSTED_BILLING_ON_DEMAND must be complete valid JSON");
  }
}

export function workerCredentials(
  env: Pick<
    WorkerEnv,
    | "OPERATOR_PUBLIC_JWK"
    | "OPERATOR_IDENTITY_PUBLIC_JWK"
    | "TAKOS_ID_ISSUER"
    | "TAKOS_ID_CLIENT_ID"
    | "GOOGLE_CLIENT_ID"
    | "STRIPE_SECRET_KEY"
    | "TAKOSERVER_STRIPE_MODE"
    | "TAKOSERVER_STRIPE_CHECKOUT_ENABLED"
    | "STRIPE_WEBHOOK_SECRET"
    | "TAKOSERVER_STRIPE_WEBHOOK_ENABLED"
    | "TAKOSERVER_STRIPE_CHECKOUT_MINIMUM_MINOR"
    | "TAKOSERVER_STRIPE_CHECKOUT_MAXIMUM_MINOR"
    | "TAKOSERVER_STRIPE_WEBHOOK_TOLERANCE_SECONDS"
    | "TAKOSERVER_STRIPE_RECONCILE_LOOKBACK_SECONDS"
    | "TAKOSERVER_CONSOLE_ORIGIN"
    | "TAKOSERVER_HOSTED_PRICING"
    | "TAKOSERVER_HOSTED_BILLING"
    | "TAKOSERVER_BILLING_CONFIG"
  >,
  operatorAudience: string,
) {
  const operatorKeys = operatorCredentialKeys(env);
  const identity = resolveIdentity({
    ...(env.TAKOS_ID_ISSUER && env.TAKOS_ID_CLIENT_ID
      ? {
          takosId: {
            issuer: env.TAKOS_ID_ISSUER,
            clientId: env.TAKOS_ID_CLIENT_ID,
          },
        }
      : {}),
    googleClientId: env.GOOGLE_CLIENT_ID,
    operatorPublicKeyJwk: operatorKeys.identity,
    operatorAudience,
  });
  const canonicalHostedBilling = canonicalHostedBillingSelected(env.TAKOSERVER_HOSTED_BILLING);
  const payment: ReturnType<typeof resolvePayment> = canonicalHostedBilling
    ? {}
    : resolvePayment({
        hostedPricing: parseHostedPricing(env.TAKOSERVER_HOSTED_PRICING),
        stripeMode: parseStripeMode(env.TAKOSERVER_STRIPE_MODE),
        stripeSecretKey:
          env.TAKOSERVER_STRIPE_CHECKOUT_ENABLED === "1" ? env.STRIPE_SECRET_KEY : undefined,
        // Like Checkout, a lingering secret alone never exposes the webhook.
        stripeWebhookSecret:
          env.TAKOSERVER_STRIPE_WEBHOOK_ENABLED === "1" ? env.STRIPE_WEBHOOK_SECRET : undefined,
        consoleOrigin: env.TAKOSERVER_CONSOLE_ORIGIN,
        settings: paymentSettingsFromEnvironment({
          TAKOSERVER_STRIPE_CHECKOUT_MINIMUM_MINOR: env.TAKOSERVER_STRIPE_CHECKOUT_MINIMUM_MINOR,
          TAKOSERVER_STRIPE_CHECKOUT_MAXIMUM_MINOR: env.TAKOSERVER_STRIPE_CHECKOUT_MAXIMUM_MINOR,
          TAKOSERVER_STRIPE_WEBHOOK_TOLERANCE_SECONDS:
            env.TAKOSERVER_STRIPE_WEBHOOK_TOLERANCE_SECONDS,
          TAKOSERVER_STRIPE_RECONCILE_LOOKBACK_SECONDS:
            env.TAKOSERVER_STRIPE_RECONCILE_LOOKBACK_SECONDS,
        }),
      });

  return {
    identity: identity.verifier,
    identityProviders: identity.providers,
    ...(payment.checkout ? { checkout: payment.checkout } : {}),
    ...(payment.events ? { paymentEvents: payment.events } : {}),
    // The operator identity key, never a session or API key, may run the
    // reconcile pass on demand; the route exists only beside the pass.
    ...((canonicalHostedBilling || payment.events) && operatorKeys.identity
      ? {
          operatorPaymentsReconcile: createOperatorPaymentsReconcileVerifier({
            publicKeyJwk: operatorKeys.identity,
            audience: operatorAudience,
          }),
        }
      : {}),
    // Stripe where a customer can pay; the operator's signature where they
    // cannot; and a refusal where neither exists, because a stub that said yes
    // would credit any amount while looking exactly like a finished product.
    settlement:
      payment.settlement ??
      (operatorKeys.settlement
        ? createOperatorSettlement({ publicKeyJwk: operatorKeys.settlement })
        : {
            async verify(): Promise<never> {
              throw new Error("settlement credentials are not configured");
            },
          }),
  };
}

/** Code-selected full Form map, or full plus retained-only maps, at Worker startup. */
type WorkerEntryV2FormMap = ReturnType<
  NonNullable<Parameters<typeof buildApp>[0]["v2FormFactory"]>
>;
type WorkerEntryV2FormMaps = ReturnType<
  NonNullable<Parameters<typeof buildApp>[0]["v2FormSelectionFactory"]>
>;
type WorkerEntryV2FormSelection = WorkerEntryV2FormMap | WorkerEntryV2FormMaps;

type WorkerEntryV2WorkerEndpointOriginSelection = NonNullable<
  Parameters<typeof buildApp>[0]["v2WorkerEndpointOrigin"]
>;

/** Code-only fixed compiler inputs; no request, Sql, token or SQL effect is returned. */
export type WorkerEntryV2WorkerEndpointOriginComposer = (context: {
  readonly env: WorkerEnv;
  readonly clock: Clock;
}) =>
  | WorkerEntryV2WorkerEndpointOriginSelection
  | undefined
  | Promise<WorkerEntryV2WorkerEndpointOriginSelection | undefined>;

/** Operator code supplies a genuine Container issuer bound to the final Worker Sql. */
export type WorkerEntryV2ContainerHostAcceptanceComposer = (context: {
  readonly env: WorkerEnv;
  readonly sql: Sql;
  readonly clock: Clock;
}) => V2HostAcceptance | Promise<V2HostAcceptance>;

/** Capture only trusted issuer-owned data methods before later startup awaits. */
function captureWorkerContainerHostAcceptance(value: V2HostAcceptance, sql: Sql): V2HostAcceptance {
  if (typeof value !== "object" || value === null)
    throw new TypeError("invalid internal Container Host acceptance construction");
  const ownMethod = (name: "assertSql" | "initialOutput" | "prepare" | "prepareDelete") => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "function"
    )
      throw new TypeError(`Container Host acceptance requires own ${name} method`);
    return descriptor.value.bind(value);
  };
  const assertSql = ownMethod("assertSql") as V2HostAcceptance["assertSql"];
  const initialOutput = ownMethod("initialOutput") as V2HostAcceptance["initialOutput"];
  const prepare = ownMethod("prepare") as V2HostAcceptance["prepare"];
  const prepareDelete = ownMethod("prepareDelete") as NonNullable<
    V2HostAcceptance["prepareDelete"]
  >;
  assertSql(sql);
  return Object.freeze({ assertSql, initialOutput, prepare, prepareDelete });
}

export type WorkerEntryV2FormComposer = (context: {
  readonly env: WorkerEnv;
  readonly sql: Sql;
  readonly objects: ObjectStoreAccess;
  readonly clock: Clock;
}) => WorkerEntryV2FormSelection | Promise<WorkerEntryV2FormSelection>;

type WorkerEntryV2ArtifactSourceContext = Parameters<
  NonNullable<Parameters<typeof buildApp>[0]["v2ArtifactSourceFactory"]>
>[0];

/** Synchronous code-selected source composition; no environment value enables it. */
export type WorkerEntryV2ArtifactSourceComposer = (
  context: WorkerEntryV2ArtifactSourceContext & { readonly env: WorkerEnv },
) => ReturnType<NonNullable<Parameters<typeof buildApp>[0]["v2ArtifactSourceFactory"]>>;

/** Only an explicit operator-selected Form hook can activate generic custody. */
function hasDataMethod(policy: object, name: "validateCreate" | "validateUpdate"): boolean {
  for (let owner: object | null = policy; owner !== null; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor) return "value" in descriptor && typeof descriptor.value === "function";
  }
  return false;
}

function hasSelectedV2PrivateInputHooks(
  selection: WorkerEntryV2FormSelection | undefined,
): boolean {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) return false;
  const maps = Object.hasOwn(selection, "retainedForms")
    ? [
        Object.getOwnPropertyDescriptor(selection, "forms")?.value,
        Object.getOwnPropertyDescriptor(selection, "retainedForms")?.value,
      ]
    : [selection];
  for (const forms of maps) {
    if (!forms || typeof forms !== "object" || Array.isArray(forms)) continue;
    for (const url of Reflect.ownKeys(forms)) {
      const entry = Object.getOwnPropertyDescriptor(forms, url);
      if (typeof url !== "string" || !entry?.enumerable || !("value" in entry)) continue;
      const form = entry.value;
      if (!form || typeof form !== "object") continue;
      const privateInputs = Object.getOwnPropertyDescriptor(form, "privateInputs");
      if (!privateInputs || !("value" in privateInputs)) continue;
      const policy = privateInputs.value;
      if (
        policy !== null &&
        typeof policy === "object" &&
        hasDataMethod(policy, "validateCreate") &&
        hasDataMethod(policy, "validateUpdate")
      )
        return true;
    }
  }
  return false;
}

export interface WorkerEntryOptions {
  /** Code-only isolated shared-login composition; every invocation gets one fresh primary. */
  readonly sharedAuthStaging?: WorkerSharedAuthStaging;
  /** Code-only post-graph data observer; HTTP gets its actual Request and source factory. */
  readonly observeSharedAuthRequest?: (
    connection: WorkerRequestSql,
    request?: Request,
    createReader?: typeof createFinancialActionConsentR1Reader,
    readRequestCaptures?: typeof readFinancialActionConsentR1RequestCaptures,
  ) => void | Promise<void>;
  /** Operator code only; no request or environment field selects the composer. */
  readonly composeV2Forms?: WorkerEntryV2FormComposer;
  /** Operator code only; omission or an undefined result leaves origin acceptance unselected. */
  readonly composeV2WorkerEndpointOrigin?: WorkerEntryV2WorkerEndpointOriginComposer;
  /** Operator code only; omission leaves Container acceptance unselected. */
  readonly composeV2ContainerHostAcceptance?: WorkerEntryV2ContainerHostAcceptanceComposer;
  /** Operator code only; absent means every configured artifact Form remains held-only. */
  readonly composeV2ArtifactSource?: WorkerEntryV2ArtifactSourceComposer;
  /**
   * Operator code only, evaluated once at startup from the emitted deploy mode.
   * No request field or ordinary Host configuration installs this composer.
   */
  readonly composeV2FreshAdmission?: (context: {
    readonly environment: string | undefined;
  }) => boolean;
}

/**
 * Bounded classification of a startup refusal.
 *
 * The Worker composes itself lazily, per request, so a target whose realized
 * configuration cannot compose used to surface as a bare provider exception
 * page with no readable cause. The classes below are the vocabulary the entry
 * answers with instead: an operator reading `/healthz`, `/.well-known/takoserver`
 * or any other route learns which half of startup refused.
 */
export type WorkerStartupFailureReason =
  | "public-origin"
  | "supply-composition"
  | "runtime-configuration"
  | "unavailable";

/** One classified startup refusal, carrying the exact cause it wraps. */
export class WorkerStartupError extends Error {
  readonly reason: WorkerStartupFailureReason;
  /** The product's own refusal sentence, when the cause produced one. */
  readonly refusal: string | undefined;

  constructor(reason: WorkerStartupFailureReason, cause: unknown) {
    const refusal = startupRefusal(cause);
    super(refusal ?? `Worker startup refused: ${reason}`, { cause });
    this.name = "WorkerStartupError";
    this.reason = reason;
    this.refusal = refusal;
  }
}

/**
 * Only the product's own refusal vocabulary reaches a caller.
 *
 * Every composition and configuration refusal in this graph is a `TypeError`
 * whose message is an authored sentence over non-secret descriptors. Anything
 * else is reported as an unreadable failure rather than echoed, because its
 * text is not a value this Host has declared safe to publish.
 */
function startupRefusal(cause: unknown): string | undefined {
  return cause instanceof TypeError ? cause.message : undefined;
}

/** Runs one startup stage and attributes its refusal to that stage. */
function startupStage<T>(reason: WorkerStartupFailureReason, body: () => T): T {
  try {
    return body();
  } catch (error) {
    throw error instanceof WorkerStartupError ? error : new WorkerStartupError(reason, error);
  }
}

/**
 * The readable answer a Worker that cannot start still owes every caller.
 *
 * It is the ordinary wire envelope at `503 backend_unavailable`, so a client
 * that already decodes this Host's errors reads it without a special case, and
 * `details.reason` names the class. No response is cached: the next request
 * recomposes, so a repaired configuration serves as soon as it lands.
 */
export function workerStartupFailureResponse(error: unknown): Response {
  const startup = error instanceof WorkerStartupError ? error : null;
  const reason: WorkerStartupFailureReason =
    startup?.reason ?? (error instanceof TypeError ? "runtime-configuration" : "unavailable");
  const refusal = startup ? startup.refusal : startupRefusal(error);
  return errorEnvelopeResponse(
    "backend_unavailable",
    503,
    { reason },
    { headers: { "cache-control": "no-store" } },
    refusal,
  );
}

function artifactBlobIoMode(
  env: Pick<WorkerEnv, "TAKOSERVER_ARTIFACT_BLOB_IO_MODE">,
): "normal" | "pre-0043-quiesced" {
  const value = env.TAKOSERVER_ARTIFACT_BLOB_IO_MODE;
  if (value === undefined) return "normal";
  if (value === "pre-0043-quiesced") return value;
  throw new TypeError("TAKOSERVER_ARTIFACT_BLOB_IO_MODE is invalid");
}

function schemaMaintenanceMode(
  env: Pick<WorkerEnv, "TAKOSERVER_SCHEMA_MAINTENANCE_MODE" | "TAKOSERVER_ARTIFACT_BLOB_IO_MODE">,
):
  | "normal"
  | "pre-0058-quiesced"
  | "pre-v2-0088-quiesced"
  | "pre-wallet-usd-micros-quiesced"
  | "pre-auth103-quiesced" {
  const value = env.TAKOSERVER_SCHEMA_MAINTENANCE_MODE;
  if (value === undefined) return "normal";
  if (
    value !== "pre-0058-quiesced" &&
    value !== "pre-v2-0088-quiesced" &&
    value !== "pre-wallet-usd-micros-quiesced" &&
    value !== "pre-auth103-quiesced"
  ) {
    throw new TypeError("TAKOSERVER_SCHEMA_MAINTENANCE_MODE is invalid");
  }
  if (env.TAKOSERVER_ARTIFACT_BLOB_IO_MODE !== undefined) {
    throw new TypeError("schema maintenance and artifact blob I/O modes conflict");
  }
  return value;
}

function moneyCutoverWriterPolicy(env: WorkerEnv): string | null {
  const value = env.TAKOSERVER_MONEY_CUTOVER_WRITER_POLICY;
  const epoch = env.TAKOSERVER_MONEY_CUTOVER_WRITER_EPOCH;
  if (value === undefined && epoch === undefined) return null;
  if (value !== MONEY_CUTOVER_WRITER_POLICY || env.TAKOSERVER_ENVIRONMENT !== "integration") {
    throw new TypeError("money cutover writer policy is invalid");
  }
  if (typeof epoch !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(epoch)) {
    throw new TypeError("money cutover Writer epoch is invalid");
  }
  return epoch;
}

function moneyCutoverFrozenResponse(): Response {
  return errorEnvelopeResponse(
    "backend_unavailable",
    503,
    { reason: "money-cutover-freeze" },
    { headers: { "cache-control": "no-store", "retry-after": "60" } },
    "Host is frozen for the wallet USD-micros writer transition",
  );
}

function schemaMaintenanceResponse(
  mode:
    | "pre-0058-quiesced"
    | "pre-v2-0088-quiesced"
    | "pre-wallet-usd-micros-quiesced"
    | "pre-auth103-quiesced",
): Response {
  return errorEnvelopeResponse(
    "backend_unavailable",
    503,
    { reason: "runtime-configuration" },
    { headers: { "cache-control": "no-store", "retry-after": "60" } },
    mode === "pre-auth103-quiesced"
      ? "Host is quiesced for the Auth103 source registration transition"
      : mode === "pre-wallet-usd-micros-quiesced"
        ? "Host is quiesced for the wallet USD-micros schema maintenance transition"
        : mode === "pre-0058-quiesced"
          ? "Host is quiesced for the 0058 schema maintenance transition"
          : "Host is quiesced for the v2 0088 schema maintenance transition",
  );
}

function artifactBlobIoQuiescenceResponse(): Response {
  return errorEnvelopeResponse(
    "backend_unavailable",
    503,
    { reason: "runtime-configuration" },
    { headers: { "cache-control": "no-store", "retry-after": "60" } },
    "artifact blob I/O is quiesced for the 0043 compatibility cutover",
  );
}

/**
 * The official Worker has one operator-owned public address. It is injected by
 * the owning deploy target; deriving it from the request host would let an
 * alias or service binding silently become the product's advertised identity.
 */
export function requirePublicOrigin(env: { readonly PUBLIC_ORIGIN?: string | undefined }): string {
  const origin = env.PUBLIC_ORIGIN?.trim();
  if (!origin) throw new TypeError("PUBLIC_ORIGIN is required for the official Worker");
  return origin;
}

export function resolvePublicWorkerImplementationIdentity(
  env: Pick<WorkerEnv, "TAKOSERVER_WORKER_ARTIFACT_DIGEST">,
  embedded:
    | PublicFormImplementationIdentity
    | undefined = embeddedPublicFormImplementationIdentity(),
): PublicWorkerImplementationIdentity | undefined {
  const artifact = env.TAKOSERVER_WORKER_ARTIFACT_DIGEST;
  if (artifact !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(artifact)) {
    throw new TypeError("public Worker Form implementation identity is incomplete");
  }
  // The artifact digest also binds JIT credential provenance. Only embedded
  // Form implementation metadata declares this independent Form identity.
  if (embedded === undefined) return undefined;
  if (artifact === undefined) {
    throw new TypeError("public Worker Form implementation identity is incomplete");
  }
  return { workerArtifactDigest: artifact as `sha256:${string}`, ...embedded };
}

/**
 * No dedicated fields means no route. Once either dedicated field appears,
 * every provenance and policy field is required before D1 is constructed.
 */
export function workerIntegrationE2eCredentialAuthority(
  env: Pick<
    WorkerEnv,
    | "WORKER_VERSION"
    | "OPERATOR_PUBLIC_JWK"
    | "OPERATOR_IDENTITY_PUBLIC_JWK"
    | "TAKOSERVER_ENVIRONMENT"
    | "TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK"
    | "TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID"
    | "TAKOSERVER_SOURCE_COMMIT"
    | "TAKOSERVER_WORKER_ARTIFACT_DIGEST"
    | "TAKOSERVER_SIGNING_KEY_ID"
    | "TAKOSERVER_SIGNING_KEY"
  >,
): IntegrationE2eCredentialAuthorityConfig | undefined {
  const enabled =
    env.TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK !== undefined ||
    env.TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID !== undefined;
  if (!enabled) return undefined;
  const values = [
    env.TAKOSERVER_ENVIRONMENT,
    env.TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK,
    env.TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID,
    env.TAKOSERVER_SOURCE_COMMIT,
    env.TAKOSERVER_WORKER_ARTIFACT_DIGEST,
    env.WORKER_VERSION?.id,
  ];
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new TypeError("integration E2E credential authority configuration is incomplete");
  }
  if (env.TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID !== INTEGRATION_E2E_ORGANIZATION_ID) {
    throw new TypeError(
      `integration E2E credential authority organization must be ${INTEGRATION_E2E_ORGANIZATION_ID}`,
    );
  }
  const resolved = resolveIntegrationE2eCredentialAuthorityConfig({
    environment: env.TAKOSERVER_ENVIRONMENT as "integration",
    publicJwk: env.TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK as string,
    organizationId: env.TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID as string,
    sourceCommit: env.TAKOSERVER_SOURCE_COMMIT as string,
    artifactDigest: env.TAKOSERVER_WORKER_ARTIFACT_DIGEST as `sha256:${string}`,
    publicWorkerVersionId: env.WORKER_VERSION.id,
  });
  if (!resolved) throw new TypeError("integration E2E credential authority is unavailable");
  const operatorKeys = operatorCredentialKeys(env);
  if (
    operatorKeys.identity?.x === resolved.publicJwk.x ||
    operatorKeys.settlement?.x === resolved.publicJwk.x
  ) {
    throw new TypeError(
      "integration E2E API-key authority must not reuse a sign-in or funding key",
    );
  }
  const signingPublicJwk = configuredSigningPublicJwk(
    env.TAKOSERVER_SIGNING_KEY_ID,
    env.TAKOSERVER_SIGNING_KEY,
  );
  if (signingPublicJwk.x === resolved.publicJwk.x) {
    throw new TypeError("integration E2E API-key authority must not reuse the runtime signing key");
  }
  return resolved;
}

/**
 * Mount the fixed bootstrap only on an exact integration Host which already
 * has the ordinary identity-only operator verifier and the separately keyed,
 * fixed-Organization JIT authority with identical deploy provenance.
 *
 * This is deliberately optional: a Host without that complete closure keeps
 * serving its existing routes instead of acquiring a new all-or-nothing
 * startup dependency. Invalid non-integration values therefore mean route
 * absence; the route/config constructors themselves still reject such a
 * configuration when called directly.
 */
export function workerIntegrationOrganizationBootstrap(
  env: Pick<
    WorkerEnv,
    | "OPERATOR_IDENTITY_PUBLIC_JWK"
    | "TAKOSERVER_ENVIRONMENT"
    | "TAKOSERVER_SOURCE_COMMIT"
    | "TAKOSERVER_WORKER_ARTIFACT_DIGEST"
    | "WORKER_VERSION"
  >,
  hostId: string,
  credentialAuthority: IntegrationE2eCredentialAuthorityConfig | undefined,
): IntegrationOrganizationBootstrapConfig | undefined {
  if (env.TAKOSERVER_ENVIRONMENT !== "integration") return undefined;
  let authority: ReturnType<typeof resolveIntegrationE2eCredentialAuthorityConfig>;
  try {
    authority = resolveIntegrationE2eCredentialAuthorityConfig(credentialAuthority);
  } catch {
    return undefined;
  }
  const values = [
    env.OPERATOR_IDENTITY_PUBLIC_JWK,
    env.TAKOSERVER_SOURCE_COMMIT,
    env.TAKOSERVER_WORKER_ARTIFACT_DIGEST,
    env.WORKER_VERSION?.id,
  ];
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    return undefined;
  }
  if (
    !authority ||
    authority.organizationId !== INTEGRATION_E2E_ORGANIZATION_ID ||
    authority.sourceCommit !== env.TAKOSERVER_SOURCE_COMMIT ||
    authority.artifactDigest !== env.TAKOSERVER_WORKER_ARTIFACT_DIGEST ||
    authority.publicWorkerVersionId !== env.WORKER_VERSION.id
  ) {
    return undefined;
  }
  try {
    const configuration = resolveIntegrationOrganizationBootstrapConfig({
      environment: "integration",
      hostId,
      publicJwk: env.OPERATOR_IDENTITY_PUBLIC_JWK as string,
      sourceCommit: authority.sourceCommit,
      artifactDigest: authority.artifactDigest,
      publicWorkerVersionId: authority.publicWorkerVersionId,
    });
    if (!configuration || configuration.publicJwk.x === authority.publicJwk.x) return undefined;
    return configuration;
  } catch {
    return undefined;
  }
}

function configuredSigningPublicJwk(
  keyId: string | undefined,
  privateJwk: string | undefined,
): JsonWebKey & { readonly x: string } {
  if (!keyId || !privateJwk) {
    throw new TypeError(
      "integration E2E API-key authority requires the configured runtime signing key",
    );
  }
  return readSigningPublicJwk(privateJwk);
}

function readSigningPublicJwk(privateJwk: string): JsonWebKey & { readonly x: string } {
  let value: unknown;
  try {
    value = JSON.parse(privateJwk);
  } catch {
    throw new TypeError("runtime signing key public half is unavailable");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).kty !== "OKP" ||
    (value as Record<string, unknown>).crv !== "Ed25519" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(String((value as Record<string, unknown>).x))
  ) {
    throw new TypeError("runtime signing key public half is unavailable");
  }
  const publicJwk = {
    kty: "OKP",
    crv: "Ed25519",
    x: (value as Record<string, unknown>).x as string,
  } satisfies JsonWebKey & { readonly x: string };
  return publicJwk;
}

async function proveSigningPublicJwk(privateJwk: string, privateKey: CryptoKey): Promise<void> {
  const publicJwk = readSigningPublicJwk(privateJwk);
  try {
    const publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "Ed25519" }, false, [
      "verify",
    ]);
    const message = new TextEncoder().encode("takoserver.integration-e2e.signing-separation@v1");
    const signature = await crypto.subtle.sign("Ed25519", privateKey, message);
    if (!(await crypto.subtle.verify("Ed25519", publicKey, signature, message))) throw new Error();
  } catch {
    throw new TypeError("runtime signing key cannot prove its configured public half");
  }
}

/** Source-only migrations never apply themselves merely because a Form is configured. */
async function requireV2ArtifactProgressSchema(sql: ReturnType<typeof createD1Sql>): Promise<void> {
  const columns = [
    "operation_id",
    "resource_uid",
    "form_url",
    "next_file_index",
    "current_file_bytes",
    "current_file_sha256",
    "file_sizes_json",
    "total_bytes",
    "lease_token",
  ];
  const actualColumns = await sql.query("PRAGMA table_info(tf_v2_artifact_progress)");
  if (
    actualColumns.length !== columns.length ||
    actualColumns.some((column, index) => column.name !== columns[index]) ||
    actualColumns[0]?.pk !== 1 ||
    actualColumns[8]?.notnull !== 1
  ) {
    throw new TypeError("configured v2 artifact Forms require the complete 0075 D1 schema");
  }
  const triggers = [
    ["tf_v2_artifact_progress_insert_guard", "tf_v2_artifact_progress"],
    ["tf_v2_artifact_progress_update_guard", "tf_v2_artifact_progress"],
    ["tf_v2_artifact_progress_monotonic", "tf_v2_artifact_progress"],
    ["tf_v2_artifact_progress_terminal_gc", "tf_v2_operations"],
    ["tf_v2_artifact_progress_no_early_delete", "tf_v2_artifact_progress"],
    ["tf_v2_migration_set_owner_lease_guard", "tf_v2_migration_set_owners"],
    ["tf_v2_artifact_owner_lease_guard", "tf_v2_artifact_owners"],
    ["tf_v2_migration_set_chunk_lease_guard", "tf_v2_migration_set_chunks"],
    ["tf_v2_artifact_chunk_lease_guard", "tf_v2_artifact_chunks"],
    ["tf_v2_migration_set_verify_lease_guard", "tf_v2_migration_set_owners"],
    ["tf_v2_artifact_verify_lease_guard", "tf_v2_artifact_owners"],
  ] as const;
  const actualTriggers = await sql.query(
    `SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger' AND name IN (${triggers.map(() => "?").join(", ")})`,
    triggers.map(([name]) => name),
  );
  const byName = new Map(actualTriggers.map((row) => [row.name, row]));
  if (
    actualTriggers.length !== triggers.length ||
    triggers.some(([name, table]) => {
      const row = byName.get(name);
      return row?.tbl_name !== table || typeof row.sql !== "string" || row.sql.length === 0;
    })
  ) {
    throw new TypeError("configured v2 artifact Forms require the complete 0075 D1 schema");
  }
}

async function requireV2PrivateInputSchema(sql: ReturnType<typeof createD1Sql>): Promise<void> {
  const unavailable = () =>
    new TypeError("configured v2 Forms require the complete 0081 D1 schema");
  const operations = await sql.query("PRAGMA table_info(tf_v2_operations)");
  const privatePresence = operations.find((column) => column.name === "private_inputs_present");
  if (
    privatePresence?.notnull !== 1 ||
    !operations.some((column) => column.name === "input_required_names_json") ||
    !operations.some((column) => column.name === "input_required_reason")
  ) {
    throw unavailable();
  }
  for (const [table, names] of [
    [
      "tf_v2_private_inputs",
      [
        "operation_id",
        "names_json",
        "comparison_key_id",
        "comparison_tag",
        "transfer_key_id",
        "transfer_nonce",
        "transfer_ciphertext",
        "transfer_expires_at_ms",
      ],
    ],
    ["tf_v2_configured_private_inputs", ["resource_uid", "key_id", "nonce", "ciphertext"]],
  ] as const) {
    const columns = await sql.query(`PRAGMA table_info(${table})`);
    if (
      columns.length !== names.length ||
      columns.some((column, index) => column.name !== names[index]) ||
      columns[0]?.pk !== 1
    ) {
      throw unavailable();
    }
  }
  const triggers = [
    [
      "tf_v2_configured_private_acceptance",
      "tf_v2_configured_private_inputs",
      "op.private_inputs_present = 1",
    ],
    [
      "tf_v2_configured_private_immutable",
      "tf_v2_configured_private_inputs",
      "tf_v2_configured_private_immutable",
    ],
    [
      "tf_v2_configured_private_delete_guard",
      "tf_v2_configured_private_inputs",
      "tf_v2_configured_private_active",
    ],
    [
      "tf_v2_configured_private_delete",
      "tf_v2_resources",
      "DELETE FROM tf_v2_configured_private_inputs",
    ],
    ["tf_v2_private_inputs_acceptance", "tf_v2_private_inputs", "op.private_inputs_present = 1"],
    [
      "tf_v2_private_input_presence_immutable",
      "tf_v2_operations",
      "tf_v2_private_input_presence_immutable",
    ],
    [
      "tf_v2_operation_transition",
      "tf_v2_operations",
      "OLD.status = 'waiting_input' AND NEW.status = 'queued'",
    ],
    ["tf_v2_private_transfer_dispatched", "tf_v2_operations", "transfer_ciphertext = NULL"],
    ["tf_v2_private_transfer_waiting", "tf_v2_operations", "NEW.status = 'waiting_input'"],
  ] as const;
  const actual = await sql.query(
    `SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger' AND name IN (${triggers.map(() => "?").join(", ")})`,
    triggers.map(([name]) => name),
  );
  const byName = new Map(actual.map((row) => [row.name, row]));
  if (
    actual.length !== triggers.length ||
    triggers.some(([name, table, required]) => {
      const row = byName.get(name);
      return (
        row?.tbl_name !== table ||
        typeof row.sql !== "string" ||
        !row.sql.replace(/\s+/gu, " ").includes(required)
      );
    })
  ) {
    throw unavailable();
  }
}

async function composeApp(
  env: WorkerEnv,
  origin: string,
  composeV2Forms: WorkerEntryV2FormComposer | undefined,
  composeV2ArtifactSource: WorkerEntryV2ArtifactSourceComposer | undefined,
  composeV2FreshAdmission: WorkerEntryOptions["composeV2FreshAdmission"],
  composeV2WorkerEndpointOrigin: WorkerEntryOptions["composeV2WorkerEndpointOrigin"],
  composeV2ContainerHostAcceptance: WorkerEntryOptions["composeV2ContainerHostAcceptance"],
  request?: {
    readonly connection: WorkerRequestSql;
    readonly sharedAuth?: WorkerSharedAuthStaging;
  },
): Promise<App> {
  const nativeAuthSelected = auth103NativeSourceCodeSelected();
  if (composeV2Forms !== undefined && typeof composeV2Forms !== "function") {
    throw new WorkerStartupError(
      "runtime-configuration",
      new TypeError("v2 Worker entry Form composer must be a function"),
    );
  }
  if (composeV2ArtifactSource !== undefined && typeof composeV2ArtifactSource !== "function") {
    throw new WorkerStartupError(
      "runtime-configuration",
      new TypeError("v2 Worker entry artifact source composer must be a function"),
    );
  }
  if (composeV2FreshAdmission !== undefined && typeof composeV2FreshAdmission !== "function") {
    throw new WorkerStartupError(
      "runtime-configuration",
      new TypeError("v2 Worker entry fresh admission composer must be a function"),
    );
  }
  if (
    composeV2WorkerEndpointOrigin !== undefined &&
    typeof composeV2WorkerEndpointOrigin !== "function"
  ) {
    throw new WorkerStartupError(
      "runtime-configuration",
      new TypeError("v2 Worker entry Endpoint origin composer must be a function"),
    );
  }
  if (
    composeV2ContainerHostAcceptance !== undefined &&
    typeof composeV2ContainerHostAcceptance !== "function"
  ) {
    throw new WorkerStartupError(
      "runtime-configuration",
      new TypeError("v2 Worker entry Container acceptance composer must be a function"),
    );
  }
  const allowFreshCreateAndUpdate =
    composeV2FreshAdmission === undefined
      ? undefined
      : startupStage("runtime-configuration", () => {
          const selected = composeV2FreshAdmission(
            Object.freeze({ environment: env.TAKOSERVER_ENVIRONMENT }),
          );
          if (typeof selected !== "boolean")
            throw new TypeError("v2 Worker entry fresh admission must be a boolean");
          return selected;
        });
  const v2Config = startupStage("runtime-configuration", () =>
    parseTakoformV2ApplicationConfig(env),
  );
  const billingConfig = startupStage("runtime-configuration", () =>
    parseBillingConfig(env.TAKOSERVER_BILLING_CONFIG),
  );
  const hostedPricing = startupStage("runtime-configuration", () => {
    const pricing = parseHostedPricing(env.TAKOSERVER_HOSTED_PRICING);
    if (pricing) assertHostedPricingMatchesBilling(pricing, billingConfig);
    return pricing;
  });
  const canonicalHostedInputs = startupStage("runtime-configuration", () => {
    const canonicalHostedBilling = canonicalHostedBillingSelected(env.TAKOSERVER_HOSTED_BILLING);
    const onDemand = parseHostedOnDemandEnvironment(
      env.TAKOSERVER_HOSTED_BILLING_ON_DEMAND,
      canonicalHostedBilling,
    );
    if (!canonicalHostedBilling) return undefined;
    if (
      env.TAKOSERVER_STRIPE_MODE !== "test" ||
      !billingConfig ||
      !hostedPricing ||
      !env.STRIPE_SECRET_KEY ||
      !env.STRIPE_WEBHOOK_SECRET ||
      !env.TAKOSERVER_CONSOLE_ORIGIN ||
      !env.TAKOSERVER_HOSTED_BILLING_ACCOUNT_ID ||
      !env.TAKOSERVER_HOSTED_BILLING_AUTHORITY
    ) {
      throw new TypeError(
        "Canonical Hosted billing requires explicit TEST intent, selected realm and complete pricing/credential capabilities",
      );
    }
    const consoleOrigin = env.TAKOSERVER_CONSOLE_ORIGIN;
    const origin = new URL(consoleOrigin);
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET.trim();
    const settings = paymentSettingsFromEnvironment({
      TAKOSERVER_STRIPE_CHECKOUT_MINIMUM_MINOR: env.TAKOSERVER_STRIPE_CHECKOUT_MINIMUM_MINOR,
      TAKOSERVER_STRIPE_CHECKOUT_MAXIMUM_MINOR: env.TAKOSERVER_STRIPE_CHECKOUT_MAXIMUM_MINOR,
      TAKOSERVER_STRIPE_WEBHOOK_TOLERANCE_SECONDS: env.TAKOSERVER_STRIPE_WEBHOOK_TOLERANCE_SECONDS,
      TAKOSERVER_STRIPE_RECONCILE_LOOKBACK_SECONDS:
        env.TAKOSERVER_STRIPE_RECONCILE_LOOKBACK_SECONDS,
    });
    const publishedSettings = paymentSettingsFromEnvironment(hostedPricing.environment);
    if (
      origin.origin !== consoleOrigin ||
      origin.username ||
      origin.password ||
      !["https:", "http:"].includes(origin.protocol) ||
      !webhookSecret.startsWith("whsec_") ||
      (settings.checkoutMinimumMinor !== undefined &&
        settings.checkoutMinimumMinor !== publishedSettings.checkoutMinimumMinor) ||
      (settings.checkoutMaximumMinor !== undefined &&
        settings.checkoutMaximumMinor !== publishedSettings.checkoutMaximumMinor)
    ) {
      throw new TypeError(
        "Canonical Hosted billing requires a canonical origin, webhook and published Checkout bounds",
      );
    }
    return {
      billingConfig,
      pricing: hostedPricing,
      client: createStripeBillingClient({ secretKey: env.STRIPE_SECRET_KEY, mode: "test" }),
      accountId: env.TAKOSERVER_HOSTED_BILLING_ACCOUNT_ID,
      billingAuthority: env.TAKOSERVER_HOSTED_BILLING_AUTHORITY,
      consoleOrigin,
      webhookSecret,
      settings: Object.freeze(settings),
      ...(onDemand === undefined ? {} : { onDemand }),
    };
  });
  // File-backed tariff loading can be designed separately; this release accepts inline JSON only.
  const integrationE2eCredentialAuthority = workerIntegrationE2eCredentialAuthority(env);
  const integrationOrganizationBootstrap = workerIntegrationOrganizationBootstrap(
    env,
    origin,
    integrationE2eCredentialAuthority,
  );
  const sql =
    request === undefined
      ? (() => {
          const rawSql = createD1Sql(env.STATE_DB);
          const writerEpoch = moneyCutoverWriterPolicy(env);
          return writerEpoch === null ? rawSql : createMoneyCutoverSql(rawSql, writerEpoch);
        })()
      : request.connection.sql;
  try {
    // The wallet and ledger use USD micros even when tariff billing is disabled.
    // This read-only proof precedes every normal serving composition and tariff write.
    await assertOrgBillingSchema(sql, canonicalHostedInputs ? undefined : billingConfig);
  } catch {
    throw new WorkerStartupError(
      "runtime-configuration",
      new TypeError("Worker requires the complete 0094 USD-micros D1 schema and money-unit policy"),
    );
  }
  try {
    // D1 activation is an operator-qualified transition. Serving code only
    // reads its immutable pin; it never claims a realm on behalf of D1.
    await assertStripeModeRealm(sql, parseStripeMode(env.TAKOSERVER_STRIPE_MODE));
  } catch {
    throw new WorkerStartupError(
      "runtime-configuration",
      new TypeError("Worker requires the qualified 0098 Stripe realm pin"),
    );
  }
  const signingKey = await loadSigningKey(
    env.TAKOSERVER_SIGNING_KEY_ID,
    env.TAKOSERVER_SIGNING_KEY,
  );
  if (integrationE2eCredentialAuthority) {
    if (!signingKey || !env.TAKOSERVER_SIGNING_KEY) {
      throw new TypeError(
        "integration E2E API-key authority requires the configured runtime signing key",
      );
    }
    await proveSigningPublicJwk(env.TAKOSERVER_SIGNING_KEY, signingKey.privateKey);
  }
  const edge = await buildEdgeForms();
  const implementationIdentity = resolvePublicWorkerImplementationIdentity(env);
  const formSource = startupStage("runtime-configuration", () =>
    selectPublicHostFormSource(env.TAKOSERVER_FORM_SOURCE_CANDIDATE, implementationIdentity),
  );
  const {
    identity,
    identityProviders,
    settlement,
    checkout,
    paymentEvents,
    operatorPaymentsReconcile,
  } = workerCredentials(env, origin);
  if (hostedPricing) {
    try {
      await assertStripeBillingSchema(sql);
    } catch {
      throw new WorkerStartupError(
        "runtime-configuration",
        new TypeError("Hosted subscriptions require the complete 0095 schema"),
      );
    }
  }
  if (
    v2Config.sqliteMigrationSet !== undefined ||
    v2Config.workerBundle !== undefined ||
    v2Config.staticAssetBundle !== undefined
  ) {
    try {
      await requireV2ArtifactProgressSchema(sql);
      await requireV2PrivateInputSchema(sql);
    } catch {
      throw new WorkerStartupError(
        "runtime-configuration",
        new TypeError("configured v2 artifact Forms require the complete 0075 and 0081 D1 schema"),
      );
    }
  }
  const objects = createR2ObjectStore(env.OBJECTS);
  const clock = nativeAuthSelected ? createAuth103SourceClock() : () => new Date();
  const requestRandomId = () => crypto.randomUUID().replaceAll("-", "");
  let hostedBilling: HostedBillingComposition | undefined;
  let hostedRealm: HostedBillingFinancialRealm | undefined;
  if (canonicalHostedInputs) {
    try {
      const realm = await verifyHostedBillingFinancialRealm({
        sql,
        reader: { client: canonicalHostedInputs.client },
        expected: {
          accountId: canonicalHostedInputs.accountId,
          billingAuthority: canonicalHostedInputs.billingAuthority,
          mode: "test",
        },
        prices: canonicalHostedInputs.pricing.hostedPlanTable.plans
          .filter((plan) => plan.tier === "subscription")
          .map((plan) => ({
            priceId: plan.stripePriceId,
            monthlyAmountMinor: plan.monthlyAmountMinor,
          })),
      });
      hostedRealm = realm;
      hostedBilling = await createCanonicalHostedBillingComposition({
        sql,
        clock,
        billingConfig: canonicalHostedInputs.billingConfig,
        pricing: canonicalHostedInputs.pricing,
        client: canonicalHostedInputs.client,
        realm,
        consoleOrigin: canonicalHostedInputs.consoleOrigin,
        webhookSecret: canonicalHostedInputs.webhookSecret,
        settings: canonicalHostedInputs.settings,
        ...(canonicalHostedInputs.onDemand === undefined
          ? {}
          : { onDemand: canonicalHostedInputs.onDemand }),
        warnings: { state: "unavailable", reason: "transport-not-composed" },
      });
    } catch (error) {
      throw new WorkerStartupError(
        "runtime-configuration",
        new TypeError(
          "Canonical Hosted billing requires the qualified TEST realm, prices and complete financial schema",
          { cause: error },
        ),
      );
    }
  }
  let workerRequest: AppPorts["workerRequest"];
  const selectedSharedAuth = request?.sharedAuth;
  if (request !== undefined && selectedSharedAuth !== undefined) {
    if (!canonicalHostedInputs || !hostedRealm || !hostedBilling)
      throw new WorkerStartupError(
        "runtime-configuration",
        new TypeError("shared-login Worker requires its genuine canonical Hosted TEST realm"),
      );
    const originalInputs = {
      connection: request.connection,
      sharedAuth: selectedSharedAuth,
      client: canonicalHostedInputs.client,
      realm: hostedRealm,
    };
    if (nativeAuthSelected) {
      try {
        const qualified = await createWorkerRequestConsumersWithFinancialAuthSourceClock(
          {
            ...originalInputs,
            sql,
            identity,
            randomId: requestRandomId,
            publicOrigin: origin,
            consoleOrigin: env.TAKOSERVER_CONSOLE_ORIGIN,
          },
          clock,
        );
        workerRequest = {
          ...originalInputs,
          originalConsumers: qualified.consumers,
          financialAuth: qualified.port,
        };
      } catch (error) {
        throw new WorkerStartupError(
          "runtime-configuration",
          new TypeError("selected native Auth request composition is unavailable", {
            cause: error,
          }),
        );
      }
    } else workerRequest = originalInputs;
  }
  if (nativeAuthSelected && workerRequest === undefined)
    throw new WorkerStartupError(
      "runtime-configuration",
      new TypeError("selected native Auth build requires its original shared-login inputs"),
    );
  let selectedV2Forms: WorkerEntryV2FormSelection | undefined;
  let selectedV2PrivateInputHooks = false;
  if (composeV2Forms !== undefined) {
    try {
      selectedV2Forms = await composeV2Forms({ env, sql, objects, clock });
      selectedV2PrivateInputHooks = hasSelectedV2PrivateInputHooks(selectedV2Forms);
    } catch (error) {
      // A private composer can throw provider/credential text. Keep its cause
      // for operator diagnostics, but never make that text a public refusal.
      throw new WorkerStartupError(
        "runtime-configuration",
        new Error("operator v2 Form composition failed", { cause: error }),
      );
    }
  }
  let selectedV2WorkerEndpointOrigin: WorkerEntryV2WorkerEndpointOriginSelection | undefined;
  if (composeV2WorkerEndpointOrigin !== undefined) {
    try {
      const selected = await composeV2WorkerEndpointOrigin(Object.freeze({ env, clock }));
      if (selected !== undefined) {
        // Capture returned inputs now, before later startup awaits. Core owns its Sql and issuer.
        const { kind, formUrl, backendId, targetKey, ledger } = selected;
        if (kind === undefined) {
          selectedV2WorkerEndpointOrigin = Object.freeze({ formUrl, backendId, targetKey, ledger });
        } else if (kind === "form-v2@1") {
          selectedV2WorkerEndpointOrigin = Object.freeze({
            kind,
            formUrl,
            backendId,
            targetKey,
            ledger,
          });
        } else {
          throw new TypeError("unsupported Worker Endpoint origin construction kind");
        }
      }
    } catch {
      throw new WorkerStartupError(
        "runtime-configuration",
        new TypeError("operator v2 Endpoint origin composition failed"),
      );
    }
  }
  let selectedV2ContainerHostAcceptance: V2HostAcceptance | undefined;
  if (composeV2ContainerHostAcceptance !== undefined) {
    try {
      const selected = await composeV2ContainerHostAcceptance(Object.freeze({ env, sql, clock }));
      const captured = captureWorkerContainerHostAcceptance(selected, sql);
      selectedV2ContainerHostAcceptance = captured;
    } catch {
      throw new WorkerStartupError(
        "runtime-configuration",
        new TypeError("operator v2 Container acceptance composition failed"),
      );
    }
  }
  const randomId = () => crypto.randomUUID();
  const originReservationBinding = createWorkerEndpointOriginReservationBindingHandle();
  const runtimeInputKeyAuthority = env.TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING
    ? selectedV2PrivateInputHooks
      ? await parseRuntimeInputKeyAuthority(env.TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING)
      : { sealKeys: await parseRuntimeInputSealKeyRing(env.TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING) }
    : undefined;
  const runtimeInputs = runtimeInputKeyAuthority
    ? createRuntimeInputAuthority({
        sql,
        sealKeys: runtimeInputKeyAuthority.sealKeys,
        canonicalPublicOrigin: origin,
        clock,
      })
    : undefined;
  const artifacts = createTakoformArtifacts({
    sql,
    objects,
    clock,
    randomId,
  });
  const dataServices = createWorkerDataServices(env);
  const deployment = startupStage("supply-composition", () =>
    createWorkerProductionComposition({
      env,
      forms: formSource.forms,
      retainedForms: [...edge.forms, ...formSource.retainedForms],
      workerClassRuntimeContracts: formSource.workerClassRuntimeContracts,
      ...(env.TAKOSERVER_FORM_SOURCE_CANDIDATE === "actor-forward"
        ? { formSourceCandidate: "actor-forward" as const }
        : {}),
      now: new Date(),
    }),
  );
  const originReservations = createWorkerEndpointOriginReservations({
    sql,
    clock,
    catalog: createCatalog(deployment.offerings),
    providers: deployment.providers,
    resources: createTakoformStore(sql, clock),
    deployments: createResourceDeploymentStore(sql, clock),
    ...(selectedV2WorkerEndpointOrigin?.kind === "form-v2@1"
      ? {
          shared: { kind: "form-v2@1" as const, ledger: selectedV2WorkerEndpointOrigin.ledger },
        }
      : {}),
  });
  originReservationBinding.connect(originReservations);
  let app: App;
  try {
    app = buildApp({
      sql,
      ...(nativeAuthSelected ? { clock, randomId: requestRandomId } : {}),
      ...(workerRequest === undefined ? {} : { workerRequest }),
      objects,
      publicWorkerVersionId: env.WORKER_VERSION.id,
      ...(implementationIdentity
        ? {
            formImplementationDigest: implementationIdentity.implementationDigest,
          }
        : {}),
      ...(integrationE2eCredentialAuthority ? { integrationE2eCredentialAuthority } : {}),
      ...(integrationOrganizationBootstrap ? { integrationOrganizationBootstrap } : {}),
      ...(runtimeInputs ? { runtimeInputs } : {}),
      originReservations,
      artifacts,
      ...(signingKey ? { signingKey } : {}),
      identity,
      identityProviders,
      settlement,
      ...(billingConfig ? { billingConfig } : {}),
      hostedPaidFreeExclusion: Boolean(hostedPricing),
      // The financial brand and buildApp's one PaymentEventContext share this exact clock.
      ...(hostedBilling ? { hostedBilling, clock } : {}),
      ...(!hostedBilling && checkout ? { checkout } : {}),
      ...(!hostedBilling && paymentEvents ? { paymentEvents } : {}),
      ...(operatorPaymentsReconcile ? { operatorPaymentsReconcile } : {}),
      ...dataServices,
      publicOrigin: origin,
      v2: v2Config,
      ...(selectedV2ContainerHostAcceptance !== undefined && hostedBilling === undefined
        ? { clock }
        : {}),
      ...(allowFreshCreateAndUpdate === undefined
        ? {}
        : { v2AllowFreshCreateAndUpdate: allowFreshCreateAndUpdate }),
      ...(selectedV2PrivateInputHooks &&
      runtimeInputKeyAuthority &&
      "privateInputCustody" in runtimeInputKeyAuthority
        ? { v2PrivateInputCustody: runtimeInputKeyAuthority.privateInputCustody }
        : {}),
      ...(selectedV2WorkerEndpointOrigin === undefined
        ? {}
        : { v2WorkerEndpointOrigin: selectedV2WorkerEndpointOrigin }),
      ...(selectedV2ContainerHostAcceptance === undefined
        ? {}
        : { v2ContainerHostAcceptance: selectedV2ContainerHostAcceptance }),
      ...(composeV2Forms === undefined
        ? {}
        : selectedV2Forms &&
            (Object.hasOwn(selectedV2Forms, "forms") ||
              Object.hasOwn(selectedV2Forms, "retainedForms"))
          ? { v2FormSelectionFactory: () => selectedV2Forms as WorkerEntryV2FormMaps }
          : { v2FormFactory: () => selectedV2Forms as WorkerEntryV2FormMap }),
      ...(composeV2ArtifactSource === undefined
        ? {}
        : {
            v2ArtifactSourceFactory: (context: WorkerEntryV2ArtifactSourceContext) =>
              composeV2ArtifactSource({ ...context, env }),
          }),
      ...(env.TAKOSERVER_CONSOLE_ORIGIN ? { consoleOrigin: env.TAKOSERVER_CONSOLE_ORIGIN } : {}),
      forms: formSource.forms,
      bindings: formSource.bindings,
      hostForms: [...formSource.forms, ...formSource.retainedForms],
      hostBindings: [...formSource.bindings, ...formSource.retainedBindings],
      providers: deployment.providers,
      providerPacks: deployment.providerPacks,
      offerings: deployment.offerings,
    });
  } catch (error) {
    if (selectedV2WorkerEndpointOrigin !== undefined) {
      throw new WorkerStartupError(
        "runtime-configuration",
        new TypeError("operator v2 Endpoint origin application construction failed"),
      );
    }
    if (selectedV2ContainerHostAcceptance !== undefined) {
      throw new WorkerStartupError(
        "runtime-configuration",
        new TypeError("operator v2 Container acceptance application construction failed"),
      );
    }
    if (composeV2Forms === undefined && composeV2ArtifactSource === undefined) throw error;
    if (composeV2ArtifactSource !== undefined) {
      // A selected source constructor can throw private transport diagnostics.
      // Do not attach its cause to a public startup refusal.
      throw new WorkerStartupError(
        "runtime-configuration",
        new TypeError("operator v2 artifact source application construction failed"),
      );
    }
    // The selected map is inspected by the canonical application only here.
    // Getters and backend constructors can throw private text after the async
    // callback has returned, so this boundary must classify them too.
    throw new WorkerStartupError(
      "runtime-configuration",
      new Error("operator v2 Form application construction failed", { cause: error }),
    );
  }
  return app;
}

/** Preserve the existing code-literal source selection for private entry composition. */
export { auth103NativeSourceCodeSelected };

/** Cache only entries without a request-owned Sql/issuer composition. */
export function createWorkerEntry(options: WorkerEntryOptions = {}) {
  const composeV2Forms = options.composeV2Forms;
  const composeV2ArtifactSource = options.composeV2ArtifactSource;
  const composeV2FreshAdmission = options.composeV2FreshAdmission;
  const composeV2WorkerEndpointOrigin = options.composeV2WorkerEndpointOrigin;
  const composeV2ContainerHostAcceptance = options.composeV2ContainerHostAcceptance;
  const observeSharedAuthRequest = options.observeSharedAuthRequest;
  const sharedAuthStaging =
    options.sharedAuthStaging === undefined
      ? undefined
      : captureWorkerSharedAuthStaging(options.sharedAuthStaging);
  const sharedRequestSelected = () =>
    sharedAuthStaging !== undefined || auth103NativeSourceCodeSelected();
  // Build selection is not authority; every selected HTTP request still performs
  // actual native registration qualification before its ONE Accounts/RP graph.
  const requestSqlSelected = () =>
    sharedRequestSelected() || composeV2ContainerHostAcceptance !== undefined;
  const starts = new WeakMap<WorkerEnv, Promise<App>>();
  const assertSelectedNativeRequest = (connection: WorkerRequestSql | undefined) => {
    if (!auth103NativeSourceCodeSelected()) return;
    if (!connection || !readWorkerRequestFinancialAuthConsumerPort(connection))
      throw new TypeError("selected native Auth request lacks its original port");
  };
  const appFor = async (
    env: WorkerEnv,
    origin: string,
    connection?: WorkerRequestSql,
  ): Promise<App> => {
    if (requestSqlSelected()) {
      if (connection === undefined)
        throw new TypeError(
          sharedAuthStaging === undefined
            ? "Container Worker request lacks its primary composition"
            : "shared-login Worker request lacks its primary composition",
        );
      // Actual startup transport plus this primary's Root projection; a missing
      // selected secret/configuration refuses, without ordinary fallback.
      const selectedSharedAuth =
        sharedAuthStaging ??
        (auth103NativeSourceCodeSelected()
          ? await captureWorkerRequestNativeRpTransport(connection)
          : undefined);
      return composeApp(
        env,
        origin,
        composeV2Forms,
        composeV2ArtifactSource,
        composeV2FreshAdmission,
        composeV2WorkerEndpointOrigin,
        composeV2ContainerHostAcceptance,
        {
          connection,
          ...(selectedSharedAuth === undefined ? {} : { sharedAuth: selectedSharedAuth }),
        },
      );
    }
    const existing = starts.get(env);
    if (existing) return existing;
    const started = composeApp(
      env,
      origin,
      composeV2Forms,
      composeV2ArtifactSource,
      composeV2FreshAdmission,
      composeV2WorkerEndpointOrigin,
      composeV2ContainerHostAcceptance,
    ).catch((error: unknown) => {
      if (starts.get(env) === started) starts.delete(env);
      throw error;
    });
    starts.set(env, started);
    return started;
  };
  const observeRequest = async (
    connection: WorkerRequestSql | undefined,
    request?: Request,
  ): Promise<void> => {
    if (observeSharedAuthRequest === undefined) return;
    if (
      typeof observeSharedAuthRequest !== "function" ||
      !sharedRequestSelected() ||
      connection === undefined
    )
      throw new WorkerStartupError(
        "runtime-configuration",
        new TypeError("shared-login request observer requires its constructed original request"),
      );
    try {
      // This validates the actual purpose and completed graph before any observer.
      const inputs = readWorkerRequestFinancialInputs(connection);
      if (request === undefined) await observeSharedAuthRequest(connection);
      else
        await observeSharedAuthRequest(
          connection,
          request,
          createFinancialActionConsentR1Reader,
          readFinancialActionConsentR1RequestCaptures,
        );
      if (readWorkerRequestFinancialInputs(connection) !== inputs)
        throw new TypeError("shared-login request input origin changed during observation");
    } catch (error) {
      throw new WorkerStartupError(
        "runtime-configuration",
        new TypeError("operator shared-login request observation failed", { cause: error }),
      );
    }
  };
  return {
    /**
     * Startup is lazy. Entries without request-owned authority cache success.
     * A startup refusal is answered rather than thrown: `/healthz`,
     * `/.well-known/takoserver` and every other route report the readable 503
     * reason class instead of a bare provider exception page.
     */
    async fetch(
      request: Request,
      env: WorkerEnv,
      context?: { waitUntil(work: Promise<unknown>): void },
    ): Promise<Response> {
      let app: App;
      try {
        const schemaMode = startupStage("runtime-configuration", () => schemaMaintenanceMode(env));
        const mode = startupStage("runtime-configuration", () => artifactBlobIoMode(env));
        const moneyPolicy = startupStage("runtime-configuration", () =>
          moneyCutoverWriterPolicy(env),
        );
        if (schemaMode !== "normal") return schemaMaintenanceResponse(schemaMode);
        if (mode === "pre-0043-quiesced") {
          return artifactBlobIoQuiescenceResponse();
        }
        let connection: WorkerRequestSql | undefined;
        let selectedOrigin: string | undefined;
        if (requestSqlSelected()) {
          selectedOrigin = startupStage("public-origin", () => requirePublicOrigin(env));
          if (moneyPolicy === null)
            throw new TypeError(
              sharedAuthStaging === undefined
                ? "Container Worker requires the selected Money writer for its native request origin"
                : "shared-login Worker requires the selected Money writer",
            );
          connection = !sharedRequestSelected()
            ? await createWorkerPrimaryRequestSql({
                database: env.STATE_DB,
                writerEpoch: moneyPolicy,
              })
            : await createWorkerRequestSql({
                database: env.STATE_DB,
                writerEpoch: moneyPolicy,
                publicOrigin: selectedOrigin,
                consoleOrigin: env.TAKOSERVER_CONSOLE_ORIGIN,
              });
          if (connection.moneyGuard === "frozen") return moneyCutoverFrozenResponse();
        } else if (moneyPolicy !== null) {
          const guard = await inspectMoneyCutoverGuard(createD1Sql(env.STATE_DB), moneyPolicy);
          if (guard === "frozen") return moneyCutoverFrozenResponse();
        }
        app = await appFor(
          env,
          selectedOrigin ?? startupStage("public-origin", () => requirePublicOrigin(env)),
          connection,
        );
        assertSelectedNativeRequest(connection);
        if (observeSharedAuthRequest !== undefined) await observeRequest(connection, request);
        assertSelectedNativeRequest(connection);
      } catch (error) {
        return workerStartupFailureResponse(error);
      }
      return await app.fetch(
        request,
        context
          ? {
              waitUntil: (work) => context.waitUntil(work),
              wakeTakoformV2: () => {
                let registered = false;
                const work = Promise.resolve()
                  .then(() =>
                    registered ? drainV2Operations(() => app.tickTakoformV2()) : undefined,
                  )
                  .catch(() => {
                    console.error("v2 Operation wake failed");
                  });
                // A rejected lifetime registration must not change the
                // already-committed HTTP acceptance or start a floating pass.
                context.waitUntil(work);
                registered = true;
              },
            }
          : undefined,
      );
    },

    /** Background settlement: expiring reservations return their holds. */
    async scheduled(_event: unknown, env: WorkerEnv): Promise<void> {
      if (schemaMaintenanceMode(env) !== "normal") return;
      if (artifactBlobIoMode(env) === "pre-0043-quiesced") return;
      const writerEpoch = moneyCutoverWriterPolicy(env);
      let connection: WorkerRequestSql | undefined;
      let selectedOrigin: string | undefined;
      if (requestSqlSelected()) {
        selectedOrigin = requirePublicOrigin(env);
        if (writerEpoch === null)
          throw new TypeError(
            sharedAuthStaging === undefined
              ? "Container Worker requires the selected Money writer for its native request origin"
              : "shared-login Worker requires the selected Money writer",
          );
        connection = !sharedRequestSelected()
          ? await createWorkerPrimaryRequestSql({
              database: env.STATE_DB,
              writerEpoch,
            })
          : await createWorkerRequestSql({
              database: env.STATE_DB,
              writerEpoch,
              publicOrigin: selectedOrigin,
              consoleOrigin: env.TAKOSERVER_CONSOLE_ORIGIN,
            });
        if (connection.moneyGuard === "frozen") return;
      } else if (writerEpoch !== null) {
        if ((await inspectMoneyCutoverGuard(createD1Sql(env.STATE_DB), writerEpoch)) === "frozen")
          return;
      }
      const app = await appFor(env, selectedOrigin ?? requirePublicOrigin(env), connection);
      assertSelectedNativeRequest(connection);
      if (observeSharedAuthRequest !== undefined) await observeRequest(connection);
      assertSelectedNativeRequest(connection);
      const results = await Promise.allSettled([
        Promise.resolve().then(() => app.tick()),
        Promise.resolve().then(() => drainV2Operations(() => app.tickTakoformV2())),
        // Every cron tick: payments nobody presented and no webhook delivered.
        Promise.resolve().then(() => app.reconcilePayments()),
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "one or more scheduled Host passes failed");
      }
    },
  };
}

export default createWorkerEntry();
