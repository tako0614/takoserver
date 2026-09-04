import {
  type CloudflareTopologyAuditEvidence,
  verifyCloudflareTopologyVisibility,
} from "./cloudflare-topology-audit.ts";
import { preflightError } from "./errors.ts";

const API = "https://api.cloudflare.com/client/v4";
const PAGE_SIZE = 100;
const MAX_PAGES = 10_000;
const MAX_PROVIDER_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_TOPOLOGY_AUDIT_RESPONSE_BYTES = 1024 * 1024;

type StateFetcher = (request: Request) => Promise<Response>;

interface Envelope {
  readonly success?: unknown;
  readonly result?: unknown;
  readonly result_info?: unknown;
  readonly errors?: unknown;
}

interface Pagination {
  readonly page: number;
  readonly perPage: number;
  readonly count: number;
  readonly totalCount: number;
  readonly totalPages: number;
}

/**
 * Read-only Cloudflare adapter with one small interface: paginated lists prove
 * their pagination closure, while endpoint-specific single-page inventories,
 * singular state, and Worker deployment history use their own response shapes.
 */
export class CloudflareState {
  readonly #accountId: string;
  readonly #token: string;
  readonly #fetcher: StateFetcher;
  readonly #topologyAuditCredentialPath: string;

  constructor(input: {
    readonly accountId: string;
    readonly token: string;
    readonly fetcher?: StateFetcher;
    readonly topologyAuditCredentialPath?: string;
  }) {
    if (!/^[0-9a-f]{32}$/u.test(input.accountId)) {
      throw preflightError("Cloudflare state requires one exact account id");
    }
    if (input.token.length === 0 || input.token.trim() !== input.token) {
      throw preflightError("Cloudflare state requires one exact API token");
    }
    this.#accountId = input.accountId;
    this.#token = input.token;
    this.#fetcher = input.fetcher ?? ((request) => fetch(request));
    this.#topologyAuditCredentialPath =
      input.topologyAuditCredentialPath ??
      process.env.TAKOSERVER_CLOUDFLARE_TOPOLOGY_AUDIT_CREDENTIAL ??
      "";
  }

  async list(path: string, label: string): Promise<readonly unknown[]> {
    return await this.#list(this.#url(path), label);
  }

