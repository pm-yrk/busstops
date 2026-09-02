# 12 — Daily Brief

## Purpose

**Bus Stops Pro — Daily Operations Brief: Yesterday’s performance. Today’s outlook.** A professional executive email resembling a clean embedded BI dashboard, backed by the same immutable snapshot as its browser version.

## Contents

Header: organisation/scope, local date, generation time, coverage and source-health caveat.

Yesterday:

- Network Health and change versus 30-day comparable baseline
- punctuality, reliability and average/median delay with denominators
- top-performing and requires-attention routes (only with comparable coverage)
- biggest delay burden and biggest abnormal disruption
- current versus typical, excess vehicle-minutes, occurrence frequency, affected routes/vehicles
- key bunching, gap or diversion events and data-quality issues

Today’s outlook:

- overall risk band and confidence
- weather window, planned roadworks/incidents and active official flood notices
- highest-risk corridors/routes with probability band and expected additional journey-time range
- practical investigation priorities phrased as suggestions, not automated operational commands

Footer: open Pro link, methodology/data-source link, manage preferences/unsubscribe, privacy and attribution.

## Generation

At a bounded schedule, create one scoped `DailyBriefSnapshot` after prior-day aggregation and current forecast/road/flood ingestion. Deterministic templates generate narrative from ranked facts; optional AI rewriting is prohibited as a requirement and must never change numbers/claims. Freeze snapshot and use it for both HTML email and web view.

## Email engineering

Use responsive table-based HTML, inline styles, live text (not image-only dashboards), alt text, sufficient contrast and a plain-text part. Charts degrade into numbers/bars/tables. Test major clients. Do not include sensitive raw vehicle traces.

## Subscriptions

Require sign-in, verified email, explicit opt-in, timezone, delivery time, scope and preferences. Unsubscribe is one click and honoured immediately. Store consent/audit timestamps. Apply recipient and daily-send caps below provider free limits. Deduplicate sends by snapshot/recipient idempotency key.

## Failure and guardrails

If data coverage is inadequate, send a clearly labelled limited-data brief or skip according to preference—never fabricate. Retry transient failures within a bounded window, record outcome, and do not burst through quotas. At governor amber/critical state, prioritize already-verified essential recipients, suspend previews/test sends first, and stop before paid overage. The product must work without email if no provider is configured.

