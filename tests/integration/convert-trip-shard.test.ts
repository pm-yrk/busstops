import { describe, expect, it } from "vitest";
import { InMemoryObjectStore, type BinaryObjectStore } from "@busstops/pipeline-core";
import { PatternTripShard, type PatternTripRow } from "@busstops/pipeline-static-network";
import {
  binaryKeyOf,
  convertTripShard,
  revertTripShard,
  rowsOfShardText,
  textKeyOf,
} from "../../scripts/lib/convert-trip-shard.js";

/**
 * The step that deletes published timetable.
 *
 * The trip shards are being converted in place, because republishing England to change a format
 * costs forty-five minutes and a second copy of everything in a bucket with about a gigabyte of
 * headroom. In place means the text form is deleted, and the only thing standing between that and
 * a missing shard of England's timetable is the order of these four operations: write, read back
 * out of the store, prove it holds every row, then delete.
 *
 * So the order is tested, not read. Each case here is a way the sequence could go wrong, and the
 * assertion in every one of them is the same: the text is still there.
 */

const KEY = "data/network/pattern-trips/2026-10-28/1/215_-7/2026-10-22T12:49:08.474Z.jsonl";
const MIDNIGHT = Date.parse("2026-10-28T00:00:00.000Z") / 1000;

function rows(count: number): PatternTripRow[] {
  return Array.from({ length: count }, (_, index) => ({
    p: `0191bd0a-000${String(index % 3)}-7c1e-9a2b-4f6c8d1e2a3b`,
    j: `vj-${String(index)}`,
    t: [MIDNIGHT + 32_400 + index * 60, MIDNIGHT + 33_000 + index * 60],
    ...(index % 3 === 0
      ? { a: [MIDNIGHT + 32_400 + index * 60, MIDNIGHT + 32_940 + index * 60] }
      : {}),
  }));
}

