/** Run `fn` over `items` with at most `n` calls in flight, results in input order.
 * Rejects on the first failure like Promise.all — callers treat a partial result
 * as no result (the scan checkpoint depends on that). */
export async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
