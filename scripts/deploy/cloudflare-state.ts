import { preflightError } from "./errors.ts";

const API = "https://api.cloudflare.com/client/v4";
const PAGE_SIZE = 100;
const MAX_PAGES = 10_000;

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
 * Read-only Cloudflare adapter with one small interface: exhaustive lists and
 * singular state. Every list proves its pagination closure before a caller may
 * make an ownership or rollback decision from it.
 */
export class CloudflareState {
  readonly #accountId: string;
  readonly #token: string;
  readonly #fetcher: StateFetcher;

  constructor(input: {
    readonly accountId: string;
    readonly token: string;
    readonly fetcher?: StateFetcher;
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
  }

  async list(path: string, label: string): Promise<readonly unknown[]> {
    const collected: unknown[] = [];
    let expectedTotal: number | null = null;
    let totalPages: number | null = null;
    for (let page = 1; page <= (totalPages ?? 1); page += 1) {
      if (page > MAX_PAGES) throw preflightError(`${label} exceeded the pagination safety bound`);
      const url = this.#url(path);
      url.searchParams.set("page", String(page));
      url.searchParams.set("per_page", String(PAGE_SIZE));
      const envelope = await this.#request(url, label);
      if (!Array.isArray(envelope.result)) {
        throw preflightError(`${label} returned a non-list result`);
      }
      const pagination = parsePagination(envelope.result_info, label);
      if (pagination.page !== page || pagination.perPage !== PAGE_SIZE) {
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

  workerDeployments(workerName: string): Promise<readonly unknown[]> {
    return this.list(
      `/workers/scripts/${encodeURIComponent(workerName)}/deployments`,
      `${workerName} deployment history`,
    );
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

  workerSecrets(workerName: string): Promise<readonly unknown[]> {
    return this.list(
      `/workers/scripts/${encodeURIComponent(workerName)}/secrets`,
      `${workerName} secret inventory`,
    );
  }

  workerSettings(workerName: string): Promise<unknown> {
    return this.read(
      `/workers/scripts/${encodeURIComponent(workerName)}/settings`,
      `${workerName} settings`,
    );
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
    let body: unknown;
    try {
      body = await response.json();
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

function parsePagination(value: unknown, label: string): Pagination {
  if (!isRecord(value)) throw preflightError(`${label} returned no pagination metadata`);
  const coordinates = {
    page: value.page,
    perPage: value.per_page,
    count: value.count,
    totalCount: value.total_count,
    totalPages: value.total_pages,
  };
  if (
    Object.values(coordinates).some((entry) => !Number.isSafeInteger(entry) || Number(entry) < 0)
  ) {
    throw preflightError(`${label} returned invalid pagination metadata`);
  }
  return coordinates as Pagination;
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
