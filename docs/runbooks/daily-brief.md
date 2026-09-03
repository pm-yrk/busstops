# Daily Brief incidents

## Nothing sent

Read the send records: every attempt is recorded, including refusals, so silence always has a
reason. Common ones:

| Outcome                   | Meaning                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `no_provider`             | No email provider is configured. The snapshot is still built and the browser view works. |
| `suppressed_unsubscribed` | The recipient unsubscribed, is unverified, or has no opt-in recorded.                    |
| `suppressed_quota`        | The daily cap or the governor stopped it before any paid overage.                        |
| `skipped_no_data`         | Coverage was too thin and this recipient asked to skip limited-data days.                |
| `failed`                  | The provider rejected or timed out; retries are bounded and recorded.                    |

## Sent twice

This should be impossible: the idempotency key is snapshot plus recipient, and a `sent` record
blocks a repeat. If it happened, check whether two snapshots were built for the same day — the
concurrency group on the workflow exists to prevent exactly that.

## Went to someone who did not want it

Treat as an incident.

1. Unsubscribe them immediately; it is honoured on the next send with no further action.
2. Read the consent events for that recipient. Verification and opt-in are separate audited
   events, so the record will show which was missing.
3. If the address was never verified, the send should have been refused — that is a bug in the
   guard, not a configuration mistake. Reproduce it as a test first.

## The figures in the email and the browser disagree

They are rendered from the same frozen snapshot, so this means the browser view is reading a
different snapshot — usually a newer one published after the email went out. The snapshot id is
in both.

## What not to do

- Do not resend by hand to "make up for" a failure. The next day's brief carries the same
  information, and a duplicate is worse than a gap.
- Do not disable the delivery-window check to send immediately. Recipients chose their time.
