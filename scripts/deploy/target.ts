import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  type HostedEdgeSupplies,
  parseHostedEdgeSupplies,
} from "../../src/hosted-edge-supplies.ts";
import {
  type HostedObjectBucketSupplies,
  parseHostedObjectBucketSupplies,
} from "../../src/hosted-object-bucket-supplies.ts";
import { INTEGRATION_E2E_ORGANIZATION_ID } from "../../src/integration-e2e-credential-authority.ts";
import { parseOpenAiModelConfig } from "../../src/providers/openai.ts";
import { preflightError } from "./errors.ts";
import { REPOSITORY } from "./process.ts";
import type { DeployEnvironment } from "./qualification.ts";

/**
 * The realized deploy target. It names one Cloudflare account and the exact
 * resources this repository may publish onto. It is operator-private and is
 * never committed: the repository stays account-neutral.
 */
export interface DeployTarget {
  readonly kind: "takoserver.deploy-target@v2";
  readonly environment: DeployEnvironment;
  readonly accountId: string;
  readonly workerName: string;
  readonly d1: { readonly databaseName: string; readonly databaseId: string };
  readonly r2: { readonly bucketName: string };
  readonly publicOrigin: string;
  /**
   * Other hostnames this deployment also answers on.
   *
   * `publicOrigin` is the canonical address — the one discovery advertises and
   * the one a client should use. An alias is a second door to the same rooms,
   * which an apex usually is: people type the bare domain, and a bare domain
   * that answers nothing looks like a product that is not there.
   */
  readonly aliases?: readonly string[];
  /**
   * Where this deployment's console is served, if it has one. Optional because
   * a deployment is a complete product without a console — the API, the CLI and
   * the Takoform provider are the whole of it for anyone integrating.
   */
  readonly consoleOrigin?: string;
  /**
   * Public OAuth client id. Its presence is what turns Google sign-in on.
   *
   * Not a secret — it ships in every page that offers the button — but it is
   * per-deployment, which is why it lives beside the account and the origin
   * rather than in the repository.
   */
  readonly googleClientId?: string;
  /** Exact Takos ID issuer and this deployment's public OIDC client id. */
  readonly takosId?: { readonly issuer: string; readonly clientId: string };
  /** Requires the deployed Worker to offer customer Stripe Checkout funding. */
  readonly stripeCheckout?: boolean;
  /**
   * DNS zones this deployment may attach customer Workers to.
   *
   * Declared here because which domains a deployment serves is a property of
   * the deployment, and because leaving it to an environment variable somebody
   * edits by hand is how a zone quietly stops being offered.
   */
  readonly zones?: readonly Record<string, unknown>[];
  /** Private model mapping and retail prices for the ordinary AI API. */
  readonly aiModels?: readonly Record<string, unknown>[];
  /** Non-secret commercial/provider composition emitted by takoserver-private. */
  readonly objectBucketSupplies?: HostedObjectBucketSupplies;
  /** Reviewed Cloudflare sales for released edge identity Forms. */
  readonly edgeSupplies?: HostedEdgeSupplies;
  /** Exact workers.dev suffix assigned to the provisioning account. */
  readonly workerEndpointSuffix?: string;
  /** Requires the private bearer that authorizes the sponsorship owner API. */
  readonly sponsorship?: boolean;
  /** Route-less Form authority Workers sharing this target's existing D1/R2. */
  readonly formAuthority?: {
    readonly workerName: string;
    /** Permanent minimal workers.dev bridge used only for live identity RPC readback. */
    readonly identityProbeWorkerName: string;
    readonly identityProbeOrigin: string;
    readonly integrationWorkerName?: string;
    readonly integrationOperatorWorkerName?: string;
    readonly integrationOperatorOrigin?: string;
    /** Exact integration Space that the signed operator invocation may activate. */
    readonly integrationOperatorScope?: {
      readonly tenantId: string;
      readonly space: string;
    };
    /** Public half of the dedicated integration Form-authority operator key. */
    readonly operatorPublicJwk?: {
      readonly kty: "OKP";
      readonly crv: "Ed25519";
      readonly x: string;
    };
    readonly hostId: string;
  };
  /**
   * Public half of this deployment operator's identity-only proof key.
   *
   * This is deliberately target data rather than a Worker secret: the Worker
   * verifies an offline login assertion and never receives the private half.
   * It does not enable the legacy wallet-funding verifier. Only the dedicated
   * operator-identity authority surface may change the exact value declared
   * here.
   */
  readonly operatorIdentity?: {
    readonly publicJwk: {
      readonly kty: "OKP";
      readonly crv: "Ed25519";
      readonly x: string;
    };
  };
  /** Integration-only JIT API-key authority. The private half is never target data. */
  readonly integrationE2eCredentialAuthority?: {
    readonly organizationId: typeof INTEGRATION_E2E_ORGANIZATION_ID;
    readonly publicJwk: {
      readonly kty: "OKP";
      readonly crv: "Ed25519";
      readonly x: string;
    };
  };
  /**
   * `nextKeyId` is present only while an explicit rotation is pending. The
   * routine Worker target is then the next id, but only the rotation surface
   * may bridge the live current id to it.
   */
  readonly signing: {
    readonly currentKeyId: string;
    readonly nextKeyId?: string;
  };
}

