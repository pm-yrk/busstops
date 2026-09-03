import { useCallback, useEffect, useState } from "react";

/**
 * One place for the load / error / abort state machine every data surface needs.
 *
 * Concentrating it here means each page gets the same behaviour — in-flight requests aborted on
 * change or unmount, a loading deadline so the pixel bus never blocks content forever, and
 * refresh without a flash of the loading state — and it keeps the single unavoidable
 * setState-in-effect in one reviewed place rather than repeated across every page.
 */

export interface FetchState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** True once the caller's loading deadline has passed while still loading. */
  timedOut: boolean;
  reload: () => void;
}

export interface UseFetchOptions {
  /** Milliseconds before the loading state is considered slow. */
  timeoutMs?: number;
  /** Automatic refresh interval; omit for no polling. */
  refreshMs?: number;
  /** Set false to skip fetching entirely, e.g. while a required parameter is missing. */
  enabled?: boolean;
}

/**
 * `fetcher` must be a stable reference (wrap it in `useCallback` with the values it reads).
 * Depending on its identity directly is what keeps this hook honest: there is no second list of
 * dependencies to drift out of step with the function itself.
 */
export function useFetch<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: UseFetchOptions = {},
): FetchState<T> {
  const { timeoutMs = 8000, refreshMs, enabled = true } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [timedOut, setTimedOut] = useState(false);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    let cancelled = false;

    // The loading deadline is a timer, not a render: the bus yields to a message on its own.
    const timer = setTimeout(() => {
      if (!cancelled) setTimedOut(true);
    }, timeoutMs);

    void (async () => {
      try {
        const result = await fetcher(controller.signal);
        if (cancelled) return;
        setData(result);
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        // An aborted request is a superseded one, not a failure to show the user.
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught : new Error("Request failed"));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setTimedOut(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [fetcher, nonce, enabled, timeoutMs]);

  useEffect(() => {
    if (!refreshMs || !enabled) return;
    const interval = setInterval(reload, refreshMs);
    return () => clearInterval(interval);
  }, [refreshMs, enabled, reload]);

  return { data, error, loading, timedOut, reload };
}

/**
 * A clock that ticks on an interval, so countdowns stay honest between fetches without every
 * page writing its own timer.
 */
export function useTicker(intervalMs = 10_000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(interval);
  }, [intervalMs]);

  return now;
}
