import { describe, expect, it } from "vitest";
import {
  TICKET_SELLERS,
  findSeller,
  isAllowedTicketDomain,
  isOnDomain,
  type TicketSeller,
} from "./tickets.js";

const VERIFIED: TicketSeller = {
  domain: "firstbus.co.uk",
  sellerName: "First Bus",
  candidatePaths: ["/tickets"],
  url: "https://www.firstbus.co.uk/tickets",
  pageTitle: "Bus tickets",
  verifiedAt: "2026-10-04T00:00:00.000Z",
  evidence: "a run fetched it",
};

const UNVERIFIED: TicketSeller = { ...VERIFIED, url: null, pageTitle: null, verifiedAt: null };

describe("matching an operator to a ticket seller", () => {
  it("matches the domain the operator publishes about itself", () => {
    expect(findSeller([VERIFIED], "https://www.firstbus.co.uk/leeds")?.sellerName).toBe(
      "First Bus",
    );
    // A subsidiary's own subdomain is still that operator.
    expect(findSeller([VERIFIED], "https://leeds.firstbus.co.uk/")?.sellerName).toBe("First Bus");
  });

  /*
   * The whole point of `isOnDomain`. A plain `endsWith` is also true of a lookalike somebody can
   * register this afternoon, and it would have arrived with a verified seller's name attached.
   */
  it("refuses a lookalike domain that merely ends with a seller's", () => {
    expect(findSeller([VERIFIED], "https://www.notfirstbus.co.uk/")).toBeNull();
    expect(isOnDomain("notfirstbus.co.uk", "firstbus.co.uk")).toBe(false);
    expect(isOnDomain("firstbus.co.uk.evil.test", "firstbus.co.uk")).toBe(false);
    expect(isAllowedTicketDomain("https://www.notfirstbus.co.uk/tickets")).toBe(false);
  });

  it("will not use a seller whose page has not actually been fetched", () => {
    expect(findSeller([UNVERIFIED], "https://www.firstbus.co.uk/leeds")).toBeNull();
  });

  it("refuses plaintext and unparseable addresses", () => {
    expect(findSeller([VERIFIED], "http://www.firstbus.co.uk/")).toBeNull();
    expect(findSeller([VERIFIED], "not a url")).toBeNull();
    expect(findSeller([VERIFIED], undefined)).toBeNull();
  });

  /*
   * The data file is the single source for both the app and the script that checks the pages, so
   * a candidate with no path to try is a dead row and an active row with no evidence is a link
   * nobody read.
   */
  it("keeps the seller list in a state the verifier and the app can both act on", () => {
    expect(TICKET_SELLERS.length).toBeGreaterThan(0);
    for (const seller of TICKET_SELLERS) {
      expect(seller.candidatePaths.length).toBeGreaterThan(0);
      expect(seller.domain).not.toMatch(/^www\./);
      if (seller.url !== null) {
        expect(seller.verifiedAt).not.toBeNull();
        expect(seller.evidence).not.toBeNull();
        expect(isAllowedTicketDomain(seller.url)).toBe(true);
      }
    }
  });
});
