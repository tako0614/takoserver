import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { REPOSITORY } from "./process.ts";

/**
 * Publication inputs that are not product modules.
 *
 * These stay path-shaped because there is no import graph to walk: the lockfile
 * and the manifest decide which bytes are built, the Worker configuration
 * decides what the deployed code is allowed to reach, and `scripts/deploy/**`
 * is the deploy mechanism itself.
 */
const NON_MODULE_AUTHORITY_PATHS = [
  /^bun\.lock$/u,
  /^package\.json$/u,
  /^wrangler\.jsonc$/u,
  /^wrangler\.sponsorship-authority\.jsonc$/u,
  /^scripts\/build-worker\.ts$/u,
  /^scripts\/build-sponsorship-authority-worker\.ts$/u,
  /^scripts\/deploy(?:\.ts|\/)/u,
] as const;

/**
 * Modules that are themselves an authority.
 *
 * Each entry is an exact path rather than a pattern, and every one of them is
 * checked to exist before any classification is answered. A renamed or deleted
 * authority module used to fall out of a regex silently and classify as
 * routine; now it refuses until the list says where the authority went.
 *
 * The import closure of these is deliberately *not* walked. Several are
 * composition roots — `app.ts` reaches 73 of the 182 modules under `src`,
 * `entry-worker.ts` reaches 140 — so seeding the walk here would classify
 * almost the whole product as authority and collapse the routine lane into the
 * reviewed cutover. The route and composition owners also reach rendering and
 * catalog modules (`openapi.ts`, `landing.ts`, `catalog.ts`) that carry no
 * authority at all.
 */
const DECLARED_AUTHORITY_MODULES = [
  "src/app.ts",
  "src/auth.ts",
  "src/control.ts",
  "src/deployment-composition.ts",
  "src/entry-cloudflare-worker.ts",
  "src/entry-worker.ts",
  "src/entry-sponsorship-authority-worker.ts",
  "src/google-identity.ts",
  "src/identity-setup.ts",
  "src/operator-credentials.ts",
  "src/operator-key.ts",
  "src/provider-driver.ts",
  "src/provider-port.ts",
  "src/public-host-identity.ts",
  "src/reseller.ts",
  "src/resource-deployments.ts",
  "src/resource-migrations.ts",
  "src/router.ts",
  "src/runtime-grants.ts",
  "src/signing-key.ts",
  "src/sponsorship-authority.ts",
  "src/takoform/admission-projection.ts",
  "src/takoform/admission.ts",
  "src/takoform/host-authority.ts",
  "src/takoform/routes.ts",
  "src/takos-id-identity.ts",
  "src/token.ts",
  "src/worker-production-composition.ts",
] as const;

/**
 * Authorities whose implementation — not just their entry module — is the
 * authority: the prepaid ledger and its Stripe settlement (money), the sealed
 * runtime-input handoff and its AES-256-GCM key ring (customer secrets), and
 * the durable Takoform resource store (the record every later decision is read
 * back from).
 *
 * These are walked because a change to anything they depend on at runtime
 * changes what the authority does. They are leaf-ward: their whole closure is
 * ten modules, and every module in it beyond these five roots was already
 * classified through the public Form P/I closure below, so making the walk
 * authoritative widened the lane by exactly these five files and nothing else.
 *
 * Before this list existed, all five classified as *routine*. A change to the
 * claim state machine, to the seal key ring, or to the settlement path could be
 * published with no reviewer named and `authorityPaths: []` recorded in the
 * receipt as positive evidence that nothing sensitive had changed.
 */
const AUTHORITY_IMPLEMENTATION_ROOTS = [
  "src/ledger.ts",
  "src/runtime-input-preparations.ts",
  "src/runtime-input-seal-keyring.ts",
  "src/stripe-settlement.ts",
  "src/takoform/store.ts",
] as const;

const PUBLIC_FORM_IDENTITY_ROOTS = [
  "src/entry-public-form-runtime-payload.ts",
  "src/public-worker-implementation.ts",
] as const;

const PUBLIC_FORM_IDENTITY_OWNERS = [
  ...PUBLIC_FORM_IDENTITY_ROOTS,
  "src/public-form-implementation-build.ts",
] as const;

let publicFormIdentityPaths: readonly string[] | undefined;
let authorityImplementationPaths: readonly string[] | undefined;
let declaredAuthorityModules: readonly string[] | undefined;

