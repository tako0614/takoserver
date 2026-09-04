import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
const output = mkdtempSync(join(tmpdir(), "takoserver-sponsorship-authority-build-"));

try {
  const config = JSON.parse(
    readFileSync(resolve(repository, "wrangler.sponsorship-authority.jsonc"), "utf8"),
  ) as Record<string, unknown>;
  const versionMetadata = record(config.version_metadata);
  const databases = config.d1_databases;
  const database = Array.isArray(databases) ? record(databases[0]) : undefined;
  const secrets = record(config.secrets);
  if (
    config.workers_dev !== false ||
    config.preview_urls !== false ||
    ["route", "routes", "subdomain", "custom_domains", "triggers"].some((key) => key in config) ||
    !versionMetadata ||
    Object.keys(versionMetadata).join(",") !== "binding" ||
    versionMetadata.binding !== "WORKER_VERSION" ||
    !Array.isArray(databases) ||
    databases.length !== 1 ||
    !database ||
    database.binding !== "STATE_DB" ||
    !secrets ||
    !Array.isArray(secrets.required) ||
    JSON.stringify([...secrets.required].sort()) !==
      JSON.stringify(
        [
          "TAKOSERVER_SPONSORSHIP_CREDENTIAL_SIGNING_KEY",
          "TAKOSERVER_SPONSORSHIP_RECEIPT_SIGNING_KEY",
        ].sort(),
      )
  ) {
    throw new Error("sponsorship authority must keep its exact route-less binding closure");
  }

  const child = Bun.spawn(
    [
      resolve(repository, "node_modules/.bin/wrangler"),
      "deploy",
      "--dry-run",
      "--strict",
      "--config",
      resolve(repository, "wrangler.sponsorship-authority.jsonc"),
      "--outdir",
      output,
    ],
    { cwd: repository, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    process.stderr.write(stdout);
    process.stderr.write(stderr);
    process.exitCode = 1;
  } else {
    const bundles = files(output).filter((path) => path.endsWith(".js"));
    if (bundles.length !== 1) {
      throw new Error(`expected one sponsorship authority bundle, received ${bundles.length}`);
    }
    const bundle = bundles[0];
    if (bundle === undefined) throw new Error("sponsorship authority bundle is missing");
    const source = readFileSync(bundle, "utf8");
    for (const binding of [
      "STATE_DB",
      "TAKOSERVER_SPONSORSHIP_ORGANIZATION_ID",
      "TAKOSERVER_SPONSORSHIP_TOKEN_ISSUER",
      "TAKOSERVER_SPONSORSHIP_CREDENTIAL_KEY_ID",
      "TAKOSERVER_SPONSORSHIP_CREDENTIAL_PUBLIC_JWK",
      "TAKOSERVER_SPONSORSHIP_CREDENTIAL_SIGNING_KEY",
      "TAKOSERVER_SPONSORSHIP_RECEIPT_KEY_ID",
      "TAKOSERVER_SPONSORSHIP_RECEIPT_SIGNING_KEY",
      "TAKOSERVER_SPONSORSHIP_AUTHORITY_WORKER_NAME",
      "TAKOSERVER_SPONSORSHIP_AUTHORITY_SOURCE_COMMIT",
      "TAKOSERVER_SPONSORSHIP_AUTHORITY_ARTIFACT_SHA256",
      "WORKER_VERSION",
    ]) {
      if (!source.includes(binding)) {
        throw new Error(`sponsorship authority bundle does not use ${binding}`);
      }
    }
    for (const forbidden of [
      "OBJECTS",
      "CLOUDFLARE_API_TOKEN",
      "TAKOSERVER_SIGNING_KEY_ID",
      "TAKOSERVER_SIGNING_KEY",
      ["HOST", "RUNTIME", "MATERIALIZER"].join("_"),
      ["TAKOSERVER", "HOSTED", "SPONSORSHIP", "TOKEN"].join("_"),
      "PublicHostIdentityEntrypoint",
      "FormAuthorityEntrypoint",
      ["", "v1", "sponsorship", "tenants"].join("/"),
    ]) {
      if (source.includes(forbidden)) {
        throw new Error(`sponsorship authority bundle unexpectedly contains ${forbidden}`);
      }
    }
    const entrypointStart = source.indexOf(
      "SponsorshipAuthorityEntrypoint = class extends WorkerEntrypoint",
    );
    const entrypointEnd = source.indexOf("\n};", entrypointStart);
    const entrypoint =
      entrypointStart < 0 || entrypointEnd < 0 ? "" : source.slice(entrypointStart, entrypointEnd);
    const methods = [
      ...entrypoint.matchAll(/\n {2}(?:async )?([A-Za-z_$][A-Za-z0-9_$]*)\([^)]*\) \{/gu),
    ].map((match) => match[1]);
    if (
      JSON.stringify(methods) !== JSON.stringify(["issueTenantRunCredential"]) ||
      entrypoint.includes("fetch(")
    ) {
      throw new Error(
        "sponsorship authority must export only issueTenantRunCredential and no fetch",
      );
    }
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
