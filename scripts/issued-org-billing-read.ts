import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const ORG = /^org_[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$/u;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const KEY = /^key_[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const MAX_RECEIPT = 16_384;
const MAX_SECRET = 4_096;
const MAX_RESPONSE = 1_048_576;
const REFUSAL = "issued organization billing read unavailable";

export interface IssuedOrganizationBillingReadSelection {
  readonly serverOrigin: string;
  readonly environment: "integration" | "rehearsal" | "production";
  readonly organizationId: string;
  readonly keyName: string;
  readonly sourceCommit: string;
  readonly mintReceiptPath: string;
  readonly secretDirectory: string;
}

export interface IssuedOrganizationBillingReadOptions {
  readonly fetcher?: (input: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function deny(): never {
  throw new Error(REFUSAL);
}

function exactPath(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes(`${sep}.${sep}`)) deny();
  return path;
}

function safeParents(path: string): void {
  const uid = process.getuid?.();
  let cursor = dirname(path);
  const parts: string[] = [];
  while (cursor !== dirname(cursor)) {
    parts.push(cursor);
    cursor = dirname(cursor);
  }
  for (const part of parts.reverse()) {
    const stat = lstatSync(part);
    if (!stat.isDirectory() || stat.isSymbolicLink()) deny();
    if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) deny();
  }
  const parent = lstatSync(dirname(path));
  if ((parent.mode & 0o7777) !== 0o700 || (uid !== undefined && parent.uid !== uid)) deny();
}

function protectedRead(path: string, limit: number): { text: string; identity: FileIdentity } {
  safeParents(path);
  const before = lstatSync(path);
  const uid = process.getuid?.();
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o7777) !== 0o600 ||
    (uid !== undefined && before.uid !== uid) ||
    before.size < 1 ||
    before.size > limit
  )
    deny();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.nlink !== 1 ||
      (stat.mode & 0o7777) !== 0o600 ||
      (uid !== undefined && stat.uid !== uid) ||
      stat.size !== before.size ||
      stat.mtimeMs !== before.mtimeMs ||
      stat.ctimeMs !== before.ctimeMs
    )
      deny();
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) deny();
      offset += count;
    }
    const after = fstatSync(fd);
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      deny();
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) deny();
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      identity: {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      },
    };
  } finally {
    closeSync(fd);
  }
}

function same(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectedOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) deny();
  return value;
}

function canonicalInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

/** Node operator-side adapter. Never mount this file custody into a Worker. */
export function createIssuedOrganizationBillingReadSupplier(
  selection: IssuedOrganizationBillingReadSelection,
  options: IssuedOrganizationBillingReadOptions = {},
): {
  apiKeyFor(organizationId: string): Promise<string>;
  readFacts(): Promise<{ usageSummary: unknown; subscription: unknown }>;
} {
  try {
    const origin = selectedOrigin(selection.serverOrigin);
    const organizationId = selection.organizationId;
    const keyName = selection.keyName;
    const sourceCommit = selection.sourceCommit;
    const environment = selection.environment;
    if (
      !ORG.test(organizationId) ||
      !NAME.test(keyName) ||
      !COMMIT.test(sourceCommit) ||
      !["integration", "rehearsal", "production"].includes(environment)
    )
      deny();
    const receiptPath = exactPath(selection.mintReceiptPath);
    const secretDirectory = exactPath(selection.secretDirectory);
    const secretPath = join(secretDirectory, `${organizationId}.${keyName}.secret`);
    const receiptFile = protectedRead(receiptPath, MAX_RECEIPT);
    const receipt: unknown = JSON.parse(receiptFile.text);
    if (
      !record(receipt) ||
      receipt.kind !== "takoserver.org-api-key-mint@v1" ||
      receipt.surface !== "takoserver-org-api-key" ||
      receipt.action !== "mint" ||
      receipt.environment !== environment ||
      receipt.commit !== sourceCommit ||
      receipt.organizationId !== organizationId ||
      receipt.keyName !== keyName ||
      !KEY.test(String(receipt.apiKeyId)) ||
      receipt.secretPath !== secretPath ||
      receipt.secretsRedacted !== true ||
      receipt.mutationApplied !== true ||
      !Array.isArray(receipt.scopes) ||
      receipt.scopes.length !== 1 ||
      receipt.scopes[0] !== "wallet:read" ||
      !canonicalInstant(receipt.createdAt) ||
      !canonicalInstant(receipt.expiresAt) ||
      Date.parse(receipt.expiresAt) <= Date.parse(receipt.createdAt)
    )
      deny();
    if (
      !record(receipt.probe) ||
      receipt.probe.url !== `${origin}/.well-known/takoserver` ||
      receipt.probe.status !== 200 ||
      !record(receipt.probe.openapi) ||
      receipt.probe.openapi.url !== `${origin}/openapi.json` ||
      receipt.probe.openapi.status !== 200
    )
      deny();
    const secretFile = protectedRead(secretPath, MAX_SECRET);
    if (!/^[\x21-\x7e]{1,4096}$/u.test(secretFile.text)) deny();
    const now = options.now ?? (() => new Date());
    const initialTime = now().getTime();
    if (!Number.isFinite(initialTime) || Date.parse(receipt.expiresAt) <= initialTime) deny();
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) deny();
    const validate = (): string => {
      const current = now().getTime();
      if (!Number.isFinite(current) || Date.parse(receipt.expiresAt as string) <= current) deny();
      const freshReceipt = protectedRead(receiptPath, MAX_RECEIPT);
      const freshSecret = protectedRead(secretPath, MAX_SECRET);
      if (
        !same(freshReceipt.identity, receiptFile.identity) ||
        freshReceipt.text !== receiptFile.text ||
        !same(freshSecret.identity, secretFile.identity) ||
        freshSecret.text !== secretFile.text
      )
        deny();
      return freshSecret.text;
    };
    const fetcher = options.fetcher ?? ((input: string, init: RequestInit) => fetch(input, init));
    const read = async (suffix: string): Promise<unknown> => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(REFUSAL));
        }, timeoutMs);
      });
      const work = async (): Promise<unknown> => {
        const key = validate();
        const response = await fetcher(`${origin}/v1/organizations/${organizationId}/${suffix}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
          redirect: "manual",
          signal: controller.signal,
        });
        if (
          response.status !== 200 ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        )
          deny();
        const reader = response.body?.getReader();
        if (!reader) deny();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_RESPONSE) deny();
            chunks.push(value);
          }
        } finally {
          void reader.cancel().catch(() => undefined);
        }
        const body: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
        );
        if (!record(body)) deny();
        if (suffix === "wallet/usage-summary") {
          if (!record(body.usageSummary) || body.usageSummary.organizationId !== organizationId)
            deny();
        } else if (
          !Object.hasOwn(body, "subscription") ||
          (body.subscription !== null &&
            (!record(body.subscription) || body.subscription.organizationId !== organizationId))
        )
          deny();
        validate();
        return body;
      };
      try {
        return await Promise.race([work(), deadline]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
      }
    };
    return {
      async apiKeyFor(requestedOrganizationId: string) {
        try {
          if (requestedOrganizationId !== organizationId) deny();
          return validate();
        } catch {
          return deny();
        }
      },
      async readFacts() {
        try {
          const usage = await read("wallet/usage-summary");
          const subscription = await read("payments/subscription");
          return { usageSummary: usage, subscription };
        } catch {
          return deny();
        }
      },
    };
  } catch {
    return deny();
  }
}
