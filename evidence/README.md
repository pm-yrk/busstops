# evidence/

What a GitHub Actions runner actually saw, committed back onto the branch.

This exists because the build session's GitHub token lost its Actions scope: it can push, but
it cannot dispatch a workflow or read a run's logs. Writing the reports here is how the
results get back to somewhere readable. Files are overwritten by each run — this is the
latest measurement, not an archive.

Last written: 2026-10-21T03:25:48.073Z (run)

probe: success · gtfs: success