  async #list(baseUrl: URL, label: string, pageSize = PAGE_SIZE): Promise<readonly unknown[]> {
    const collected: unknown[] = [];
    let expectedTotal: number | null = null;
    let totalPages: number | null = null;
    for (let page = 1; page <= (totalPages ?? 1); page += 1) {
      if (page > MAX_PAGES) throw preflightError(`${label} exceeded the pagination safety bound`);
      const url = new URL(baseUrl);
      url.searchParams.set("page", String(page));
      url.searchParams.set("per_page", String(pageSize));
      const envelope = await this.#request(url, label);
      if (!Array.isArray(envelope.result)) {
        throw preflightError(`${label} returned a non-list result`);
      }
      const pagination = parsePagination(envelope.result_info, label);
      if (pagination.page !== page || pagination.perPage !== pageSize) {
        throw preflightError(`${label} returned inconsistent pagination coordinates`);
      }
      if (pagination.count !== envelope.result.length) {
        throw preflightError(`${label} pagination count does not match the returned page`);
      }
      if (totalPages === null) {
        totalPages = Math.max(1, pagination.totalPages);
        expectedTotal = pagination.totalCount;
      } else if (
        totalPages !== Math.max(1, pagination.totalPages) ||
        expectedTotal !== pagination.totalCount
      ) {
        throw preflightError(`${label} pagination totals changed during readback`);
      }
      collected.push(...envelope.result);
    }
    if (expectedTotal === null || collected.length !== expectedTotal) {
      throw preflightError(
        `${label} pagination total does not match the exhaustive result`,
        `expected=${expectedTotal ?? "unknown"} received=${collected.length}`,
      );
    }
    return collected;
  }

  async read(path: string, label: string): Promise<unknown> {
    const envelope = await this.#request(this.#url(path), label);
    if (!("result" in envelope)) throw preflightError(`${label} returned no result`);
    return envelope.result;
  }

  async dispatchNamespace(name: string): Promise<unknown | null> {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/u.test(name)) {
      throw preflightError("Cloudflare dispatch namespace name is invalid");
    }
    const label = `${name} dispatch namespace`;
    const url = this.#url(`/workers/dispatch/namespaces/${encodeURIComponent(name)}`);
    let response: Response;
    try {
      response = await this.#fetcher(
        new Request(url, {
          method: "GET",
          redirect: "error",
          headers: { authorization: `Bearer ${this.#token}`, accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        }),
      );
    } catch (error) {
      throw preflightError(
        `${label} transport failed`,
        error instanceof Error ? error.name : typeof error,
      );
    }
    const text = await readBoundedResponseText(response, MAX_PROVIDER_RESPONSE_BYTES, label);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw preflightError(`${label} returned malformed JSON (HTTP ${response.status})`);
    }
    if (
      response.status === 404 &&
      isRecord(body) &&
      body.success === false &&
      body.result === null &&
      Array.isArray(body.errors) &&
      body.errors.length === 1 &&
      isRecord(body.errors[0]) &&
      body.errors[0].code === 100119
    ) {
      return null;
    }
    if (!response.ok || !isRecord(body) || body.success !== true || !isRecord(body.result)) {
      throw preflightError(`${label} failed (HTTP ${response.status})`);
    }
    return body.result;
  }

  async workerDomainOwner(hostname: string): Promise<string | null> {
    const domains = await this.workerDomains();
    const matches = domains.filter((entry) => entry.hostname === hostname);
    if (matches.length > 1) {
      throw preflightError(`${hostname} has more than one Cloudflare Worker domain owner`);
    }
    return matches[0]?.service ?? null;
  }

  async workerDomains(): Promise<
    readonly { readonly hostname: string; readonly service: string }[]
  > {
    const entries = await this.list("/workers/domains", "Cloudflare Worker domain inventory");
    return entries.map((entry) => {
      if (
        !isRecord(entry) ||
        typeof entry.hostname !== "string" ||
        typeof entry.service !== "string"
      ) {
        throw preflightError("Cloudflare Worker domain inventory returned a malformed entry");
      }
      return { hostname: entry.hostname, service: entry.service };
    });
  }

  async workerDeployments(workerName: string): Promise<readonly unknown[]> {
    const label = `${workerName} deployment history`;
    const result = await this.read(
      `/workers/scripts/${encodeURIComponent(workerName)}/deployments`,
      label,
    );
    return parseDeploymentHistory(result, label);
  }

  async workerScripts(): Promise<readonly string[]> {
    const result = await this.read("/workers/scripts", "Cloudflare Worker script inventory");
    if (!Array.isArray(result)) {
      throw preflightError("Cloudflare Worker script inventory returned a non-list result");
    }
    const entries = result;
    const names = entries.map((entry) => {
      if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
        throw preflightError("Cloudflare Worker script inventory returned a malformed entry");
      }
      return entry.id;
    });
    if (new Set(names).size !== names.length) {
      throw preflightError("Cloudflare Worker script inventory contains a duplicate name");
    }
    return names.sort();
  }

  workerVersions(workerName: string): Promise<readonly unknown[]> {
    return this.list(
      `/workers/scripts/${encodeURIComponent(workerName)}/versions`,
      `${workerName} version history`,
    );
  }

  workerVersion(workerName: string, versionId: string): Promise<unknown> {
    return this.read(
      `/workers/scripts/${encodeURIComponent(workerName)}/versions/${encodeURIComponent(versionId)}`,
      `${workerName} version ${versionId}`,
    );
  }

  workerVersionWithModules(workerName: string, versionId: string): Promise<unknown> {
    return this.read(
      `/workers/workers/${encodeURIComponent(workerName)}/versions/${encodeURIComponent(versionId)}?include=modules`,
      `${workerName} version ${versionId} module closure`,
    );
  }

  async workerSecrets(workerName: string): Promise<readonly unknown[]> {
    const label = `${workerName} secret inventory`;
    const result = await this.read(
      `/workers/scripts/${encodeURIComponent(workerName)}/secrets`,
      label,
    );
    return parseSecretInventory(result, label);
  }

  workerSettings(workerName: string): Promise<unknown> {
    return this.read(
      `/workers/scripts/${encodeURIComponent(workerName)}/settings`,
      `${workerName} settings`,
    );
  }

  async workerSubdomain(workerName: string): Promise<{
    readonly enabled: boolean;
    readonly previewsEnabled: boolean;
  }> {
    const result = await this.read(
      `/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
      `${workerName} subdomain state`,
    );
    if (
      !isRecord(result) ||
      typeof result.enabled !== "boolean" ||
      typeof result.previews_enabled !== "boolean"
    ) {
      throw preflightError(`${workerName} subdomain state returned a malformed result`);
    }
    return { enabled: result.enabled, previewsEnabled: result.previews_enabled };
  }

  async workerAccountSubdomain(): Promise<string> {
    const result = await this.read("/workers/subdomain", "Cloudflare account subdomain state");
    if (!isRecord(result) || typeof result.subdomain !== "string") {
      throw preflightError("Cloudflare account subdomain state returned a malformed result");
    }
    return result.subdomain;
  }

  /** Exhaustive account-zone inventory followed by each zone's complete route list. */
  async workerRoutes(): Promise<
    readonly {
      readonly zoneId: string;
      readonly id: string;
      readonly pattern: string;
      readonly script: string | null;
    }[]
  > {
    const zonesUrl = new URL(`${API}/zones`);
    zonesUrl.searchParams.set("account.id", this.#accountId);
    const internalZonesUrl = new URL(zonesUrl);
    internalZonesUrl.searchParams.set("type", "internal");
    const zoneEntries = [
      ...(await this.#list(zonesUrl, "Cloudflare account zone inventory", 50)),
      ...(await this.#list(internalZonesUrl, "Cloudflare account internal-zone inventory", 50)),
    ];
    const zoneIds = zoneEntries.map((entry) => {
      if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
        throw preflightError("Cloudflare account zone inventory returned a malformed entry");
      }
      return entry.id;
    });
    if (new Set(zoneIds).size !== zoneIds.length) {
      throw preflightError("Cloudflare account zone inventory contains a duplicate id");
    }
    const routes = await Promise.all(
      zoneIds.sort().map(async (zoneId) => {
        const label = `Cloudflare zone ${zoneId} Worker route inventory`;
        const envelope = await this.#request(
          new URL(`${API}/zones/${encodeURIComponent(zoneId)}/workers/routes`),
          label,
        );
        if (!Array.isArray(envelope.result)) {
          throw preflightError(`${label} returned a non-list result`);
        }
        return envelope.result.map((entry) => {
          if (
            !isRecord(entry) ||
            typeof entry.id !== "string" ||
            typeof entry.pattern !== "string" ||
            (entry.script !== null && typeof entry.script !== "string")
          ) {
            throw preflightError(`${label} returned a malformed entry`);
          }
          return { zoneId, id: entry.id, pattern: entry.pattern, script: entry.script };
        });
      }),
    );
    const flattened = routes.flat();
    if (new Set(flattened.map(({ zoneId, id }) => `${zoneId}\0${id}`)).size !== flattened.length) {
      throw preflightError("Cloudflare Worker route inventory contains a duplicate id");
    }
    return flattened;
  }

  async workerTopologyAudit(): Promise<CloudflareTopologyAuditEvidence> {
    if (!this.#topologyAuditCredentialPath) {
      throw preflightError("Cloudflare topology audit credential is unavailable");
    }
    return await verifyCloudflareTopologyVisibility({
      accountId: this.#accountId,
      deploymentToken: this.#token,
      auditCredentialPath: this.#topologyAuditCredentialPath,
      get: async (url, token) => {
        const response = await this.#fetcher(
          new Request(url, {
            method: "GET",
            headers: { accept: "application/json", authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
          }),
        );
        if (!response.ok || response.redirected) {
          throw preflightError("Cloudflare topology audit API read failed");
        }
        const text = await readBoundedResponseText(
          response,
          MAX_TOPOLOGY_AUDIT_RESPONSE_BYTES,
          "Cloudflare topology audit API",
        );
        if (text.length < 1) {
          throw preflightError("Cloudflare topology audit API response is invalid");
        }
        return text;
      },
    });
  }

  pagesDeployments(project: string): Promise<readonly unknown[]> {
    return this.list(
      `/pages/projects/${encodeURIComponent(project)}/deployments`,
      `${project} Pages deployment history`,
    );
  }

  #url(path: string): URL {
    if (!path.startsWith("/") || path.includes("//")) {
      throw preflightError(`Cloudflare state path is invalid: ${JSON.stringify(path)}`);
    }
    return new URL(`${API}/accounts/${this.#accountId}${path}`);
  }

  async #request(url: URL, label: string): Promise<Envelope> {
    let response: Response;
    try {
      response = await this.#fetcher(
        new Request(url, {
          method: "GET",
          headers: { authorization: `Bearer ${this.#token}`, accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        }),
      );
    } catch (error) {
      throw preflightError(
        `${label} transport failed`,
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
    }
    const text = await readBoundedResponseText(response, MAX_PROVIDER_RESPONSE_BYTES, label);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw preflightError(`${label} returned malformed JSON (HTTP ${response.status})`);
    }
    if (!isRecord(body) || response.ok !== true || body.success !== true) {
      throw preflightError(
        `${label} failed (HTTP ${response.status})`,
        errorSummary(isRecord(body) ? body.errors : undefined),
      );
    }
    return body;
  }
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximumBytes)
  ) {
    await response.body?.cancel();
    throw preflightError(`${label} response is too large`);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw preflightError(`${label} response is too large`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw preflightError(`${label} response is not valid UTF-8`);
  }
}

