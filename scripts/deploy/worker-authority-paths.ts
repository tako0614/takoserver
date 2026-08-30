import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { REPOSITORY } from "./process.ts";

const AUTHORITY_PATHS = [
  /^bun\.lock$/u,
  /^package\.json$/u,
  /^wrangler\.jsonc$/u,
  /^scripts\/build-worker\.ts$/u,
  /^scripts\/deploy(?:\.ts|\/)/u,
  /^src\/(?:app|auth|control|deployment-composition|google-identity|identity-setup|operator-credentials|operator-key|provider-driver|provider-port|reseller|resource-deployments|resource-migrations|runtime-grants|signing-key|sponsorship-api|takos-id-identity|token)\.ts$/u,
  /^src\/(?:entry-cloudflare-worker|entry-worker|public-host-identity|router|worker-production-composition)\.ts$/u,
  /^src\/takoform\/(?:admission|admission-projection|host-authority|routes)(?:\.|\/)/u,
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

/**
 * Derives the current executable P/I ownership closure from the same build
 * roots used by `prepareWorkerArtifact`. Bun's import scanner omits type-only
 * imports, so unrelated type modules do not widen the authority lane. A new
 * runtime dependency is classified automatically instead of relying on a
 * hand-maintained provider/engine regex.
 */
export function publicFormIdentityAuthorityPaths(): readonly string[] {
  if (publicFormIdentityPaths !== undefined) return publicFormIdentityPaths;
  const paths = new Set<string>(PUBLIC_FORM_IDENTITY_OWNERS);
  const pending: string[] = [...PUBLIC_FORM_IDENTITY_ROOTS];
  while (pending.length > 0) {
    const importer = pending.pop();
    if (importer === undefined) break;
    const source = readFileSync(resolve(REPOSITORY, importer), "utf8");
    for (const imported of scanImports(importer, source)) {
      if (!imported.path.startsWith(".")) continue;
      const dependency = resolveRepositoryImport(importer, imported.path);
      if (paths.has(dependency)) continue;
      paths.add(dependency);
      if (isJavaScriptModule(dependency)) pending.push(dependency);
    }
  }
  publicFormIdentityPaths = [...paths].sort();
  return publicFormIdentityPaths;
}

function scanImports(path: string, source: string) {
  const extension = extname(path);
  const loader = extension === ".tsx" ? "tsx" : extension === ".ts" ? "ts" : "js";
  return new Bun.Transpiler({ loader }).scanImports(source);
}

/** Paths whose code publication changes authentication, authorization or deploy authority. */
export function authoritySensitiveWorkerPaths(paths: readonly string[]): readonly string[] {
  const semanticIdentityPaths = new Set(publicFormIdentityAuthorityPaths());
  return [
    ...new Set(
      paths.filter(
        (path) =>
          semanticIdentityPaths.has(path) || AUTHORITY_PATHS.some((pattern) => pattern.test(path)),
      ),
    ),
  ].sort();
}

function resolveRepositoryImport(importer: string, specifier: string): string {
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
    throw new Error(`public Form identity import cannot be resolved: ${importer} -> ${specifier}`);
  }
  const repositoryPath = relative(REPOSITORY, absolute).split(sep).join("/");
  if (repositoryPath === ".." || repositoryPath.startsWith("../")) {
    throw new Error(
      `public Form identity import escapes the repository: ${importer} -> ${specifier}`,
    );
  }
  return repositoryPath;
}

function isJavaScriptModule(path: string): boolean {
  return [".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(extname(path));
}
