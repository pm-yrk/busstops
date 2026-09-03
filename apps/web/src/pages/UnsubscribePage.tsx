import { useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { LoadingBus } from "../components/LoadingBus.js";
import { ErrorState } from "../components/primitives.js";
import { apiClient } from "../lib/api.js";
import { useFetch } from "../lib/use-fetch.js";

/**
 * Unsubscribe confirmation.
 *
 * One click, already done by the time this page renders — there is no confirmation button,
 * because a page that asks "are you sure?" after someone has already clicked unsubscribe is a
 * dark pattern, and the second click is where people give up and mark the mail as spam instead.
 */

export function UnsubscribePage() {
  const [searchParams] = useSearchParams();
  const recipient = searchParams.get("r") ?? "";
  const token = searchParams.get("t") ?? "";

  const fetcher = useCallback(
    (signal: AbortSignal) => apiClient.unsubscribe(recipient, token, signal),
    [recipient, token],
  );

  const { data, error, loading, timedOut, reload } = useFetch<{
    data: { status: string; message: string };
  }>(fetcher, { timeoutMs: 8000 });

  if (loading && !data) return <LoadingBus label="Unsubscribing" timedOut={timedOut} />;

  if (error || !data) {
    return (
      <ErrorState
        title="We could not complete this just now"
        description="Your request did not go through. Please try again, and if it still fails, reply to the email and we will remove you by hand."
        onRetry={reload}
      />
    );
  }

  return (
    <article className="prose">
      <h1>Unsubscribed</h1>
      <p>{data.data.message}</p>
      <p>
        Nothing else changes: <Link to="/pro">Bus Stops Pro</Link> stays open to everyone without an
        account, and your saved stops in this browser are untouched.
      </p>
      <p className="muted small">
        <Link to="/privacy">How we handle your data</Link>
      </p>
    </article>
  );
}
