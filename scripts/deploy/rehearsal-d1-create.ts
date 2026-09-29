import { mutationError, preflightError, verificationError } from "./errors.ts";
import {
  CloudflareIntegrationStorageProvider,
  type IntegrationStorageD1Database,
  type IntegrationStorageFetcher,
} from "./integration-storage-generation.ts";
import { requireEnvironment } from "./process.ts";
import type { QualificationProcess } from "./qualification.ts";
import { qualifySource } from "./qualification.ts";

const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const GENERATION = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const NAME = /^takoserver-r-([0-9a-f]{32})$/u;
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
/**
 * Counts application schema objects only. Cloudflare provisions its own
 * internal `_cf_KV` table in every new D1, so a newly created database is never
 * literally empty. The platform's own readers already exclude it
 * (`application-schema-shape.ts` and `integration-worker-bootstrap.ts` both drop
 * `_cf_KV`), and it is provider-owned rather than a user object, so excluding it
 * keeps the fence honest: any application table, index, trigger or provider
 * migration ledger still refuses the create.
 */
export const EMPTY_SCHEMA_QUERY =
  "SELECT COUNT(*) AS object_count FROM sqlite_schema " +
  "WHERE name NOT LIKE 'sqlite_%' AND name <> '_cf_KV'";

export interface RehearsalD1CreateDeclaration {
  readonly kind: "takoserver.rehearsal-d1-create@v1";
  readonly environment: "rehearsal";
  readonly accountId: string;
  readonly name: string;
}

export interface RehearsalD1CreateInvocation {
  readonly action: "status" | "apply";
  readonly environment: "rehearsal";
  readonly commit: string;
}

export interface RehearsalD1CreateProvider {
  listD1(name: string): Promise<readonly IntegrationStorageD1Database[]>;
  getD1(databaseId: string): Promise<IntegrationStorageD1Database>;
  createD1(name: string): Promise<IntegrationStorageD1Database>;
  readSchemaObjectCount(databaseId: string): Promise<number>;
}

export interface RehearsalD1CreateOptions {
  readonly run?: QualificationProcess;
  readonly review?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly provider?: RehearsalD1CreateProvider;
  readonly fetcher?: IntegrationStorageFetcher;
}

/**
 * Create one new rehearsal D1 only. This function does not load or rewrite a
 * deploy target and deliberately exposes no delete, import, or binding API.
 */
export async function runRehearsalD1Create(
  declaration: RehearsalD1CreateDeclaration,
  invocation: RehearsalD1CreateInvocation,
  options: RehearsalD1CreateOptions = {},
): Promise<Record<string, unknown>> {
  validateDeclaration(declaration);
  if (invocation.environment !== "rehearsal") {
    throw preflightError("rehearsal D1 creation accepts only the rehearsal environment");
  }
  if (!COMMIT.test(invocation.commit)) {
    throw preflightError("--commit must be one exact lowercase 40-hex commit");
  }

  const provider = options.provider ?? createCloudflareProvider(declaration, options);
  let inventory: readonly IntegrationStorageD1Database[];
  try {
    inventory = await provider.listD1(declaration.name);
  } catch {
    throw preflightError("rehearsal D1 name absence could not be authoritatively proved");
  }
  if (invocation.action === "status") {
    if (inventory.length === 0) {
      return {
        kind: "takoserver.rehearsal-d1-create-status@v1",
        surface: "takoserver-rehearsal-d1-create",
        environment: "rehearsal",
        selectedCommit: invocation.commit,
        databaseName: declaration.name,
        present: false,
        readyForApply: true,
      };
    }
    if (inventory.length !== 1 || inventory[0]?.name !== declaration.name) {
      throw preflightError("rehearsal D1 name inventory was not an exact absence/presence result");
    }
    const existing = inventory[0];
    if (!UUID.test(existing.uuid)) {
      throw preflightError("existing rehearsal D1 inventory returned a malformed UUID");
    }
    return {
      kind: "takoserver.rehearsal-d1-create-status@v1",
      surface: "takoserver-rehearsal-d1-create",
      environment: "rehearsal",
      selectedCommit: invocation.commit,
      databaseName: declaration.name,
      databaseId: existing.uuid,
      present: true,
      readyForApply: false,
      note: "pre-existing D1 is never adopted or reset by this surface",
    };
  }

  if (invocation.action !== "apply") {
    throw preflightError("rehearsal D1 creation requires status or apply");
  }
  if (inventory.length !== 0) {
    throw preflightError("rehearsal D1 already exists; this surface never adopts or resets it");
  }
  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  const source = await qualifySource({
    environment: "rehearsal",
    commit: invocation.commit,
    policy: "clean-remote",
    ...(options.run === undefined ? {} : { run: options.run }),
  });

  // Fence immediately before the sole create. Any uncertain provider result is
  // reported as indeterminate; callers must inspect status and never retry.
  let fencedInventory: readonly IntegrationStorageD1Database[];
  try {
    fencedInventory = await provider.listD1(declaration.name);
  } catch {
    throw preflightError("immediate rehearsal D1 absence fence failed; no create was attempted");
  }
  if (fencedInventory.length !== 0) {
    throw preflightError("rehearsal D1 appeared before create; refusing to adopt it");
  }

  let created: IntegrationStorageD1Database;
  try {
    created = await provider.createD1(declaration.name);
  } catch {
    throw mutationError(
      "rehearsal D1 create acknowledgement is indeterminate; inspect exact name with --status and do not retry",
    );
  }

  if (created.name !== declaration.name || !UUID.test(created.uuid)) {
    throw mutationError("rehearsal D1 create returned an unexpected identity; do not retry");
  }

  let identity: IntegrationStorageD1Database;
  let schemaObjectCount: number;
  try {
    identity = await provider.getD1(created.uuid);
    if (identity.uuid !== created.uuid || identity.name !== declaration.name) {
      throw new Error("identity mismatch");
    }
    schemaObjectCount = await provider.readSchemaObjectCount(created.uuid);
  } catch {
    throw verificationError(
      "rehearsal D1 was created but exact identity or empty-schema readback failed; inspect and repair forward",
      `databaseId=${created.uuid}`,
    );
  }
  if (!Number.isSafeInteger(schemaObjectCount) || schemaObjectCount !== 0) {
    throw verificationError(
      "rehearsal D1 was created but its schema is not empty; do not retry or reset",
      `databaseId=${created.uuid} schemaObjectCount=${schemaObjectCount}`,
    );
  }

  return {
    kind: "takoserver.rehearsal-d1-create-apply@v1",
    surface: "takoserver-rehearsal-d1-create",
    environment: "rehearsal",
    commit: source.commit,
    reviewer,
    databaseName: declaration.name,
    databaseId: identity.uuid,
    schemaObjectCount,
    rollback: "leave the rehearsal D1 intact and repair forward; this surface never deletes it",
  };
}

