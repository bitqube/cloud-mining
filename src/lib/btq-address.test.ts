import { describe, expect, it } from "vitest";
import { isValidBtqAddress } from "./btq-address";

describe("isValidBtqAddress", () => {
  it("accepts real BitQube mainnet addresses", () => {
    expect(isValidBtqAddress("BC2MHYXdTCtNSHhbxoPfra9hi2t2Vng5jY")).toBe(true); // asset-fee address
    expect(isValidBtqAddress("BL1sN615b8xezvCYEJEKhMHN4kfKLgbw8Y")).toBe(true); // house worker on MRR
  });

  it("rejects typos, other coins and junk", () => {
    expect(isValidBtqAddress("BC2MHYXdTCtNSHhbxoPfra9hi2t2Vng5jZ")).toBe(false); // bad checksum
    expect(isValidBtqAddress("RDmP6mD79N9tC7sF1mN14WjEwG6qL9tZ2B")).toBe(false); // Ravencoin
    expect(isValidBtqAddress("1BoatSLRHtKNngkdXEeobR76b53LETtpyT")).toBe(false); // Bitcoin
    expect(isValidBtqAddress("B0OIl")).toBe(false);
    expect(isValidBtqAddress("")).toBe(false);
  });
});
