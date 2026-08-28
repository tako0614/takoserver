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
import { parseOpenAiModelConfig } from "../../src/providers/openai.ts";
import {
  type ProductionStandardServiceSupplies,
  parseProductionStandardServiceSupplies,
} from "../../src/standard-service-production.ts";
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
  /** Public id of the R2 parent token used to mint temporary S3 credentials. */
  readonly r2ParentAccessKeyId?: string;
  /** Host-owned stable protocol supplies; no Form or commercial Offering identity. */
  readonly standardServiceSupplies?: ProductionStandardServiceSupplies;
  /** Non-secret commercial/provider composition emitted by takoserver-private. */
  readonly objectBucketSupplies?: HostedObjectBucketSupplies;
  /** Reviewed Cloudflare sales for released edge identity Forms. */
  readonly edgeSupplies?: HostedEdgeSupplies;
  /** Exact workers.dev suffix assigned to the provisioning account. */
  readonly workerEndpointSuffix?: string;
  /**
   * Named Worker entrypoint that resolves opaque host-runtime requirements.
   *
   * This is routing metadata, never secret material. The materialized values
   * cross only the Worker service-binding RPC boundary at provisioning time.
   */
  readonly hostedTopology?: {
    readonly service: string;
    readonly entrypoint: string;
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
const ENTRYPOINT = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u;

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
  return validateTarget(parsed, path, environment);
}

function validateTarget(
  value: unknown,
  path: string,
  environment: DeployEnvironment,
): DeployTarget {
  if (!isRecord(value)) throw preflightError(`deploy target descriptor must be an object: ${path}`);
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
      "r2ParentAccessKeyId",
      "standardServiceSupplies",
      "objectBucketSupplies",
      "edgeSupplies",
      "workerEndpointSuffix",
      "hostedTopology",
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
    ...(value.r2ParentAccessKeyId === undefined
      ? {}
      : {
          r2ParentAccessKeyId: pattern(value.r2ParentAccessKeyId, KEY_ID, "r2ParentAccessKeyId"),
        }),
    ...(value.standardServiceSupplies === undefined
      ? {}
      : {
          standardServiceSupplies: parseProductionStandardServiceSupplies(
            value.standardServiceSupplies,
          ),
        }),
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
    ...(value.hostedTopology === undefined
      ? {}
      : {
          hostedTopology: hostedTopology(value.hostedTopology),
        }),
    signing: signing(value.signing),
  };
  const cloudflareObjectSupply = target.objectBucketSupplies?.supplies.some(
    (supply) => supply.provider.kind === "cloudflare",
  );
  if (Boolean(target.r2ParentAccessKeyId) !== Boolean(cloudflareObjectSupply)) {
    throw preflightError(
      "deploy target Cloudflare ObjectBucket supply and `r2ParentAccessKeyId` must be configured together",
    );
  }
  if (Boolean(target.edgeSupplies) !== Boolean(target.workerEndpointSuffix)) {
    throw preflightError(
      "deploy target edge supplies and `workerEndpointSuffix` must be configured together",
    );
  }
  if (target.takosId && target.googleClientId) {
    throw preflightError("deploy target cannot configure both `takosId` and `googleClientId`");
  }
  return target;
}

function hostedTopology(value: unknown): {
  service: string;
  entrypoint: string;
} {
  if (!isRecord(value)) {
    throw preflightError("deploy target `hostedTopology` must be an object");
  }
  assertExactKeys(value, ["service", "entrypoint"]);
  return {
    service: pattern(value.service, WORKER_NAME, "hostedTopology.service"),
    entrypoint: pattern(value.entrypoint, ENTRYPOINT, "hostedTopology.entrypoint"),
  };
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
