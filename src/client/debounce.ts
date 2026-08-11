import { useEffect, useState } from "react";

/**
 * A value that waits for typing to stop before anything acts on it.
 *
 * A search box's value is part of a query key, so every keystroke was a
 * request, and the server side of that request is three unindexed
 * `ilike '%…%'` comparisons plus a count over the same predicate. Nine
 * keypresses meant nine full scans of the ledger to answer a question nobody
 * had finished asking.
 *
 * The input keeps the raw value, so typing stays instant; only the query reads
 * this one.
 */
export function useDebounced<T>(value: T, delayMs = 300) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
