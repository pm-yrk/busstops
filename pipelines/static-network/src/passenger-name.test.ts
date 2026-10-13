import { describe, expect, it } from "vitest";
import { passengerName } from "./gtfs-network.js";

/*
 * The real ones, seen on the deployed live map in "Buses in view".
 *
 * A passenger was being shown `White_Rose_Shopping_Centre` as the place a bus was going to. That
 * is an internal key rendered as a destination, and it is the sort of thing that makes a product
 * look like a database with a stylesheet over it.
 */
describe("a destination a passenger reads", () => {
  it("fixes the ones the deployed map was showing", () => {
    expect(passengerName("White_Rose_Shopping_Centre")).toBe("White Rose Shopping Centre");
    expect(passengerName("Gledhow_Lidgett_Lane")).toBe("Gledhow Lidgett Lane");
    expect(passengerName("Whinmoor_Shopping_Centre")).toBe("Whinmoor Shopping Centre");
    expect(passengerName("Easterly_Road_Hollin_Park_Mount")).toBe(
      "Easterly Road Hollin Park Mount",
    );
  });

  it("leaves a name that was already written for a person completely alone", () => {
    for (const name of [
      "Leeds City Bus Station",
      "King's Cross",
      "Stratford-upon-Avon",
      "Newcastle upon Tyne",
      "Park & Ride",
      "St. Mary's Hospital",
      "Ashton-under-Lyne",
      "Leeds Bradford Airport",
    ]) {
      expect(passengerName(name)).toBe(name);
    }
  });

  it("does not truncate, because a destination is not a badge", () => {
    const long = "Manchester Piccadilly Rail Station Interchange Stand C";
    expect(passengerName(long)).toBe(long);
  });

  it("tidies whitespace a feed left behind", () => {
    expect(passengerName("  Leeds   City  Bus Station ")).toBe("Leeds City Bus Station");
    expect(passengerName("Leeds__City")).toBe("Leeds City");
  });

  it("gives back something rather than nothing when a name is only separators", () => {
    // Not a name, but blanking it would turn a bad row into a row that claims no destination.
    expect(passengerName("___")).toBe("");
  });
});