export const DEPLOY_TARGET_KIND = "takoserver.deploy-target@v2";

const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const GOOGLE_CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/u;
const HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const BASE64URL_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

export function targetPath(environment: DeployEnvironment): string {
  const variable = `TAKOSERVER_DEPLOY_TARGET_${environment.toUpperCase()}`;
  const candidate = process.env[variable] ?? `.deploy/targets/${environment}.json`;
  return isAbsolute(candidate) ? candidate : resolve(REPOSITORY, candidate);
}

export function loadTarget(path: string, environment: DeployEnvironment): DeployTarget {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw preflightError(
      `deploy target descriptor not found: ${path}`,
      "Create an operator-private descriptor. It is gitignored and holds the only " +
        "account-specific values:\n" +
        JSON.stringify(
          {
            kind: DEPLOY_TARGET_KIND,
            environment,
            accountId: "<32 hex characters>",
            workerName: `takoserver-api-${environment}`,
            d1: { databaseName: `takoserver-runtime-${environment}`, databaseId: "<uuid>" },
            r2: { bucketName: `takoserver-objects-${environment}` },
            publicOrigin: `https://<${environment}-worker>.<subdomain>.workers.dev`,
            signing: { currentKeyId: `takoserver-${environment}-<yyyy-mm>` },
          },
          null,
          2,
        ),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw preflightError(`deploy target descriptor is not valid JSON: ${path}`);
  }
  return parseDeployTarget(parsed, path, environment);
}

