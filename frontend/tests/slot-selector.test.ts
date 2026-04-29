import { describe, expect, it } from "vitest";
import { SLOT_SELECTOR_OPTIONS, formatSlotSelector, nextSlot } from "../src/slot-selector";

describe("slot selector", () => {
  it("exposes the four Phase 2 slots in stable order", () => {
    expect(SLOT_SELECTOR_OPTIONS).toEqual(["cc", "alpha", "beta", "gamma"]);
  });

  it("formats the active slot with brackets and status labels", () => {
    expect(formatSlotSelector("alpha", { cc: "idle", alpha: "busy", beta: "error", gamma: "idle" }))
      .toBe("cc idle | [alpha *BUSY*] | beta ERR | gamma idle");
  });

  it("cycles slots in both directions", () => {
    expect(nextSlot("cc", 1)).toBe("alpha");
    expect(nextSlot("cc", -1)).toBe("gamma");
    expect(nextSlot("gamma", 1)).toBe("cc");
  });
});
