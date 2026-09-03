# Bad artifact and rollback

## How you know

- A build reports `outcome: rolled_back`, or `complete: false` with failed datasets.
- Counts fall sharply between versions: the publisher rejects a shrink beyond its threshold, and
  says so.
- A checksum mismatch when reading, which the artifact store refuses to serve.

## What the platform already does

- Validation happens **before** the manifest pointer swaps, so a bad build never becomes live.
- An excessive shrink is rejected: a national dataset losing 40% of its records is far more likely
  to be a broken parse than a real change.
- A partial multi-dataset publish is rolled back, because half-updated is worse than stale.

## What to do

1. Read the build report. It names which datasets advanced and which did not.
2. If a bad version did go live, `rollbackNetwork` / `rollbackIntelligence` restore the previous
   good version for every dataset.
3. Reproduce the parse failure against a fixture before changing the parser. Fixtures live in
   `tests/fixtures/documented/` and are captured without credentials.

## What not to do

- Do not raise `maximumShrinkFraction` to force a publish through. If the drop is genuine, publish
  it deliberately with the threshold raised in the same commit and a note saying why.
- Do not hand-edit an artifact. The checksum will not match and it will not be served.
