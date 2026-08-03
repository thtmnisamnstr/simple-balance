import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Marks the one request that is claiming an unclaimed deployment.
 *
 * The sign-up route decides this: it holds the advisory lock, it has seen a
 * valid setup code, and it has confirmed no account exists yet. Better Auth's
 * `user.create.before` hook then runs *inside* the sign-up transaction, and a
 * deployment configured with a single database connection has already lent that
 * connection to the transaction. So the hook cannot go and look the answer up
 * for itself without waiting on a connection that will not come back. It reads
 * the decision from here instead.
 */
const bootstrapClaim = new AsyncLocalStorage<true>();

export function runAsBootstrapClaim<T>(fn: () => T): T {
  return bootstrapClaim.run(true, fn);
}

export function isBootstrapClaim() {
  return bootstrapClaim.getStore() === true;
}
