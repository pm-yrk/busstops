import { afterEach, describe, expect, it } from "vitest";
import {
  HEAVY_READ_GATE_LIMITS,
  acquireHeavyRead,
  heavyReadGateState,
  resetHeavyReadGate,
} from "./heavy-read-gate.js";

/**
 * The gate's whole claim is that a queued request is suspended rather than allocating, and that it
 * never holds a request long enough for the frontend to abandon it. These hold the properties that
 * claim rests on: it lets the normal case straight through, it admits exactly one waiter per
 * release, it gives up rather than queueing forever, and it cannot leak or double-count a slot.
 */
afterEach(() => {
  resetHeavyReadGate();
});

describe("the heavy-read gate", () => {
  it("lets a lone request straight through, so the normal case cannot tell it is there", async () => {
    const slot = await acquireHeavyRead();
    expect(slot.waitedMs).toBe(0);
    expect(slot.bypassed).toBe(false);
    expect(heavyReadGateState().active).toBe(1);
    slot.release();
    expect(heavyReadGateState().active).toBe(0);
  });

  it("runs up to the limit at once and makes the next one wait", async () => {
    const held = [];
    for (let i = 0; i < HEAVY_READ_GATE_LIMITS.MAX_CONCURRENT; i += 1) {
      held.push(await acquireHeavyRead());
    }
    expect(heavyReadGateState().active).toBe(HEAVY_READ_GATE_LIMITS.MAX_CONCURRENT);

    let thirdResolved = false;
    const third = acquireHeavyRead().then((slot) => {
      thirdResolved = true;
      return slot;
    });

    // Give the microtask queue every chance to resolve it early.
    await Promise.resolve();
    await Promise.resolve();
    expect(thirdResolved, "a request past the limit must not be admitted").toBe(false);
    expect(heavyReadGateState().waiting).toBe(1);

    held[0]!.release();
    const slot = await third;
    expect(slot.bypassed).toBe(false);
    // The slot moved across rather than being released and re-taken, so the count never dipped.
    expect(heavyReadGateState().active).toBe(HEAVY_READ_GATE_LIMITS.MAX_CONCURRENT);

    slot.release();
    held[1]!.release();
    expect(heavyReadGateState().active).toBe(0);
  });

  it("admits exactly one waiter per release, not all of them", async () => {
    const held = [];
    for (let i = 0; i < HEAVY_READ_GATE_LIMITS.MAX_CONCURRENT; i += 1) {
      held.push(await acquireHeavyRead());
    }
    const a = acquireHeavyRead();
    const b = acquireHeavyRead();
    await Promise.resolve();
    expect(heavyReadGateState().waiting).toBe(2);

    held[0]!.release();
    await a;
    expect(heavyReadGateState().waiting).toBe(1);

    held[1]!.release();
    await b;
    expect(heavyReadGateState().waiting).toBe(0);
  });

  /*
   * The bypass is the safety valve, and it has to be real: the frontend abandons a request after
   * twenty seconds, so a gate that could hold one indefinitely would turn a risk of 1102 into a
   * certainty of a timeout.
   */
  it("proceeds without a slot rather than queueing past its wait", async () => {
    const held = [];
    for (let i = 0; i < HEAVY_READ_GATE_LIMITS.MAX_CONCURRENT; i += 1) {
      held.push(await acquireHeavyRead());
    }

    const slot = await acquireHeavyRead();
    expect(slot.bypassed).toBe(true);
    expect(slot.waitedMs).toBeGreaterThanOrEqual(HEAVY_READ_GATE_LIMITS.MAX_WAIT_MS - 50);
    expect(heavyReadGateState().bypassed).toBe(1);

    // A bypass held no slot, so releasing it must not hand one out.
    slot.release();
    expect(heavyReadGateState().active).toBe(HEAVY_READ_GATE_LIMITS.MAX_CONCURRENT);

    for (const one of held) one.release();
    expect(heavyReadGateState().active).toBe(0);
  }, 10_000);

  it("is idempotent on release, so a retry cannot invent capacity", async () => {
    const slot = await acquireHeavyRead();
    slot.release();
    slot.release();
    slot.release();
    expect(heavyReadGateState().active).toBe(0);
  });

  /*
   * The awkward interleaving: a waiter times out, and the slot is handed to it anyway a moment
   * later. It must pass the slot on rather than swallowing it, or the gate loses capacity for the
   * life of the isolate.
   */
  it("does not lose a slot handed to a request that already gave up", async () => {
    const held = [];
    for (let i = 0; i < HEAVY_READ_GATE_LIMITS.MAX_CONCURRENT; i += 1) {
      held.push(await acquireHeavyRead());
    }
    const abandoned = await acquireHeavyRead();
    expect(abandoned.bypassed).toBe(true);

    for (const one of held) one.release();
    expect(heavyReadGateState().active).toBe(0);

    // Capacity is intact: the limit can be filled again from scratch.
    const again = [];
    for (let i = 0; i < HEAVY_READ_GATE_LIMITS.MAX_CONCURRENT; i += 1) {
      const s = await acquireHeavyRead();
      expect(s.waitedMs).toBe(0);
      again.push(s);
    }
    for (const one of again) one.release();
  }, 10_000);
});
