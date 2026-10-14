import { describe, expect, it } from "vitest";
import { numberFromEnv, positiveNumberFromEnv } from "./env-numbers.js";

describe("numbers read from the environment", () => {
  /*
   * The case this exists for. GitHub Actions does not omit an environment variable whose
   * repository variable is unset — it sets it to the empty string — so `?? "12"` keeps `""` and
   * `Number("")` is 0. Five collection and batch numbers became zero that way the moment the
   * schedules started running, and scheduled collection fetched nothing for a day.
   */
  it("treats set-to-nothing exactly like not set", () => {
    expect(numberFromEnv("", 12)).toBe(12);
    expect(numberFromEnv("   ", 12)).toBe(12);
    expect(numberFromEnv(undefined, 12)).toBe(12);
  });

  it("uses a real number when one is given", () => {
    expect(numberFromEnv("24", 12)).toBe(24);
    expect(numberFromEnv(" 24 ", 12)).toBe(24);
    expect(numberFromEnv("0.5", 12)).toBe(0.5);
  });

  /*
   * An explicit zero is a real instruction — `BUDGET_UTILIZATION=0` is a reading, not an accident —
   * so it is honoured rather than treated as absent.
   */
  it("honours an explicit zero", () => {
    expect(numberFromEnv("0", 12)).toBe(0);
    expect(numberFromEnv("-1", 12)).toBe(-1);
  });

  it("falls back rather than passing NaN or Infinity on", () => {
    expect(numberFromEnv("twelve", 12)).toBe(12);
    expect(numberFromEnv("12abc", 12)).toBe(12);
    expect(numberFromEnv("Infinity", 12)).toBe(12);
    expect(numberFromEnv("NaN", 12)).toBe(12);
  });

  describe("where zero would turn the pipeline off", () => {
    it("falls back for an accidental zero as well as a blank", () => {
      expect(positiveNumberFromEnv("", 12)).toBe(12);
      expect(positiveNumberFromEnv("0", 12)).toBe(12);
      expect(positiveNumberFromEnv("-4", 12)).toBe(12);
      expect(positiveNumberFromEnv("nonsense", 12)).toBe(12);
    });

    it("still takes a real override", () => {
      expect(positiveNumberFromEnv("6", 12)).toBe(6);
      expect(positiveNumberFromEnv("100", 12)).toBe(100);
    });
  });
});
