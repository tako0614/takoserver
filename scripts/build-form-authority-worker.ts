import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
const output = mkdtempSync(join(tmpdir(), "takoserver-form-authority-build-"));

try {
  for (const [name, config, fixture, requiredBindings, forbiddenBindings] of [
    [
      "production",
      "wrangler.form-authority.jsonc",
      false,
      ["STATE_DB", "OBJECTS", "PUBLIC_HOST_IDENTITY"],
      [],
    ],
    [
      "integration",
      "wrangler.integration-form-authority.jsonc",
      true,
      [
        "STATE_DB",
        "OBJECTS",
        "PUBLIC_HOST_IDENTITY",
        "TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK",
        "TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID",
        "TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE",
      ],
      [],
    ],
    [
      "integration-operator",
      "wrangler.integration-form-authority-operator.jsonc",
      false,
      [
        "FORM_AUTHORITY",
        "PUBLIC_HOST_IDENTITY",
        "TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID",
        "TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE",
      ],
      ["STATE_DB", "OBJECTS"],
    ],
  ] as const) {
    const directory = join(output, name);
    const result = Bun.spawn(
      [
        resolve(repository, "node_modules/.bin/wrangler"),
        "deploy",
        "--dry-run",
        "--strict",
        "--config",
        resolve(repository, config),
        "--outdir",
        directory,
      ],
      { cwd: repository, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      result.exited,
      new Response(result.stdout).text(),
      new Response(result.stderr).text(),
    ]);
    if (exitCode !== 0) {
      process.stderr.write(stdout);
      process.stderr.write(stderr);
      process.exitCode = 1;
      continue;
    }
    const bundles = files(directory).filter((path) => path.endsWith(".js"));
    if (bundles.length !== 1) {
      throw new Error(`${name} Form authority dry-run produced an invalid bundle inventory`);
    }
    const source = readFileSync(bundles[0] as string, "utf8");
    for (const binding of requiredBindings) {
      if (!source.includes(binding)) throw new Error(`${name} bundle does not use ${binding}`);
    }
    for (const binding of forbiddenBindings) {
      if (source.includes(binding)) throw new Error(`${name} bundle unexpectedly uses ${binding}`);
    }
    if (source.includes("/admin") || source.includes("CLOUDFLARE_API_TOKEN")) {
      throw new Error(`${name} bundle contains a public-admin or credential surface`);
    }
    // The generated corpus export is the bundle-level witness that the
    // integration Worker carries the exact fixture package closure. Keep the
    // marker tied to the generated source symbol rather than a prose label
    // that is not part of the compiled Worker.
    const containsFixture = source.includes("INTEGRATION_FORM_PACKAGES");
    if (containsFixture !== fixture) {
      throw new Error(`${name} bundle integration-fixture closure is incorrect`);
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
