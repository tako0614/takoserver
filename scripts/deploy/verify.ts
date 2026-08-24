import { RemoteD1, sqlLiteral } from "./d1.ts";
import { verificationError } from "./errors.ts";
import type { PreflightReport } from "./preflight.ts";
import { RUNTIME_TABLES } from "./preflight.ts";
import { inspectSigningAuthority, liveSigningKeyMatches } from "./signing-authority.ts";
import { assertTargetBindingClosure } from "./worker-state.ts";

/**
 * Proves the published bytes serve a real caller.
 *
 * Every assertion runs against the published origin rather than a local build,
 * and none of them needs a credential: the probe exercises what an anonymous
 * caller may reach, then confirms everything else is refused. A probe that had
 * to carry a secret would either weaken the deployment or test something other
 * than what customers actually meet.
 */
export async function verify(
  report: PreflightReport,
  versionId: string,
): Promise<readonly string[]> {
  const proven: string[] = [];

  await assertTargetBindingClosure("verification", report.configPath, versionId, report.target);
  proven.push(`binding closure of version ${versionId}`);

  const database = new RemoteD1(report.configPath);
  const tables = await database.column(
    "verification",
    "product table readback",
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (" +
      `${RUNTIME_TABLES.map((name) => sqlLiteral(name)).join(", ")}) ORDER BY name`,
    "name",
  );
  if (JSON.stringify(tables) !== JSON.stringify([...RUNTIME_TABLES].sort())) {
    throw verificationError(`the target is missing product tables: ${JSON.stringify(tables)}`);
  }
  proven.push("every product table present");

  const signingAuthority = await inspectSigningAuthority(
    "verification",
    report.configPath,
    report.target,
  );
  const signingMatches = await liveSigningKeyMatches(
    "verification",
    report.configPath,
    report.target,
    signingAuthority,
  );
  if (signingMatches === false) {
    throw verificationError("the live Worker signs with a key other than the active D1 key");
  }
  proven.push(
    signingMatches === null
      ? "signing private key synchronized to active D1 key"
      : "live Worker signing proof matches active D1 key",
  );

  proven.push(...(await probePublishedOrigin(report.target.publicOrigin)));
  return proven;
}

export async function probePublishedOrigin(
  origin: string,
  call: (request: Request) => Promise<Response> = (request) => fetch(request),
): Promise<readonly string[]> {
  const proven: string[] = [];

  const discovery = await readJson(`${origin}/.well-known/takoserver`, call);
  if (discovery.status !== 200 || discovery.body.product !== "takoserver") {
    throw verificationError(`discovery did not identify the product on ${origin}`);
  }
  proven.push("public discovery served");

  const document = await readJson(`${origin}/openapi.json`, call);
  const paths = Object.keys((document.body.paths ?? {}) as Record<string, unknown>);
  if (document.status !== 200 || paths.length === 0) {
    throw verificationError("the published origin served no API description");
  }
  // The Takoform lane is the product's primary surface. A deployment that does
  // not describe it is not this product.
  if (!paths.some((path) => path.startsWith("/apis/forms.takoform.com/v1/"))) {
    throw verificationError("the API description does not declare the released Takoform lane");
  }
  proven.push(`API description served with ${paths.length} paths`);

  const advertised = await readJson(`${origin}/.well-known/takoform/v1`, call);
  const versions = advertised.body.api_versions;
  if (
    advertised.status !== 200 ||
    !Array.isArray(versions) ||
    versions.length !== 1 ||
    versions[0] !== "forms.takoform.com/v1"
  ) {
    throw verificationError("the literal stable Takoform Host did not advertise itself");
  }
  proven.push("literal stable Takoform Host advertised");

  // The router owns one global OPTIONS preflight path; it is intentionally not
  // evidence that a retired Host lane exists. Every ordinary method that could
  // discover or mutate such a lane must meet an exact 404 instead.
  for (const lane of ["v1alpha3", "v1beta1", "v1beta4"]) {
    const retiredDiscovery = await call(new Request(`${origin}/.well-known/takoform/${lane}`));
    if (retiredDiscovery.status !== 404) {
      throw verificationError(
        `retired Takoform discovery ${lane} answered ${retiredDiscovery.status}`,
      );
    }
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const retired = await call(
        new Request(`${origin}/apis/forms.takoform.com/${lane}/forms`, { method }),
      );
      if (retired.status !== 404) {
        throw verificationError(
          `${method} on retired Takoform lane ${lane} answered ${retired.status}`,
        );
      }
    }
  }
  proven.push("retired Takoform Host lanes refuse ordinary HTTP methods");

  const providers = await readJson(`${origin}/v1/identity/providers`, call);
  if (providers.status !== 200) {
    throw verificationError(`identity discovery returned ${providers.status}`);
  }
  proven.push("identity discovery served");

  // Everything that acts on somebody's behalf must refuse an anonymous caller.
  // These are the cases a misconfiguration would most plausibly leave open.
  const guarded: readonly (readonly [string, string])[] = [
    ["GET", "/v1/organizations/org_probe/wallet"],
    ["POST", "/v1/reseller/quotes"],
    ["GET", "/apis/forms.takoform.com/v1/support/forms"],
  ];
  for (const [method, path] of guarded) {
    const response = await call(new Request(`${origin}${path}`, { method }));
    if (response.status !== 401 && response.status !== 403) {
      throw verificationError(`${method} ${path} answered ${response.status} with no credential`);
    }
  }
  proven.push("credential-bearing routes refuse an anonymous caller");

  const unknown = await call(new Request(`${origin}/v1/definitely-not-a-route`));
  if (unknown.status !== 404) {
    throw verificationError(`an unknown path answered ${unknown.status}`);
  }
  proven.push("unknown paths answer 404");

  return proven;
}

async function readJson(
  url: string,
  call: (request: Request) => Promise<Response> = (request) => fetch(request),
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await call(new Request(url));
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: response.status, body: {} };
  }
}
