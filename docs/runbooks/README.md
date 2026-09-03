# Runbooks

Short, specific procedures for the situations this platform actually gets into. Each one states
how you know you are in it, what to do, and — as importantly — what not to do.

The recurring principle: **degrade visibly rather than fail silently, and never fabricate.** A page
that says "we cannot see this right now" is doing its job. A page that shows a plausible number it
cannot justify is not.

| Runbook | When |
| --- | --- |
| [Upstream source outage](./source-outage.md) | A data source is stale, failing or has changed shape |
| [Budget pressure and safe mode](./budget-pressure.md) | The governor reaches amber, red or critical |
| [Bad artifact and rollback](./bad-artifact.md) | A published dataset is wrong, truncated or corrupt |
| [Daily Brief incidents](./daily-brief.md) | Briefs did not send, sent twice, or went to the wrong people |
| [Data subject requests](./data-requests.md) | Someone asks what you hold about them, or asks you to delete it |