/** Pure validation of one already-decoded operator-private target descriptor. */
export function parseDeployTarget(
  value: unknown,
  source: string,
  environment: DeployEnvironment,
): DeployTarget {
  if (!isRecord(value)) {
    throw preflightError(`deploy target descriptor must be an object: ${source}`);
  }
  assertExactKeys(
    value,
    ["kind", "environment", "accountId", "workerName", "d1", "r2", "publicOrigin", "signing"],
    [
      "aliases",
      "consoleOrigin",
      "googleClientId",
      "takosId",
      "stripeCheckout",
      "zones",
      "aiModels",
      "objectBucketSupplies",
      "edgeSupplies",
      "workerEndpointSuffix",
      "sponsorship",
      "formAuthority",
      "operatorIdentity",
      "integrationE2eCredentialAuthority",
    ],
  );

  if (value.kind !== DEPLOY_TARGET_KIND) {
    throw preflightError(`deploy target kind must be ${DEPLOY_TARGET_KIND}`);
  }
  if (value.environment !== environment) {
    throw preflightError(
      `deploy target environment ${JSON.stringify(value.environment)} does not match selected ${environment}`,
    );
  }

  const d1 = value.d1;
  const r2 = value.r2;
  if (!isRecord(d1)) throw preflightError("deploy target `d1` must be an object");
  if (!isRecord(r2)) throw preflightError("deploy target `r2` must be an object");
  assertExactKeys(d1, ["databaseName", "databaseId"]);
  assertExactKeys(r2, ["bucketName"]);

  const target: DeployTarget = {
    kind: DEPLOY_TARGET_KIND,
    environment,
    accountId: pattern(value.accountId, ACCOUNT_ID, "accountId"),
    workerName: pattern(value.workerName, WORKER_NAME, "workerName"),
    d1: {
      databaseName: pattern(d1.databaseName, BUCKET_NAME, "d1.databaseName"),
      databaseId: pattern(d1.databaseId, UUID, "d1.databaseId"),
    },
    r2: { bucketName: pattern(r2.bucketName, BUCKET_NAME, "r2.bucketName") },
    publicOrigin: httpsOrigin(value.publicOrigin),
    ...(value.aliases === undefined ? {} : { aliases: hostnames(value.aliases) }),
    ...(value.consoleOrigin === undefined
      ? {}
      : { consoleOrigin: httpsOrigin(value.consoleOrigin) }),
    ...(value.googleClientId === undefined
      ? {}
      : { googleClientId: pattern(value.googleClientId, GOOGLE_CLIENT_ID, "googleClientId") }),
    ...(value.takosId === undefined ? {} : { takosId: takosId(value.takosId) }),
    ...(value.stripeCheckout === undefined
      ? {}
      : { stripeCheckout: boolean(value.stripeCheckout, "stripeCheckout") }),
    ...(value.zones === undefined ? {} : { zones: zoneList(value.zones) }),
    ...(value.aiModels === undefined ? {} : { aiModels: modelList(value.aiModels) }),
    ...(value.objectBucketSupplies === undefined
      ? {}
      : { objectBucketSupplies: supplyList(value.objectBucketSupplies) }),
    ...(value.edgeSupplies === undefined
      ? {}
      : { edgeSupplies: edgeSupplyList(value.edgeSupplies) }),
    ...(value.workerEndpointSuffix === undefined
      ? {}
      : {
          workerEndpointSuffix: pattern(
            value.workerEndpointSuffix,
            HOSTNAME,
            "workerEndpointSuffix",
          ),
        }),
    ...(value.sponsorship === undefined
      ? {}
      : { sponsorship: boolean(value.sponsorship, "sponsorship") }),
    ...(value.formAuthority === undefined
      ? {}
      : {
          formAuthority: formAuthority(value.formAuthority, environment),
        }),
    ...(value.operatorIdentity === undefined
      ? {}
      : { operatorIdentity: operatorIdentity(value.operatorIdentity) }),
    ...(value.integrationE2eCredentialAuthority === undefined
      ? {}
      : {
          integrationE2eCredentialAuthority: integrationE2eCredentialAuthority(
            value.integrationE2eCredentialAuthority,
          ),
        }),
    signing: signing(value.signing),
  };
  if (Boolean(target.edgeSupplies) !== Boolean(target.workerEndpointSuffix)) {
    throw preflightError(
      "deploy target edge supplies and `workerEndpointSuffix` must be configured together",
    );
  }
  if (target.takosId && target.googleClientId) {
    throw preflightError("deploy target cannot configure both `takosId` and `googleClientId`");
  }
  if (target.integrationE2eCredentialAuthority && environment !== "integration") {
    throw preflightError("deploy target `integrationE2eCredentialAuthority` is integration-only");
  }
  if (target.formAuthority) {
    if (target.formAuthority.hostId !== target.publicOrigin) {
      throw preflightError(
        "deploy target `formAuthority.hostId` must equal the public Takoserver Host origin",
      );
    }
    const names = [
      target.workerName,
      target.formAuthority.workerName,
      target.formAuthority.identityProbeWorkerName,
      ...(target.formAuthority.integrationWorkerName
        ? [target.formAuthority.integrationWorkerName]
        : []),
      ...(target.formAuthority.integrationOperatorWorkerName
        ? [target.formAuthority.integrationOperatorWorkerName]
        : []),
    ];
    if (new Set(names).size !== names.length) {
      throw preflightError("deploy target Form authority Worker names must be distinct");
    }
    const probe = new URL(target.formAuthority.identityProbeOrigin);
    if (
      !probe.hostname.endsWith(".workers.dev") ||
      probe.hostname.split(".")[0] !== target.formAuthority.identityProbeWorkerName
    ) {
      throw preflightError(
        "deploy target Form authority identity probe must use its named workers.dev origin",
      );
    }
    if (
      target.formAuthority.integrationOperatorOrigin &&
      (target.formAuthority.integrationOperatorOrigin === target.publicOrigin ||
        target.aliases?.includes(new URL(target.formAuthority.integrationOperatorOrigin).hostname))
    ) {
      throw preflightError("deploy target Form authority operator origin must be separate");
    }
    if (
      target.formAuthority.integrationOperatorWorkerName &&
      !target.formAuthority.operatorPublicJwk
    ) {
      throw preflightError(
        "deploy target Form authority operator gateway requires its dedicated operatorPublicJwk",
      );
    }
  }
  if (target.integrationE2eCredentialAuthority) {
    const authorityKey = target.integrationE2eCredentialAuthority.publicJwk.x;
    const reused = [
      target.operatorIdentity?.publicJwk.x,
      target.formAuthority?.operatorPublicJwk?.x,
    ].filter((value): value is string => value !== undefined && value === authorityKey);
    if (reused.length > 0) {
      throw preflightError(
        "deploy target integration E2E API-key authority must use a dedicated Ed25519 key",
      );
    }
  }
  return target;
}

