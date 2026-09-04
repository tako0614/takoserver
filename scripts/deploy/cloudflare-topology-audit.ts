import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { preflightError } from "./errors.ts";

const API = "https://api.cloudflare.com/client/v4";
const HEX_ID = /^[0-9a-f]{32}$/u;

export interface CloudflareTopologyAuditEvidence {
  readonly deploymentTokenIdSha256: `sha256:${string}`;
  readonly deploymentTokenPolicySha256: `sha256:${string}`;
  readonly allZoneResourceSha256: `sha256:${string}`;
}

export async function verifyCloudflareTopologyVisibility(input: {
  readonly accountId: string;
  readonly deploymentToken: string;
  readonly auditCredentialPath: string;
  readonly get: (url: string, token: string) => Promise<string>;
}): Promise<CloudflareTopologyAuditEvidence> {
  if (!HEX_ID.test(input.accountId) || !validToken(input.deploymentToken)) fail("input invalid");
  const audit = readAudit(input.auditCredentialPath);
  if (audit.token === input.deploymentToken) fail("audit credential must be separate");
  const ownerBase =
    audit.deploymentTokenOwner === "user"
      ? `${API}/user/tokens`
      : `${API}/accounts/${encodeURIComponent(input.accountId)}/tokens`;
  tokenIdentity(await input.get(`${ownerBase}/verify`, audit.token), "audit credential invalid");
  const deployment = tokenIdentity(
    await input.get(`${ownerBase}/verify`, input.deploymentToken),
    "deployment token invalid",
  );
  const details = tokenDetails(
    await input.get(`${ownerBase}/${encodeURIComponent(deployment.id)}`, audit.token),
    deployment.id,
  );
  const groups = permissionGroups(await input.get(`${ownerBase}/permission_groups`, audit.token));
  const resource = `com.cloudflare.api.account.${input.accountId}`;
  const nested = { "com.cloudflare.api.account.zone.*": "*" };
  const required = new Set([groups.zoneRead, groups.workersRoutesRead]);
  const granted = new Set<string>();
  for (const value of details.policies) {
    const policy = record(value, "token policy invalid");
    if (policy.effect === "deny") fail("token policy contains deny authority");
    if (policy.effect !== "allow") {
      fail("token policy invalid");
    }
    const resources = record(policy.resources, "token policy invalid");
    if (!Array.isArray(policy.permission_groups)) fail("token policy invalid");
    const exactResource = canonicalJson(resources[resource]) === canonicalJson(nested);
    for (const groupValue of policy.permission_groups) {
      const group = record(groupValue, "token policy invalid");
      if (typeof group.id !== "string" || !HEX_ID.test(group.id)) fail("token policy invalid");
      if (group.id === groups.workersRoutesWrite) {
        fail("token unexpectedly grants Workers Routes Write");
      }
      if (exactResource && required.has(group.id)) granted.add(group.id);
    }
  }
  if ([...required].some((id) => !granted.has(id))) fail("token lacks exact all-zone visibility");
  return {
    deploymentTokenIdSha256: digest(deployment.id),
    deploymentTokenPolicySha256: digest(canonicalJson(details.policies)),
    allZoneResourceSha256: digest(canonicalJson({ [resource]: nested })),
  };
}

function readAudit(path: string): {
  readonly deploymentTokenOwner: "user" | "account";
  readonly token: string;
} {
  const stat = (() => {
    try {
      return lstatSync(path);
    } catch {
      return fail("audit credential unavailable");
    }
  })();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !path.startsWith("/") ||
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (stat.mode & 0o777) !== 0o600 ||
    (uid !== undefined && stat.uid !== uid) ||
    stat.size < 1 ||
    stat.size > 8_192
  )
    fail("audit credential must be one owned 0600 regular file");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("audit credential invalid");
  }
  const item = record(value, "audit credential invalid");
  if (
    JSON.stringify(Object.keys(item).sort()) !==
      JSON.stringify(["deploymentTokenOwner", "kind", "token"]) ||
    item.kind !== "takoserver.cloudflare-topology-audit-credential@v1" ||
    (item.deploymentTokenOwner !== "user" && item.deploymentTokenOwner !== "account") ||
    !validToken(item.token)
  )
    fail("audit credential invalid");
  return item as unknown as {
    readonly deploymentTokenOwner: "user" | "account";
    readonly token: string;
  };
}

function tokenIdentity(raw: string, label: string): { readonly id: string } {
  const value = record(envelope(raw, label), label);
  if (typeof value.id !== "string" || !HEX_ID.test(value.id) || value.status !== "active")
    fail(label);
  return { id: value.id };
}

function tokenDetails(raw: string, id: string): { readonly policies: readonly unknown[] } {
  const value = record(envelope(raw, "token details invalid"), "token details invalid");
  if (
    value.id !== id ||
    value.status !== "active" ||
    !Array.isArray(value.policies) ||
    value.policies.length === 0
  ) {
    fail("token details invalid");
  }
  return { policies: value.policies };
}

function permissionGroups(raw: string): {
  readonly zoneRead: string;
  readonly workersRoutesRead: string;
  readonly workersRoutesWrite: string;
} {
  const values = envelope(raw, "permission groups invalid");
  if (!Array.isArray(values)) fail("permission groups invalid");
  const found = new Map<string, string>();
  for (const rawGroup of values) {
    const group = record(rawGroup, "permission groups invalid");
    if (
      typeof group.id !== "string" ||
      !HEX_ID.test(group.id) ||
      typeof group.name !== "string" ||
      !Array.isArray(group.scopes) ||
      !group.scopes.includes("com.cloudflare.api.account.zone")
    )
      continue;
    if (
      group.name === "Zone Read" ||
      group.name === "Workers Routes Read" ||
      group.name === "Workers Routes Write"
    ) {
      if (found.has(group.name)) fail("permission groups invalid");
      found.set(group.name, group.id);
    }
  }
  const zoneRead = found.get("Zone Read");
  const workersRoutesRead = found.get("Workers Routes Read");
  const workersRoutesWrite = found.get("Workers Routes Write");
  if (!zoneRead || !workersRoutesRead || !workersRoutesWrite) fail("permission groups invalid");
  return { zoneRead, workersRoutesRead, workersRoutesWrite };
}

function envelope(raw: string, label: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(label);
  }
  const item = record(value, label);
  if (item.success !== true || !("result" in item)) fail(label);
  return item.result;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(label);
  return value as Record<string, unknown>;
}

function validToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 16 &&
    value.length <= 4_096 &&
    value.trim() === value
  );
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`)
    .join(",")}}`;
}

function fail(label: string): never {
  throw preflightError(`Cloudflare topology ${label}`);
}
