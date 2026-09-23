#!/usr/bin/env node
/**
 * Gives every seeded user a password, so the load driver can sign in as them.
 *
 *   CAPACITY_BASE_URL=http://127.0.0.1:3100 node scripts/capacity/credentials.mjs
 *
 * Run after `seed.mjs` and before `load.mjs`.
 *
 * The hash is minted by the application rather than by this script, which is
 * the whole design: it signs one throwaway account up through the real
 * `/api/auth/sign-up/email`, reads back what Better Auth stored, and copies
 * that to every capacity user. So the driver afterward is exercising the same
 * sign-in the browser does, against credentials this file never had to know how
 * to produce — and a future change to the hashing algorithm is picked up here
 * for free instead of leaving a hardcoded hash that silently stops matching.
 *
 * It works because the salt is inside the value: the same password produces a
 * hash that verifies for anybody it is copied to. Checked at the end by signing
 * in as one of the copies rather than assumed.
 */
import { env, exit } from "node:process";
import pg from "pg";

export const CAPACITY_PASSWORD = "capacity-load-test-password-1";

// The work is a function so that importing this file gets the password and
// nothing else. `load.mjs` takes CAPACITY_PASSWORD from here so the two cannot
// disagree about it, and an import that also stamped ten thousand rows and
// signed somebody up would be a surprising thing for a constant to do — it was,
// once, and the symptom was a load run reporting "gave 0 users a password"
// before it had done anything.
async function main() {
  const url = env.CAPACITY_DATABASE_URL ?? env.DATABASE_URL;
  const base = env.CAPACITY_BASE_URL ?? "http://127.0.0.1:3000";
  if (!url) {
    console.error("Set CAPACITY_DATABASE_URL (or DATABASE_URL).");
    exit(1);
  }

  const KEY_EMAIL = "capacity-key@capacity.invalid";

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  // A distinct X-Forwarded-For on every request in this file, because sign-up and
  // sign-in are counted per client address and everything here arrives from one
  // machine. The deployment under test runs with TRUST_PROXY on for the same
  // reason — without it the whole run shares one allowance and the fifth request
  // is refused.
  const headers = (address) => ({
    "Content-Type": "application/json",
    Origin: base,
    "X-Forwarded-For": address,
  });

  const existing = await client.query("select 1 from auth_user where email = $1", [KEY_EMAIL]);
  if (existing.rowCount === 0) {
    const response = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: headers("10.255.0.1"),
      body: JSON.stringify({
        email: KEY_EMAIL,
        password: CAPACITY_PASSWORD,
        name: "Capacity key",
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      console.error(`Sign-up failed: ${response.status} ${detail}`);
      // Two failures look alike from here and have nothing to do with each
      // other, so name both rather than guess. CROSS_ORIGIN_REQUEST is the one
      // that catches people out: every state-changing request is compared
      // against APP_BASE_URL, and http://localhost and http://127.0.0.1 are
      // different origins however much they are the same machine.
      if (detail.includes("CROSS_ORIGIN")) {
        console.error(
          `CAPACITY_BASE_URL is ${base}, which is not the deployment's APP_BASE_URL. They must match exactly.`,
        );
      } else {
        console.error("The deployment needs ALLOWED_EMAILS to admit this address.");
      }
      await client.end();
      exit(1);
    }
    console.log("minted a password hash through the application's own sign-up");
  }

  const hash = await client.query(
    `select a.password from auth_account a
     join auth_user u on u.id = a.user_id
     where u.email = $1 and a.provider_id = 'credential'`,
    [KEY_EMAIL],
  );
  if (hash.rowCount === 0 || !hash.rows[0].password) {
    console.error("The key account has no credential row. Is AUTH_MODE local?");
    await client.end();
    exit(1);
  }

  // One statement. `on conflict do nothing` so running this twice is free, which
  // matters because it is the step people forget and then re-run.
  const stamped = await client.query(
    `insert into auth_account (id, account_id, provider_id, user_id, password, created_at, updated_at)
     select 'acct-' || u.id, u.id, 'credential', u.id, $1, now(), now()
     from auth_user u
     where u.id like 'cap-%'
       and not exists (select 1 from auth_account a where a.user_id = u.id)`,
    [hash.rows[0].password],
  );
  console.log(`gave ${stamped.rowCount.toLocaleString()} capacity users a password`);

  const sample = await client.query(
    "select email from auth_user where id like 'cap-%' order by id limit 1",
  );
  await client.end();

  if (sample.rowCount === 0) {
    console.error("No capacity users. Run scripts/capacity/seed.mjs first.");
    exit(1);
  }

  // Proving it rather than trusting it: a stamped hash that does not verify would
  // otherwise surface as a load run where every request is a 401 and the
  // percentiles look wonderful.
  const check = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: headers("10.255.0.2"),
    body: JSON.stringify({ email: sample.rows[0].email, password: CAPACITY_PASSWORD }),
  });
  if (!check.ok) {
    console.error(`A seeded user could not sign in: ${check.status} ${await check.text()}`);
    exit(1);
  }
  console.log(`${sample.rows[0].email} signs in — the driver can act as any of them`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
