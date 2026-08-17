import { readFileSync } from "node:fs";
import { createD1HttpSql } from "../src/sql-d1-http.ts";

/**
 * Hands an organization to a different principal.
 *
 * Needed the moment a deployment gains a real identity provider. Everything an
 * operator built while vouching for themselves by signature belongs to the
 * principal that assertion created; signing in with Google makes a different
 * principal, and the wallet, the keys, and every resource stay with the first
 * one. Without this, turning sign-in on loses the account.
 *
 *   bun scripts/transfer-organization.ts <organizationId> <email> [--apply]
 *
 * The new owner must have signed in at least once — a principal is created by
 * signing in, and handing an organization to somebody who does not exist yet
 * would leave it owned by nobody.
 *
 * Reads only, until `--apply`.
 */

const [organizationId, email, ...flags] = process.argv.slice(2);
const write = flags.includes("--apply");

if (!organizationId || !email) {
  process.stderr.write("usage: transfer-organization.ts <organizationId> <email> [--apply]\n");
  process.exit(2);
}

function required(variable: string): string {
  const value = process.env[variable];
  if (!value) {
    process.stderr.write(`${variable} is required\n`);
    process.exit(2);
  }
  return value;
}

const tokenFile = process.env.TAKOSERVER_CF_TOKEN_FILE;
const sql = createD1HttpSql({
  accountId: required("CLOUDFLARE_ACCOUNT_ID"),
  databaseId: required("TAKOSERVER_D1_DATABASE_ID"),
  authorize: () =>
    `Bearer ${
      tokenFile ? readFileSync(tokenFile, "utf8").trim() : required("CLOUDFLARE_API_TOKEN")
    }`,
});

const orgs = await sql.query("SELECT id, name, owner_principal_id FROM orgs WHERE id = ?", [
  organizationId,
]);
const org = orgs[0];
if (!org) {
  process.stderr.write(`no organization ${organizationId}\n`);
  process.exit(1);
}

const candidates = await sql.query(
  "SELECT id, provider, provider_subject, display_name FROM principals WHERE email = ?",
  [email],
);
if (candidates.length === 0) {
  process.stderr.write(
    `no principal with email ${email}. They have to sign in once before an organization can be handed to them.\n`,
  );
  process.exit(1);
}
if (candidates.length > 1) {
  // One address, several identities. Choosing for the operator here would be
  // choosing which account owns the money.
  process.stderr.write(
    `${candidates.length} principals share ${email}; refusing to guess:\n` +
      candidates
        .map(
          (row) => `  ${String(row.id)} ${String(row.provider)}:${String(row.provider_subject)}\n`,
        )
        .join(""),
  );
  process.exit(1);
}

const owner = candidates[0] as Record<string, unknown>;
const ownerId = String(owner.id);

if (String(org.owner_principal_id) === ownerId) {
  process.stdout.write(`${String(org.name)} is already owned by ${email}\n`);
  process.exit(0);
}

process.stdout.write(
  `${String(org.name)} (${organizationId})\n` +
    `  from ${String(org.owner_principal_id)}\n` +
    `    to ${ownerId} — ${String(owner.display_name)} <${email}> via ${String(owner.provider)}\n`,
);

if (!write) {
  process.stdout.write("\nplan only: nothing was written. Re-run with --apply.\n");
  process.exit(0);
}

const written = await sql.run(
  "UPDATE orgs SET owner_principal_id = ? WHERE id = ? AND owner_principal_id = ?",
  [ownerId, organizationId, String(org.owner_principal_id)],
);
if (written.changes !== 1) {
  process.stderr.write("the organization moved while this was running; nothing was written\n");
  process.exit(1);
}

process.stdout.write(`transferred to ${email}\n`);
