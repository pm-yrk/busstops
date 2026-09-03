# Budget pressure and safe mode

## How you know

- `/v1/sources/health` reports a `governorState` other than `green`.
- The storage inventory job names a projected date on which storage fills.
- Scheduled jobs report widened intervals or skipped partitions.

## The ladder, and what each rung means

| State    | Utilisation                  | What happens                                                                                                           |
| -------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| green    | below 70%                    | Full service                                                                                                           |
| amber    | 70–85%                       | Longer cache TTLs, slower polling, optional detail and previews dropped                                                |
| red      | 85–95%                       | Historical enrichment and recalculation pause; fine aggregates roll up and prune                                       |
| critical | 95%+, or projected to breach | Safe mode: scheduled collection suspended, Daily Brief sends stopped, previous-good aggregates served with visible age |

Safe mode preserves the homepage, static network, schedules, saved items and source status. A
passenger can still look up a stop and read a timetable.

## What to do

1. Identify which resource is under pressure. `evaluateResource` reports per-resource state; the
   aggregate is the worst of them, not an average, so one resource can drive the whole platform.
2. If it is **storage**, check the retention job actually ran. Retention is a separate scheduled
   job precisely so an analytics failure cannot postpone it.
3. If it is **requests**, reduce cadence or partition count in configuration rather than in code.
   Both are environment variables and take effect on the next run.
4. If it is **Actions minutes**, the workflows carry explicit budget arithmetic in their comments.
   Changing a schedule means updating that arithmetic in the same commit.

## What not to do

- Do not raise a limit to make the state go green. The self-imposed ceilings sit below the real
  free-tier limits deliberately; the margin is what stops a bill.
- Do not disable the governor. If a drill is needed, use `GOVERNOR_MODE`, which forces a state
  for testing and is visible in every response.
- Do not skip raw expiry to save the work. Expiry outranks every optional workload.
