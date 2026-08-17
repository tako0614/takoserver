import { objectStorageBodyDigest, objectStorageIntent } from "../../src/object-storage.ts";
import { createExecutionGrantSigner, executionIntentDigest } from "../../src/runtime-grants.ts";
import { RemoteD1, sqlLiteral } from "./d1.ts";
import { verificationError } from "./errors.ts";
import { loadSigningKey } from "./mutate.ts";
import type { PreflightReport } from "./preflight.ts";
import { RUNTIME_TABLES } from "./preflight.ts";
import { assertBindingClosure } from "./worker-state.ts";

const RUNTIME_AUDIENCE = "takoserver.runtime.v1";
const PROBE_ORGANIZATION = "org-deploy-probe";
const PROBE_SECURITY_DOMAIN = "domain-deploy-probe";
const PROBE_TENANT = "tenant-deploy-probe";
const PROBE_OFFERING = "storage.object.standard";
const PROBE_ALLOWANCES = '[{"protocol":"s3","mode":"direct","authority":"resource_scoped_grant"}]';
const PROBE_KEY = "deploy-probe.txt";
const PROBE_CONTENT_TYPE = "text/plain";

/**
 * Proves the published bytes serve a real caller. Every assertion below runs
 * against the published origin, not against a local build.
 */
