import { describe, expect, it } from "vitest";
import { formatStatusIndicator } from "../src/status-indicator";

describe("formatStatusIndicator", () => {
  it("renders busy spinner with elapsed seconds and token count", () => {
    expect(formatStatusIndicator({ state: "busy", elapsedMs: 5_200, tokenCount: 42 }, 1)).toBe("busy.. 5s 42tok");
  });

  it("renders stuck and idle states compactly", () => {
    expect(formatStatusIndicator({ state: "stuck", elapsedMs: 61_000 })).toBe("stuck 61s");
    expect(formatStatusIndicator({ state: "idle", elapsedMs: 0 })).toBe("idle");
  });
});
