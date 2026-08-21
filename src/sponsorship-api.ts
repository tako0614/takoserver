import type { ResourceInventory } from "./control.ts";
import type { Ledger } from "./ledger.ts";
import type { Clock, Sql } from "./ports.ts";
import type { TakoformHost } from "./takoform/types.ts";
import type { TokenService } from "./token.ts";

/** Private product-to-product sponsorship seam. No browser or customer key uses it. */
export interface CreateSponsorshipRoutesOptions {
  readonly sql: Sql;
  readonly ledger: Ledger;
  readonly inventory: ResourceInventory;
  readonly lifecycle: TakoformHost;
  readonly tokens: TokenService;
  readonly serviceToken: string;
  readonly publicOrigin: string;
  readonly clock: Clock;
}

export type SponsorshipRoutes = (request: Request, url: URL) => Promise<Response | null>;

export function createSponsorshipRoutes(
  options: CreateSponsorshipRoutesOptions,
): SponsorshipRoutes {
  const prefix = "/v1/sponsorship/tenants/";
  return async (request, url) => {
    if (!url.pathname.startsWith(prefix)) return null;
    if (request.headers.get("authorization") !== `Bearer ${options.serviceToken}`) {
      return failure("not_found", 404);
    }
    try {
      const rest = url.pathname.slice(prefix.length).split("/").map(segment);
      const tenantRef = rest[0];
      if (!tenantRef) return failure("not_found", 404);

      if (request.method === "POST" && rest.length === 1) {
        const body = await jsonObject(request, ["organizationId"]);
        const organizationId = text(body.organizationId, 128);
        const organizations = await options.sql.query("SELECT id FROM orgs WHERE id = ? LIMIT 1", [
          organizationId,
        ]);
        if (organizations.length !== 1) return failure("organization_not_found", 404);
        await options.sql.run(
          `INSERT INTO sponsorship_tenants (tenant_ref, org_id, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT(tenant_ref) DO UPDATE SET org_id = excluded.org_id
           WHERE sponsorship_tenants.org_id = excluded.org_id`,
          [tenantRef, organizationId, options.clock().toISOString()],
        );
        const bound = await tenant(options.sql, tenantRef);
        if (bound !== organizationId) return failure("tenant_conflict", 409);
        return Response.json({ tenantRef, organizationId }, { status: 201 });
      }

      const organizationId = await tenant(options.sql, tenantRef);
      if (!organizationId) return failure("tenant_not_found", 404);

      if (request.method === "GET" && rest.length === 2 && rest[1] === "wallet") {
        const wallet = await options.ledger.wallet(organizationId);
        return Response.json({
          availableMinor: wallet.availableMinor,
          currency: wallet.currency,
        });
      }

      if (
        request.method === "POST" &&
        rest.length === 2 &&
        rest[1] === "takoform-run-credentials"
      ) {
        const body = await jsonObject(request, ["runRef", "expiresInSeconds"]);
        const issued = await options.tokens.issueTakoformTenantRunToken({
          organizationId,
          tenantRef,
          runRef: text(body.runRef, 256),
          ttlSeconds: boundedTtl(body.expiresInSeconds),
        });
        return Response.json({ takoformRunCredential: issued }, { status: 201 });
      }

      if (request.method === "GET" && rest.length === 2 && rest[1] === "inventory") {
        exactQuery(url, ["limit"], ["cursor"]);
        const limit = pageLimit(url.searchParams.get("limit"));
        const after = inventoryCursor(url.searchParams.get("cursor"));
        const rows = await options.sql.query(
          `SELECT resource_uid FROM sponsorship_resources
           WHERE tenant_ref = ? AND resource_uid > ?
           ORDER BY resource_uid
           LIMIT ?`,
          [tenantRef, after, limit + 1],
        );
        const page = rows.slice(0, limit);
        const resources = await Promise.all(
          page.map((row) =>
            options.inventory.resourceByUid(organizationId, text(row.resource_uid, 256)),
          ),
        );
        const items = resources.flatMap((resource) =>
          resource === null
            ? []
            : [
                {
                  apiVersion: resource.apiVersion,
                  kind: resource.kind,
                  name: resource.name,
                  formRef: {
                    apiVersion: resource.resource.form.formRef.apiVersion,
                    kind: resource.resource.form.formRef.kind,
                    definitionVersion: resource.resource.form.formRef.definitionVersion,
                    schemaDigest: resource.resource.form.formRef.schemaDigest,
                  },
                  uid: resource.uid,
                  generation: resource.generation,
                  revision: resource.revision,
                  conditions: resource.resource.status.conditions.map(
                    ({ type, status, reason, lastTransitionTime }) => ({
                      type,
                      status,
                      reason,
                      lastTransitionTime,
                    }),
                  ),
                },
              ],
        );
        const last = page.at(-1);
        return Response.json({
          items,
          ...(rows.length > limit && last
            ? { nextCursor: encodeInventoryCursor(text(last.resource_uid, 256)) }
            : {}),
        });
      }

      if (request.method === "POST" && rest.length === 2 && rest[1] === "funding") {
        const body = await jsonObject(request, [
          "tenantRef",
          "amountMinor",
          "currency",
          "kind",
          "reference",
          "expiresAt",
        ]);
        if (text(body.tenantRef, 256) !== tenantRef || body.currency !== "USD") {
          return failure("invalid", 400);
        }
        const kind = body.kind;
        if (kind !== "plan-included" && kind !== "purchased") {
          return failure("invalid", 400);
        }
        const expiresAt = nullableInstant(body.expiresAt);
        if (
          (kind === "plan-included" && expiresAt === null) ||
          (kind === "purchased" && expiresAt !== null)
        ) {
          return failure("invalid", 400);
        }
        await options.ledger.fund({
          organizationId,
          fundingRef: text(body.reference, 256),
          amountMinor: positiveInteger(body.amountMinor),
          kind,
          expiresAt,
        });
        return Response.json({ fundingId: body.reference }, { status: 201 });
      }

      if (rest.length >= 2 && rest[1] === "resources") {
        if (request.method === "GET" && rest.length === 2) {
          const rows = await options.sql.query(
            `SELECT resource_uid FROM sponsorship_resources
             WHERE tenant_ref = ? AND billing_mode = 'sponsored'
             ORDER BY resource_uid`,
            [tenantRef],
          );
          return Response.json({
            resources: rows.map((row) => ({
              resourceId: String(row.resource_uid),
            })),
          });
        }
        const resourceUid = rest[2];
        if (!resourceUid || rest.length !== 3) return failure("not_found", 404);
        if (request.method === "PUT") {
          const body = await jsonObject(request, ["billingMode"]);
          if (body.billingMode !== "sponsored" && body.billingMode !== "direct") {
            return failure("invalid", 400);
          }
          if (!(await options.inventory.resourceByUid(organizationId, resourceUid))) {
            return failure("resource_not_found", 404);
          }
          await options.sql.run(
            `INSERT INTO sponsorship_resources
               (tenant_ref, resource_uid, billing_mode, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(tenant_ref, resource_uid) DO UPDATE
               SET billing_mode = excluded.billing_mode, updated_at = excluded.updated_at`,
            [tenantRef, resourceUid, body.billingMode, options.clock().toISOString()],
          );
          return Response.json({
            resourceId: resourceUid,
            billingMode: body.billingMode,
          });
        }
        if (request.method === "DELETE") {
          const ownership = await options.sql.query(
            `SELECT billing_mode FROM sponsorship_resources
             WHERE tenant_ref = ? AND resource_uid = ? LIMIT 1`,
            [tenantRef, resourceUid],
          );
          if (ownership[0]?.billing_mode !== "sponsored") {
            return failure("resource_not_found", 404);
          }
          const resource = await options.inventory.resourceByUid(organizationId, resourceUid);
          if (!resource) {
            await options.sql.run(
              "DELETE FROM sponsorship_resources WHERE tenant_ref = ? AND resource_uid = ?",
              [tenantRef, resourceUid],
            );
            return new Response(null, { status: 204 });
          }
          const ref = resource.resource.form.formRef;
          const [group, version, extra] = ref.apiVersion.split("/");
          if (!group || !version || extra !== undefined) return failure("delete_failed", 409);
          const target = new URL(
            `/apis/forms.takoform.com/v1alpha3/resources/${encodeURIComponent(group)}/${encodeURIComponent(version)}/${encodeURIComponent(ref.kind)}/${encodeURIComponent(resource.name)}`,
            options.publicOrigin,
          );
          target.searchParams.set("space", resource.space);
          target.searchParams.set("group", ref.apiVersion);
          target.searchParams.set("kind", ref.kind);
          target.searchParams.set("definitionVersion", ref.definitionVersion);
          target.searchParams.set("schemaDigest", ref.schemaDigest);
          const deleted = await options.lifecycle.handle(
            new Request(target, {
              method: "DELETE",
              headers: {
                authorization: "Bearer internal-sponsorship-lifecycle",
                "idempotency-key": `sponsorship-delete:${tenantRef}:${resourceUid}`,
                "if-match": `"${resource.revision}"`,
                "takoform-expected-generation": resource.generation,
                "x-takoserver-sponsorship-organization": organizationId,
                "x-takoserver-sponsorship-resource": resourceUid,
              },
            }),
          );
          if (!deleted || deleted.status !== 204) return deleted ?? failure("delete_failed", 409);
          await options.sql.run(
            "DELETE FROM sponsorship_resources WHERE tenant_ref = ? AND resource_uid = ?",
            [tenantRef, resourceUid],
          );
          return deleted;
        }
      }
      return failure("not_found", 404);
    } catch {
      return failure("invalid", 400);
    }
  };
}

