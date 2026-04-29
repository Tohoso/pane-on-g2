import { describe, expect, it, vi } from "vitest";
import { RING_REPLY_PRESETS, handleRingReply } from "../src/ring-replies";

describe("R1 ring replies", () => {
  it("keeps configurable preset prompts", () => {
    expect(RING_REPLY_PRESETS).toMatchObject({
      single_tap: { text: "ack", action: "prompt" },
      double_tap: { text: "progress?", action: "prompt" },
      long_press: { text: "interrupt", action: "interrupt" },
      triple_tap: { text: "be terse", action: "prompt" },
    });
  });

  it("posts single tap as a ring quick reply prompt", async () => {
    const postPrompt = vi.fn();
    await handleRingReply("single_tap", { activeSlot: "cc", postPrompt, interrupt: vi.fn(), requestId: () => "ring-1" });

    expect(postPrompt).toHaveBeenCalledWith({
      slot: "cc",
      text: "ack",
      source: "ring_quick_reply",
      requestId: "ring-1",
    });
  });

  it("routes long press to interrupt instead of prompt", async () => {
    const postPrompt = vi.fn();
    const interrupt = vi.fn();
    await handleRingReply("long_press", { activeSlot: "beta", postPrompt, interrupt, requestId: () => "ring-2" });

    expect(interrupt).toHaveBeenCalledWith("beta");
    expect(postPrompt).not.toHaveBeenCalled();
  });

  it("ignores unknown gestures", async () => {
    const postPrompt = vi.fn();
    const interrupt = vi.fn();
    await handleRingReply("swipe" as never, { activeSlot: "cc", postPrompt, interrupt });

    expect(postPrompt).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
  });
});