function formAuthority(
  value: unknown,
  environment: DeployEnvironment,
): NonNullable<DeployTarget["formAuthority"]> {
  if (!isRecord(value)) {
    throw preflightError("deploy target `formAuthority` must be an object");
  }
  assertExactKeys(
    value,
    ["workerName", "hostId", "identityProbeWorkerName", "identityProbeOrigin"],
    [
      "integrationWorkerName",
      "integrationOperatorWorkerName",
      "integrationOperatorOrigin",
      "integrationOperatorScope",
      "operatorPublicJwk",
    ],
  );
  const integrationWorkerName =
    value.integrationWorkerName === undefined
      ? undefined
      : pattern(value.integrationWorkerName, WORKER_NAME, "formAuthority.integrationWorkerName");
  if (integrationWorkerName !== undefined && environment !== "integration") {
    throw preflightError("deploy target `formAuthority.integrationWorkerName` is integration-only");
  }
  const integrationOperatorWorkerName =
    value.integrationOperatorWorkerName === undefined
      ? undefined
      : pattern(
          value.integrationOperatorWorkerName,
          WORKER_NAME,
          "formAuthority.integrationOperatorWorkerName",
        );
  const integrationOperatorOrigin =
    value.integrationOperatorOrigin === undefined
      ? undefined
      : httpsOrigin(value.integrationOperatorOrigin);
  if (Boolean(integrationOperatorWorkerName) !== Boolean(integrationOperatorOrigin)) {
    throw preflightError(
      "deploy target Form authority integration operator Worker and origin must be configured together",
    );
  }
  if (
    integrationOperatorWorkerName !== undefined &&
    (environment !== "integration" || integrationOperatorOrigin?.endsWith(".workers.dev"))
  ) {
    throw preflightError(
      "deploy target Form authority operator gateway is integration-only and requires a custom origin",
    );
  }
  const operatorPublicJwk =
    value.operatorPublicJwk === undefined
      ? undefined
      : publicEd25519Jwk(value.operatorPublicJwk, "formAuthority.operatorPublicJwk");
  const integrationOperatorScope =
    value.integrationOperatorScope === undefined
      ? undefined
      : formAuthorityOperatorScope(value.integrationOperatorScope);
  if (
    Boolean(integrationOperatorWorkerName) !== Boolean(operatorPublicJwk) ||
    Boolean(integrationOperatorWorkerName) !== Boolean(integrationOperatorScope)
  ) {
    throw preflightError(
      "deploy target Form authority operator gateway, operatorPublicJwk and integrationOperatorScope must be configured together",
    );
  }
  if (
    typeof value.hostId !== "string" ||
    value.hostId.length === 0 ||
    value.hostId.length > 255 ||
    value.hostId.trim() !== value.hostId ||
    [...value.hostId].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw preflightError("deploy target `formAuthority.hostId` is invalid");
  }
  return {
    workerName: pattern(value.workerName, WORKER_NAME, "formAuthority.workerName"),
    identityProbeWorkerName: pattern(
      value.identityProbeWorkerName,
      WORKER_NAME,
      "formAuthority.identityProbeWorkerName",
    ),
    identityProbeOrigin: httpsOrigin(value.identityProbeOrigin),
    ...(integrationWorkerName === undefined ? {} : { integrationWorkerName }),
    ...(integrationOperatorWorkerName === undefined
      ? {}
      : {
          integrationOperatorWorkerName,
          integrationOperatorOrigin: integrationOperatorOrigin as string,
          integrationOperatorScope: integrationOperatorScope as NonNullable<
            NonNullable<DeployTarget["formAuthority"]>["integrationOperatorScope"]
          >,
          operatorPublicJwk: operatorPublicJwk as NonNullable<
            NonNullable<DeployTarget["formAuthority"]>["operatorPublicJwk"]
          >,
        }),
    hostId: value.hostId,
  };
}

