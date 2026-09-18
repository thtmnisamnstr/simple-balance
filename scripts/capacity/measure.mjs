/**
 * The arithmetic the capacity report is made of, apart from the driver that
 * collects it.
 *
 * Separated so it can be tested, and that is not ceremony: these three
 * functions decide every number `docs/capacity.md` publishes. A percentile that
 * is off by one index, a mix wheel that rounds a share away, or an error count
 * that misses a status would all produce a report that looks entirely ordinary
 * and is wrong — and a capacity proof nobody can check is a press release.
 *
 * `tests/capacity-measure.test.ts` is the check.
 */

/**
 * The nearest-rank percentile: the smallest value at or below which `p` per
 * cent of the samples fall.
 *
 * Nearest-rank rather than interpolated, because these are observations of real
 * requests rather than a sample of a continuous distribution. An interpolated
 * p99 reports a latency no request actually had, which is a strange thing to
 * put in a table of what the machine did.
 *
 * Takes the samples already sorted ascending. Sorting inside would be quietly
 * quadratic across the six calls the report makes per arm.
 */
export function percentile(sorted, p) {
  if (sorted.length === 0) return undefined;
  if (p <= 0) return sorted[0];
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * The mix, expanded into one entry per percentage point, so choosing a request
 * is a single random index rather than a walk with a running total.
 *
 * Refuses a mix that does not add to a hundred. A mix of 99 would still run —
 * every share simply a hair commoner than documented — and nothing downstream
 * would notice, which is exactly the kind of drift `docs/capacity.md` and the
 * driver are meant to be held together on.
 */
export function buildWheel(mix) {
  const total = mix.reduce((sum, entry) => sum + entry.percent, 0);
  if (total !== 100) {
    throw new Error(`The request mix adds to ${total}, not 100.`);
  }
  return mix.flatMap((entry) => Array.from({ length: entry.percent }, () => entry.kind));
}

/**
 * How many of a status tally were failures.
 *
 * A 5xx is the server saying it could not, and 0 is the driver's own mark for a
 * request that never got an answer — a reset, a refused connection, a socket
 * that closed. Both are errors and the second is the one that matters most,
 * because it is what a saturated machine does before it starts answering 500.
 *
 * A 4xx is not counted, deliberately. A 409 from two sessions editing one entry
 * is the concurrency control working, and counting it would make a correct
 * refusal look like an outage.
 */
export function errorsIn(statuses) {
  let errors = 0;
  for (const [status, count] of statuses) {
    if (status === 0 || status >= 500) errors += count;
  }
  return errors;
}
