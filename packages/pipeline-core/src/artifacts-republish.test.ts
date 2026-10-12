import { describe, expect, it } from "vitest";
import { ArtifactStore, InMemoryObjectStore } from "./artifacts.js";

/**
 * Republishing a dataset at the version already live is an in-place correction, not a new version.
 *
 * A departures refresh does exactly that to `network/operators`, to carry a field the build had
 * not been reading, and it must not cost the artifact its rollback pointer: `rollbackNetwork`
 * walks every dataset, so a pointer aimed at its own version turns a rollback into a silent no-op.
 */
const RECORDS = Array.from({ length: 10 }, (_, i) => ({ id: `op-${i}` }));

describe("republishing a dataset at the live version", () => {
  it("keeps the pointer to the version it actually superseded", async () => {
    const artifacts = new ArtifactStore(new InMemoryObjectStore());

    await artifacts.publish({
      dataset: "network/operators",
      version: "v1",
      records: RECORDS,
      schemaVersion: "1.0.0",
    });
    const second = await artifacts.publish({
      dataset: "network/operators",
      version: "v2",
      records: RECORDS,
      schemaVersion: "1.0.0",
    });
    expect(second.previousVersion).toBe("v1");

    // The in-place correction: same version, corrected contents.
    const corrected = await artifacts.publish({
      dataset: "network/operators",
      version: "v2",
      records: RECORDS.map((record) => ({ ...record, noc: "FLDS" })),
      schemaVersion: "1.0.0",
    });

    expect(corrected.version).toBe("v2");
    // Not "v2": pointing at itself would make a rollback a no-op.
    expect(corrected.previousVersion).toBe("v1");
  });

  it("still rolls back to the earlier version after an in-place republish", async () => {
    const artifacts = new ArtifactStore(new InMemoryObjectStore());
    await artifacts.publish({
      dataset: "network/operators",
      version: "v1",
      records: RECORDS,
      schemaVersion: "1.0.0",
    });
    await artifacts.publish({
      dataset: "network/operators",
      version: "v2",
      records: RECORDS,
      schemaVersion: "1.0.0",
    });
    await artifacts.publish({
      dataset: "network/operators",
      version: "v2",
      records: RECORDS.map((record) => ({ ...record, noc: "FLDS" })),
      schemaVersion: "1.0.0",
    });

    const rolled = await artifacts.rollback("network/operators");
    expect(rolled?.version).toBe("v1");
  });
});