function formAuthorityOperatorScope(
  value: unknown,
): NonNullable<NonNullable<DeployTarget["formAuthority"]>["integrationOperatorScope"]> {
  if (!isRecord(value) || !exactKeySet(value, ["tenantId", "space"])) {
    throw preflightError(
      "deploy target `formAuthority.integrationOperatorScope` must contain exact tenantId/space members",
    );
  }
  return {
    tenantId: boundedTargetIdentity(value.tenantId, "integrationOperatorScope.tenantId"),
    space: boundedTargetIdentity(value.space, "integrationOperatorScope.space"),
  };
}

function boundedTargetIdentity(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value) ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw preflightError(`deploy target \`formAuthority.${field}\` is invalid`);
  }
  return value;
}

function operatorIdentity(value: unknown): NonNullable<DeployTarget["operatorIdentity"]> {
  if (!isRecord(value)) {
    throw preflightError("deploy target `operatorIdentity` must be an object");
  }
  if (!exactKeySet(value, ["publicJwk"])) {
    throw preflightError("deploy target `operatorIdentity` must contain only `publicJwk`");
  }
  return { publicJwk: publicEd25519Jwk(value.publicJwk, "operatorIdentity.publicJwk") };
}

function integrationE2eCredentialAuthority(
  value: unknown,
): NonNullable<DeployTarget["integrationE2eCredentialAuthority"]> {
  if (!isRecord(value) || !exactKeySet(value, ["organizationId", "publicJwk"])) {
    throw preflightError(
      "deploy target `integrationE2eCredentialAuthority` must contain exact organizationId/publicJwk members",
    );
  }
  if (value.organizationId !== INTEGRATION_E2E_ORGANIZATION_ID) {
    throw preflightError(
      `deploy target integration E2E organization must be ${INTEGRATION_E2E_ORGANIZATION_ID}`,
    );
  }
  return {
    organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
    publicJwk: publicEd25519Jwk(value.publicJwk, "integrationE2eCredentialAuthority.publicJwk"),
  };
}

function publicEd25519Jwk(
  value: unknown,
  field: string,
): { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string } {
  if (!isRecord(value)) {
    throw preflightError(`deploy target \`${field}\` must be an object`);
  }
  if (!exactKeySet(value, ["kty", "crv", "x"])) {
    throw preflightError(
      `deploy target \`${field}\` must be public-only with exact kty/crv/x members`,
    );
  }
  if (
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    typeof value.x !== "string" ||
    !BASE64URL_32.test(value.x)
  ) {
    throw preflightError(`deploy target \`${field}\` must be one exact public Ed25519 JWK`);
  }
  return { kty: "OKP", crv: "Ed25519", x: value.x };
}

