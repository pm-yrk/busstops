import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TileSpill } from "./gtfs-spill.js";

function spill(thresholdBytes?: number): TileSpill {
  return new TileSpill(mkdtempSync(join(tmpdir(), "spill-")), thresholdBytes);
}

describe("spilling journeys to tiles", () => {
  it("gives back exactly what it was given, per tile, in order", async () => {
    const store = spill();
    store.append("t1", JSON.stringify({ id: "a" }));
    store.append("t2", JSON.stringify({ id: "b" }));
    store.append("t1", JSON.stringify({ id: "c" }));
    store.flush();

    expect(await store.readAll<{ id: string }>("t1")).toEqual([{ id: "a" }, { id: "c" }]);
    expect(await store.readAll<{ id: string }>("t2")).toEqual([{ id: "b" }]);
    store.dispose();
  });

  it("survives the buffer filling many times over", async () => {
    // A tiny threshold, so a few hundred records force repeated flushes and the append path is
    // exercised rather than the single write at the end.
    const store = spill(256);
    for (let index = 0; index < 500; index += 1) {
      store.append(`tile-${index % 7}`, JSON.stringify({ index }));
    }
    store.flush();

    const stats = store.stats();
    expect(stats.tiles).toBe(7);
    expect(stats.lines).toBe(500);
    expect(stats.flushes).toBeGreaterThan(0);

    const recovered = await store.readAll<{ index: number }>("tile-0");
    expect(recovered).toHaveLength(72);
    // Order within a tile is the order it was written, flushes notwithstanding.
    expect(recovered[0]!.index).toBe(0);
    expect(recovered[1]!.index).toBe(7);
    store.dispose();
  });

  it("reports which tiles hold what, without reading them", () => {
    const store = spill();
    store.append("a", "1");
    store.append("a", "2");
    store.append("b", "3");
    store.flush();

    expect(store.tiles().sort((x, y) => x.tile.localeCompare(y.tile))).toEqual([
      { tile: "a", lines: 2 },
      { tile: "b", lines: 1 },
    ]);
    store.dispose();
  });

  it("never lets a tile name escape its directory", async () => {
    const store = spill();
    store.append("../escape", "1");
    store.flush();
    expect(await store.readAll("../escape")).toEqual([1]);
    store.dispose();
  });

  it("cleans up after itself", () => {
    const directory = mkdtempSync(join(tmpdir(), "spill-"));
    const store = new TileSpill(directory);
    store.append("a", "1");
    store.flush();
    expect(existsSync(directory)).toBe(true);
    store.dispose();
    expect(existsSync(directory)).toBe(false);
  });
});