function boundedTtl(value: unknown): number {
  const ttl = positiveInteger(value);
  if (ttl > 600) throw new Error();
  return ttl;
}

function pageLimit(value: string | null): number {
  if (value === null || !/^[1-9][0-9]{0,2}$/u.test(value)) throw new Error();
  const parsed = Number(value);
  if (parsed > 100) throw new Error();
  return parsed;
}

function inventoryCursor(value: string | null): string {
  if (value === null) return "";
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const decoded = atob(padded);
  if (decoded.length === 0 || encodeInventoryCursor(decoded) !== value) throw new Error();
  return text(decoded, 256);
}

function encodeInventoryCursor(resourceUid: string): string {
  return btoa(resourceUid).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function exactQuery(url: URL, required: readonly string[], optional: readonly string[]): void {
  const keys = [...url.searchParams.keys()];
  const allowed = new Set([...required, ...optional]);
  if (
    keys.some((key) => !allowed.has(key)) ||
    required.some((key) => url.searchParams.getAll(key).length !== 1) ||
    optional.some((key) => url.searchParams.getAll(key).length > 1)
  ) {
    throw new Error();
  }
}

async function tenant(sql: Sql, tenantRef: string): Promise<string | null> {
  const rows = await sql.query(
    "SELECT org_id FROM sponsorship_tenants WHERE tenant_ref = ? LIMIT 2",
    [tenantRef],
  );
  return rows.length === 1 ? String(rows[0]?.org_id) : null;
}

async function jsonObject(
  request: Request,
  keys: readonly string[],
): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error();
  const value: unknown = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error();
  return object;
}

function segment(value: string): string {
  const decoded = decodeURIComponent(value);
  if (!decoded || decoded.length > 256 || decoded.trim() !== decoded || decoded.includes("/")) {
    throw new Error();
  }
  return decoded;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || value.trim() !== value) {
    throw new Error();
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error();
  return value as number;
}

function nullableInstant(value: unknown): string | null {
  if (value === null) return null;
  const string = text(value, 64);
  const parsed = new Date(string);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== string) throw new Error();
  return string;
}

function failure(code: string, status: number): Response {
  return Response.json({ error: { code } }, { status });
}