function parsePagination(value: unknown, label: string): Pagination {
  if (!isRecord(value)) throw preflightError(`${label} returned no pagination metadata`);
  const page = value.page;
  const perPage = value.per_page;
  const count = value.count;
  const totalCount = value.total_count;
  if (
    !isNonNegativeSafeInteger(page) ||
    !isNonNegativeSafeInteger(perPage) ||
    !isNonNegativeSafeInteger(count) ||
    !isNonNegativeSafeInteger(totalCount)
  ) {
    throw preflightError(`${label} returned invalid pagination metadata`);
  }
  if (perPage === 0) {
    throw preflightError(`${label} returned invalid pagination metadata`);
  }
  const derivedTotalPages = Math.ceil(totalCount / perPage);
  const suppliedTotalPages = value.total_pages;
  if (suppliedTotalPages !== undefined && !isNonNegativeSafeInteger(suppliedTotalPages)) {
    throw preflightError(`${label} returned invalid pagination metadata`);
  }
  const totalPages = suppliedTotalPages ?? derivedTotalPages;
  if (totalPages !== derivedTotalPages) {
    throw preflightError(`${label} returned invalid pagination metadata`);
  }
  return { page, perPage, count, totalCount, totalPages };
}

function parseDeploymentHistory(value: unknown, label: string): readonly unknown[] {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "deployments") ||
    !Array.isArray(value.deployments)
  ) {
    throw preflightError(`${label} returned an invalid deployment history envelope`);
  }
  return value.deployments;
}

function parseSecretInventory(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw preflightError(`${label} returned an invalid secret inventory result`);
  }
  return value;
}

function errorSummary(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const summary = value.filter(isRecord).map((entry) => ({
    code: typeof entry.code === "number" ? entry.code : null,
    message: typeof entry.message === "string" ? entry.message : null,
  }));
  return summary.length === 0 ? undefined : JSON.stringify(summary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