export async function verify(
  report: PreflightReport,
  versionId: string,
): Promise<readonly string[]> {
  const proven: string[] = [];

  await assertBindingClosure("verification", report.configPath, versionId, {
    STATE_DB: [report.target.d1.databaseId],
    OBJECTS: [report.target.r2.bucketName],
  });
  proven.push(`binding closure of version ${versionId}`);

  const database = new RemoteD1(report.configPath);
  const tables = await database.column(
    "verification",
    "runtime table readback",
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (" +
      `${RUNTIME_TABLES.map((name) => sqlLiteral(name)).join(", ")}) ORDER BY name`,
    "name",
  );
  if (JSON.stringify(tables) !== JSON.stringify([...RUNTIME_TABLES].sort())) {
    throw verificationError(
      `the target is missing runtime tables: found ${JSON.stringify(tables)}`,
    );
  }
  proven.push("all three runtime tables present");

  const activeKeys = await database.column(
    "verification",
    "active key readback",
    "SELECT key_id FROM runtime_grant_keys WHERE revoked_at_epoch_seconds IS NULL " +
      "ORDER BY key_id LIMIT 32",
    "key_id",
  );
  if (!activeKeys.includes(report.target.grantKeyId)) {
    throw verificationError(
      `verification key ${report.target.grantKeyId} is not active on the target`,
      `active=${JSON.stringify(activeKeys)}`,
    );
  }
  proven.push(`verification key ${report.target.grantKeyId} active`);

  proven.push(...(await probePublishedOrigin(report, database)));
  return proven;
}

async function probePublishedOrigin(
  report: PreflightReport,
  database: RemoteD1,
): Promise<readonly string[]> {
  const origin = report.target.publicOrigin;
  const proven: string[] = [];

  const discovery = await fetch(`${origin}/.well-known/takoserver`);
  if (discovery.status !== 200) {
    throw verificationError(`discovery returned ${discovery.status} on ${origin}`);
  }
  const advertised = (await discovery.json()) as { readonly product?: unknown };
  if (advertised.product !== "takoserver") {
    throw verificationError("discovery did not advertise the Takoserver product");
  }
  proven.push("public discovery served");

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const resourceRef = `probe-${suffix}`;
  const reservationId = `reservation-deploy-probe-${suffix}`;
  const offeringDigest = await probeOfferingDigest(suffix);
  const nativeId = `${report.target.r2.bucketName}/${PROBE_TENANT}/${resourceRef}`;

  await database.statement(
    "verification",
    "probe registration",
    "INSERT INTO runtime_resources (organization_id, security_domain_id, tenant_ref, " +
      "resource_ref, reservation_id, offering_id, offering_digest, backend_id, native_id, " +
      "allowances_json, created_at_epoch_seconds) VALUES (" +
      `${sqlLiteral(PROBE_ORGANIZATION)}, ${sqlLiteral(PROBE_SECURITY_DOMAIN)}, ` +
      `${sqlLiteral(PROBE_TENANT)}, ${sqlLiteral(resourceRef)}, ${sqlLiteral(reservationId)}, ` +
      `${sqlLiteral(PROBE_OFFERING)}, ${sqlLiteral(offeringDigest)}, ` +
      `${sqlLiteral("cloudflare-r2-binding")}, ${sqlLiteral(nativeId)}, ` +
      `${sqlLiteral(PROBE_ALLOWANCES)}, ${Math.floor(Date.now() / 1_000)})`,
  );

  try {
    const signer = createExecutionGrantSigner({
      issuer: origin,
      keyId: report.target.grantKeyId,
      privateKey: await loadSigningKey(report.target.grantKeyId),
    });
    const mint = async (intent: Record<string, unknown>, grantId: string): Promise<string> =>
      await signer.issue({
        audience: RUNTIME_AUDIENCE,
        securityDomainId: PROBE_SECURITY_DOMAIN,
        tenantRef: PROBE_TENANT,
        reservationId,
        offeringId: PROBE_OFFERING,
        offeringDigest,
        operation: "s3.access",
        intentDigest: await executionIntentDigest(intent),
        issuedAt: new Date(Date.now() - 5_000),
        expiresAt: new Date(Date.now() + 115_000),
        grantId,
      });

    const objectUrl =
      `${origin}/v1/storage/object?tenantRef=${PROBE_TENANT}` +
      `&resourceRef=${resourceRef}&key=${encodeURIComponent(PROBE_KEY)}`;
    const body = new TextEncoder().encode(`takoserver deploy probe ${suffix}`);

    const putGrant = await mint(
      objectStorageIntent({
        operation: "put",
        tenantRef: PROBE_TENANT,
        resourceRef,
        key: PROBE_KEY,
        bodyDigest: await objectStorageBodyDigest(body),
        contentType: PROBE_CONTENT_TYPE,
      }),
      `grant-deploy-probe-put-${suffix}`,
    );
    const put = await fetch(objectUrl, {
      method: "PUT",
      headers: { authorization: `Bearer ${putGrant}`, "content-type": PROBE_CONTENT_TYPE },
      body,
    });
    if (put.status !== 201) {
      throw verificationError(
        `signed object PUT returned ${put.status}`,
        (await put.text()).slice(0, 512),
      );
    }
    proven.push("signed object PUT accepted on the published origin");

    const getGrant = await mint(
      objectStorageIntent({
        operation: "get",
        tenantRef: PROBE_TENANT,
        resourceRef,
        key: PROBE_KEY,
      }),
      `grant-deploy-probe-get-${suffix}`,
    );
    const read = await fetch(objectUrl, { headers: { authorization: `Bearer ${getGrant}` } });
    if (read.status !== 200) {
      throw verificationError(
        `signed object GET returned ${read.status}`,
        (await read.text()).slice(0, 512),
      );
    }
    const readBytes = new Uint8Array(await read.arrayBuffer());
    if (Buffer.compare(Buffer.from(readBytes), Buffer.from(body)) !== 0) {
      throw verificationError("the published origin returned different object bytes");
    }
    proven.push("signed object GET returned the exact stored bytes");

    const replay = await fetch(objectUrl, {
      method: "PUT",
      headers: { authorization: `Bearer ${putGrant}`, "content-type": PROBE_CONTENT_TYPE },
      body,
    });
    if (replay.status !== 401) {
      throw verificationError(`replayed grant returned ${replay.status}, expected 401`);
    }
    const replayBody = (await replay.json()) as { readonly error?: { readonly code?: unknown } };
    if (replayBody.error?.code !== "grant_replayed") {
      throw verificationError(
        `replayed grant was rejected with ${JSON.stringify(replayBody.error?.code)}`,
      );
    }
    proven.push("replayed grant rejected as grant_replayed");

    const controlPlane = await fetch(`${origin}/v1/organizations`);
    if (controlPlane.status !== 503) {
      throw verificationError(
        `the unavailable control plane returned ${controlPlane.status}, expected 503`,
      );
    }
    proven.push("control-plane routes stay fail-closed with 503");

    const deleteGrant = await mint(
      objectStorageIntent({
        operation: "delete",
        tenantRef: PROBE_TENANT,
        resourceRef,
        key: PROBE_KEY,
      }),
      `grant-deploy-probe-delete-${suffix}`,
    );
    const removed = await fetch(objectUrl, {
      method: "DELETE",
      headers: { authorization: `Bearer ${deleteGrant}` },
    });
    if (removed.status !== 204) {
      throw verificationError(`probe object cleanup returned ${removed.status}`);
    }
    proven.push("probe object removed");
  } finally {
    await database.statement(
      "verification",
      "probe registration cleanup",
      "DELETE FROM runtime_resources WHERE security_domain_id = " +
        `${sqlLiteral(PROBE_SECURITY_DOMAIN)} AND tenant_ref = ${sqlLiteral(PROBE_TENANT)} ` +
        `AND resource_ref = ${sqlLiteral(resourceRef)}`,
    );
  }

  return proven;
}

async function probeOfferingDigest(suffix: string): Promise<`sha256:${string}`> {
  return await executionIntentDigest({
    offeringId: PROBE_OFFERING,
    purpose: "takoserver-deploy-probe",
    suffix,
  });
}
