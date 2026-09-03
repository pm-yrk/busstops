/**
 * Bounded-concurrency mapping.
 *
 * Publishing a national dataset means thousands of independent object writes, and doing them one
 * at a time makes the job's wall-clock the sum of every network round trip rather than the sum of
 * the work. A pool fixes that without becoming a thundering herd: the limit is what keeps a
 * pipeline from opening thousands of sockets at once, or from looking like an attack to whatever
 * is on the other end.
 *
 * Results come back in input order regardless of completion order, so a caller can still pair a
 * result with the item that produced it.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new RangeError(`Concurrency limit must be at least 1, got ${limit}`);

  const results = new Array<R>(items.length);
  let next = 0;

  // One worker per slot, each pulling the next index until the list is exhausted. This keeps
  // exactly `limit` requests in flight rather than starting in batches, where the whole batch
  // waits for its slowest member before the next begins.
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
}