function exactKeySet(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function signing(value: unknown): { currentKeyId: string; nextKeyId?: string } {
  if (!isRecord(value)) throw preflightError("deploy target `signing` must be an object");
  assertExactKeys(value, ["currentKeyId"], ["nextKeyId"]);
  const currentKeyId = pattern(value.currentKeyId, KEY_ID, "signing.currentKeyId");
  if (value.nextKeyId === undefined) return { currentKeyId };
  const nextKeyId = pattern(value.nextKeyId, KEY_ID, "signing.nextKeyId");
  if (nextKeyId === currentKeyId) {
    throw preflightError("deploy target signing currentKeyId and nextKeyId must differ");
  }
  return { currentKeyId, nextKeyId };
}

function takosId(value: unknown): { issuer: string; clientId: string } {
  if (!isRecord(value)) throw preflightError("deploy target `takosId` must be an object");
  assertExactKeys(value, ["issuer", "clientId"]);
  return {
    issuer: httpsOrigin(value.issuer),
    clientId: pattern(value.clientId, KEY_ID, "takosId.clientId"),
  };
}

/**
 * Exactly the required keys, plus any of the optional ones.
 *
 * The strictness is the point: a descriptor with a misspelled key would
 * otherwise deploy successfully against a target subtly other than the one the
 * operator wrote down.
 */
/** Hostnames, as hostnames — not origins, because a route is not a URL. */
function hostnames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw preflightError("deploy target `aliases` must be an array");
  return value.map((entry) => {
    if (typeof entry !== "string" || !HOSTNAME.test(entry)) {
      throw preflightError(`alias is not a hostname: ${JSON.stringify(entry)}`);
    }
    return entry;
  });
}

/** Zones, checked only for the shape the provider will read. */
function zoneList(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw preflightError("deploy target `zones` must be an array");
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.suffix !== "string" || typeof entry.zoneId !== "string") {
      throw preflightError("each zone needs a `suffix` and a `zoneId`");
    }
  }
  return value as readonly Record<string, unknown>[];
}

function modelList(value: unknown): readonly Record<string, unknown>[] {
  try {
    parseOpenAiModelConfig(JSON.stringify(value));
  } catch {
    throw preflightError("deploy target `aiModels` is invalid");
  }
  return structuredClone(value) as readonly Record<string, unknown>[];
}

function supplyList(value: unknown): HostedObjectBucketSupplies {
  try {
    return parseHostedObjectBucketSupplies(JSON.stringify(value));
  } catch {
    throw preflightError("deploy target `objectBucketSupplies` is invalid");
  }
}

function edgeSupplyList(value: unknown): HostedEdgeSupplies {
  try {
    return parseHostedEdgeSupplies(JSON.stringify(value));
  } catch {
    throw preflightError("deploy target `edgeSupplies` is invalid");
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(value).sort();
  const missing = required.filter((key) => !actual.includes(key));
  const unknown = actual.filter((key) => !required.includes(key) && !optional.includes(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw preflightError(
      `deploy target has unexpected keys: got ${JSON.stringify(actual)}, ` +
        `expected ${JSON.stringify([...required].sort())}` +
        (optional.length > 0 ? ` and optionally ${JSON.stringify([...optional].sort())}` : ""),
    );
  }
}

function pattern(value: unknown, expression: RegExp, field: string): string {
  if (typeof value !== "string" || !expression.test(value)) {
    throw preflightError(`deploy target \`${field}\` is invalid`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw preflightError(`deploy target \`${field}\` is invalid`);
  }
  return value;
}

function httpsOrigin(value: unknown): string {
  if (typeof value !== "string") throw preflightError("deploy target `publicOrigin` is invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw preflightError("deploy target `publicOrigin` is not a URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw preflightError("deploy target `publicOrigin` must be a bare https origin");
  }
  return url.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