function validateDeclaration(value: RehearsalD1CreateDeclaration): void {
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !== "accountId,environment,kind,name" ||
    value.kind !== "takoserver.rehearsal-d1-create@v1" ||
    value.environment !== "rehearsal" ||
    !ACCOUNT_ID.test(value.accountId)
  ) {
    throw preflightError("D1 declaration must be owned by takoserver and select rehearsal only");
  }
  const match = NAME.exec(value.name);
  if (!match || !GENERATION.test(match[1] ?? "")) {
    throw preflightError("D1 declaration name must be takoserver-r-<32 lowercase hex generation>");
  }
}

function createCloudflareProvider(
  declaration: RehearsalD1CreateDeclaration,
  options: RehearsalD1CreateOptions,
): RehearsalD1CreateProvider {
  const token =
    options.cloudflareEnvironment === undefined
      ? process.env.CLOUDFLARE_API_TOKEN
      : options.cloudflareEnvironment.CLOUDFLARE_API_TOKEN;
  if (token === undefined || token.length === 0 || token.trim() !== token) {
    throw preflightError("rehearsal D1 creation requires an explicit CLOUDFLARE_API_TOKEN");
  }
  const identityProvider = new CloudflareIntegrationStorageProvider(declaration.accountId, token, {
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  });
  const fetcher = options.fetcher ?? ((request: Request) => fetch(request));
  return {
    listD1: (name) => identityProvider.listD1(name),
    getD1: (databaseId) => identityProvider.getD1(databaseId),
    createD1: (name) => identityProvider.createD1(name),
    readSchemaObjectCount: (databaseId) =>
      readSchemaObjectCount(fetcher, declaration.accountId, token, databaseId),
  };
}

async function readSchemaObjectCount(
  fetcher: IntegrationStorageFetcher,
  accountId: string,
  token: string,
  databaseId: string,
): Promise<number> {
  if (!UUID.test(databaseId)) throw new Error("D1 identity is invalid");
  let response: Response;
  try {
    response = await fetcher(
      new Request(
        `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ sql: EMPTY_SCHEMA_QUERY }),
          signal: AbortSignal.timeout(15_000),
        },
      ),
    );
  } catch {
    throw new Error("D1 schema query transport failed");
  }
  const text = await boundedResponseText(response);
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error("D1 schema query returned malformed JSON");
  }
  if (
    !response.ok ||
    !isRecord(envelope) ||
    envelope.success !== true ||
    !Array.isArray(envelope.result) ||
    envelope.result.length !== 1
  ) {
    throw new Error("D1 schema query failed");
  }
  const block = envelope.result[0];
  if (
    !isRecord(block) ||
    block.success !== true ||
    !Array.isArray(block.results) ||
    block.results.length !== 1
  ) {
    throw new Error("D1 schema query returned a malformed result");
  }
  const row = block.results[0];
  if (!isRecord(row) || !Number.isSafeInteger(row.object_count) || Number(row.object_count) < 0) {
    throw new Error("D1 schema query returned an invalid object count");
  }
  return Number(row.object_count);
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new Error("Cloudflare response exceeded the safety bound");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Cloudflare response exceeded the safety bound");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactReviewer(value: string): string {
  const reviewer = value.trim();
  if (reviewer.length < 1 || reviewer.length > 240 || reviewer.includes("\n")) {
    throw preflightError("independent review reference must be one exact non-empty line");
  }
  return reviewer;
}
