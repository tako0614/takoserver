import { S3CredentialError, type S3CredentialIssuer, type S3CredentialSet } from "./s3-port.ts";

export interface S3CredentialIssuerRoute {
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
  readonly issuer: S3CredentialIssuer;
}

/** Routes credentials only by the provider identity sealed into a Deployment. */
export function createS3CredentialIssuerRouter(
  input: readonly S3CredentialIssuerRoute[],
): S3CredentialIssuer {
  const routes = new Map<string, S3CredentialIssuer>();
  for (const route of input) {
    const key = routeKey(route.providerPackRef, route.providerInstallationRef);
    if (routes.has(key)) throw new TypeError(`duplicate S3 credential issuer route: ${key}`);
    routes.set(key, route.issuer);
  }

  return {
    limits(authority) {
      return (
        routes
          .get(routeKey(authority.providerPackRef, authority.providerInstallationRef))
          ?.limits(authority) ?? null
      );
    },

    async issue(issue): Promise<S3CredentialSet> {
      const issuer = routes.get(routeKey(issue.providerPackRef, issue.providerInstallationRef));
      if (!issuer?.limits(issue)) throw new S3CredentialError("upstream_invalid");
      return await issuer.issue(issue);
    },
  };
}

function routeKey(providerPackRef: string, providerInstallationRef: string): string {
  return `${providerPackRef}\0${providerInstallationRef}`;
}