async function published(
  count = 40,
): Promise<{ store: InMemoryObjectStore; source: PatternTripRow[] }> {
  const store = new InMemoryObjectStore();
  const source = rows(count);
  await store.put(KEY, `${source.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return { store, source };
}

describe("converting one trip shard in place", () => {
  it("writes the bytes, proves them, and only then deletes the text", async () => {
    const { store, source } = await published();
    const result = await convertTripShard(store, KEY, { apply: true });

    expect(result.outcome).toBe("converted");
    expect(result.binaryBytes).toBeLessThan(result.textBytes);
    expect(await store.get(KEY)).toBeNull();

    const bytes = await store.getBytes(binaryKeyOf(KEY));
    const shard = new PatternTripShard(bytes!);
    expect(shard.tripCount).toBe(source.length);
    for (let trip = 0; trip < source.length; trip += 1) {
      expect(shard.rowAt(trip)).toEqual(source[trip]);
    }
  });

  it("writes and deletes nothing in a dry run, and still reports what it would save", async () => {
    const { store } = await published();
    const result = await convertTripShard(store, KEY, { apply: false });

    expect(result.outcome).toBe("verified_only");
    expect(result.binaryBytes).toBeGreaterThan(0);
    expect(await store.get(KEY)).not.toBeNull();
    expect(await store.getBytes(binaryKeyOf(KEY))).toBeNull();
  });

  /*
   * A store that answers the write and holds something else.
   *
   * Not hypothetical: this project lost 376 shards of a national publish to a run of 503s, and a
   * byte store that silently truncates is the same failure with a 200 on it. The read-back is the
   * only thing that can catch it, and what it has to do when it does is leave the text alone.
   */
  it("keeps the text when what comes back from the store is not the shard", async () => {
    const { store } = await published();
    const lying: BinaryObjectStore = {
      get: (key) => store.get(key),
      put: (key, value) => store.put(key, value),
      delete: (key) => store.delete(key),
      list: (prefix) => store.list(prefix),
      getBytes: async (key) =>
        key.endsWith(".bin") ? new TextEncoder().encode("half a shard") : store.getBytes(key),
      putBytes: (key, value) => store.putBytes(key, value),
    };

    const result = await convertTripShard(lying, KEY, { apply: true });
    expect(result.outcome).toBe("not_replaced");
    expect(result.reason).toContain("not the shard");
    expect(await store.get(KEY)).not.toBeNull();
  });

  it("keeps the text when the write vanished", async () => {
    const { store } = await published();
    const forgetful: BinaryObjectStore = {
      get: (key) => store.get(key),
      put: (key, value) => store.put(key, value),
      delete: (key) => store.delete(key),
      list: (prefix) => store.list(prefix),
      getBytes: async (key) => (key.endsWith(".bin") ? null : store.getBytes(key)),
      putBytes: () => Promise.resolve(),
    };

    const result = await convertTripShard(forgetful, KEY, { apply: true });
    expect(result.outcome).toBe("not_replaced");
    expect(await store.get(KEY)).not.toBeNull();
  });

  it("keeps the text when the lines will not parse", async () => {
    const store = new InMemoryObjectStore();
    await store.put(KEY, '{"p":"p-1","j":"t-1","t":[1]}\n{not json}\n');
    const result = await convertTripShard(store, KEY, { apply: true });
    expect(result.outcome).toBe("unreadable");
    expect(await store.get(KEY)).not.toBeNull();
    expect(await store.getBytes(binaryKeyOf(KEY))).toBeNull();
  });

  it("says a shard is absent rather than converting an empty one", async () => {
    const store = new InMemoryObjectStore();
    const result = await convertTripShard(store, KEY, { apply: true });
    expect(result.outcome).toBe("absent");
  });

  it("reads the rows a shard's text holds, including the blank last line", () => {
    const source = rows(3);
    const text = `${source.map((row) => JSON.stringify(row)).join("\n")}\n`;
    expect(rowsOfShardText(text)).toEqual(source);
  });
});

/**
 * And the undo.
 *
 * A one-way migration is a worse migration: an operator who can put it back in twenty minutes can
 * agree to it on a Tuesday afternoon. The rule is the same in this direction — the bytes go only
 * after the lines that replace them have been read back out of the store and parsed into the same
 * rows — so the same kinds of failure are tested, and the assertion in each is that the bytes are
 * still there.
 */
describe("putting a trip shard back as lines", () => {
  async function converted(count = 30) {
    const { store, source } = await published(count);
    const result = await convertTripShard(store, KEY, { apply: true });
    expect(result.outcome).toBe("converted");
    return { store, source };
  }

  it("rebuilds exactly the rows the shard was published with, and then drops the bytes", async () => {
    const { store, source } = await converted();
    const back = await revertTripShard(store, KEY, { apply: true });

    expect(back.outcome).toBe("converted");
    expect(await store.getBytes(binaryKeyOf(KEY))).toBeNull();
    const text = await store.get(KEY);
    expect(text).not.toBeNull();
    expect(rowsOfShardText(text!)).toEqual(source);
  });

  it("writes and deletes nothing in a dry run", async () => {
    const { store } = await converted();
    const back = await revertTripShard(store, KEY, { apply: false });
    expect(back.outcome).toBe("verified_only");
    expect(await store.get(KEY)).toBeNull();
    expect(await store.getBytes(binaryKeyOf(KEY))).not.toBeNull();
  });

  it("keeps the bytes when what comes back as lines is not the shard", async () => {
    const { store } = await converted();
    const lying: BinaryObjectStore = {
      get: async (key) => (key.endsWith(".jsonl") ? '{"p":"x","j":"y","t":[1]}\n' : store.get(key)),
      put: (key, value) => store.put(key, value),
      delete: (key) => store.delete(key),
      list: (prefix) => store.list(prefix),
      getBytes: (key) => store.getBytes(key),
      putBytes: (key, value) => store.putBytes(key, value),
    };

    const back = await revertTripShard(lying, KEY, { apply: true });
    expect(back.outcome).toBe("not_replaced");
    expect(await store.getBytes(binaryKeyOf(KEY))).not.toBeNull();
  });

  it("says a shard is absent when there are no bytes to put back", async () => {
    const { store } = await published();
    const back = await revertTripShard(store, KEY, { apply: true });
    expect(back.outcome).toBe("absent");
  });

  it("names the text key of a binary one, and the other way round", () => {
    expect(textKeyOf(binaryKeyOf(KEY))).toBe(KEY);
  });

  /* Round trip, which is the property the whole migration rests on. */
  it("survives a conversion and an undo with byte-identical lines", async () => {
    const { store, source } = await published(60);
    const before = await store.get(KEY);
    expect((await convertTripShard(store, KEY, { apply: true })).outcome).toBe("converted");
    expect((await revertTripShard(store, KEY, { apply: true })).outcome).toBe("converted");
    const after = await store.get(KEY);
    expect(after).toBe(before);
    expect(rowsOfShardText(after!)).toEqual(source);
  });
});