/**
 * Derives the current executable P/I ownership closure from the same build
 * roots used by `prepareWorkerArtifact`. Bun's import scanner omits type-only
 * imports, so unrelated type modules do not widen the authority lane. A new
 * runtime dependency is classified automatically instead of relying on a
 * hand-maintained provider/engine regex.
 */
export function publicFormIdentityAuthorityPaths(): readonly string[] {
  if (publicFormIdentityPaths !== undefined) return publicFormIdentityPaths;
  publicFormIdentityPaths = runtimeImportClosure(
    PUBLIC_FORM_IDENTITY_ROOTS,
    PUBLIC_FORM_IDENTITY_OWNERS,
    "public Form identity",
  );
  return publicFormIdentityPaths;
}

/**
 * The money, customer-secret and durable-store authority closure, derived the
 * same way and from the same import scanner as the P/I closure above.
 */
export function authorityImplementationClosure(): readonly string[] {
  if (authorityImplementationPaths !== undefined) return authorityImplementationPaths;
  authorityImplementationPaths = runtimeImportClosure(
    AUTHORITY_IMPLEMENTATION_ROOTS,
    AUTHORITY_IMPLEMENTATION_ROOTS,
    "authority implementation",
  );
  return authorityImplementationPaths;
}

/** The declared authority modules, refusing if one has been renamed away. */
export function declaredAuthorityModulePaths(): readonly string[] {
  if (declaredAuthorityModules !== undefined) return declaredAuthorityModules;
  for (const path of DECLARED_AUTHORITY_MODULES) {
    const absolute = resolve(REPOSITORY, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new Error(
        `declared authority module no longer exists: ${path}; ` +
          `reclassify it in scripts/deploy/worker-authority-paths.ts`,
      );
    }
  }
  declaredAuthorityModules = [...DECLARED_AUTHORITY_MODULES].sort();
  return declaredAuthorityModules;
}

/** Paths whose code publication changes authentication, authorization or deploy authority. */
export function authoritySensitiveWorkerPaths(paths: readonly string[]): readonly string[] {
  const authority = new Set([
    ...declaredAuthorityModulePaths(),
    ...authorityImplementationClosure(),
    ...publicFormIdentityAuthorityPaths(),
  ]);
  return [
    ...new Set(
      paths.filter(
        (path) =>
          authority.has(path) || NON_MODULE_AUTHORITY_PATHS.some((pattern) => pattern.test(path)),
      ),
    ),
  ].sort();
}

function runtimeImportClosure(
  roots: readonly string[],
  owners: readonly string[],
  subject: string,
): readonly string[] {
  const paths = new Set<string>(owners);
  const pending: string[] = [...roots];
  while (pending.length > 0) {
    const importer = pending.pop();
    if (importer === undefined) break;
    const source = readFileSync(resolve(REPOSITORY, importer), "utf8");
    for (const imported of scanImports(importer, source)) {
      if (!imported.path.startsWith(".")) continue;
      const dependency = resolveRepositoryImport(subject, importer, imported.path);
      if (paths.has(dependency)) continue;
      paths.add(dependency);
      if (isJavaScriptModule(dependency)) pending.push(dependency);
    }
  }
  return [...paths].sort();
}

function scanImports(path: string, source: string) {
  const extension = extname(path);
  const loader = extension === ".tsx" ? "tsx" : extension === ".ts" ? "ts" : "js";
  return new Bun.Transpiler({ loader }).scanImports(source);
}

function resolveRepositoryImport(subject: string, importer: string, specifier: string): string {
  const unresolved = resolve(REPOSITORY, dirname(importer), specifier);
  const candidates = [
    unresolved,
    `${unresolved}.ts`,
    `${unresolved}.tsx`,
    `${unresolved}.js`,
    `${unresolved}.mjs`,
    `${unresolved}.cjs`,
    join(unresolved, "index.ts"),
    join(unresolved, "index.tsx"),
  ];
  const absolute = candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  if (absolute === undefined) {
    throw new Error(`${subject} import cannot be resolved: ${importer} -> ${specifier}`);
  }
  const repositoryPath = relative(REPOSITORY, absolute).split(sep).join("/");
  if (repositoryPath === ".." || repositoryPath.startsWith("../")) {
    throw new Error(`${subject} import escapes the repository: ${importer} -> ${specifier}`);
  }
  return repositoryPath;
}

function isJavaScriptModule(path: string): boolean {
  return [".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(extname(path));
}
