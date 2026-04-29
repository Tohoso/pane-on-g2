import type { Slot, PromptRequest, RingReplyGesture } from "./types";

export type RingReplyPreset = {
  text: string;
  action: "prompt" | "interrupt";
};

export const RING_REPLY_PRESETS: Record<RingReplyGesture, RingReplyPreset> = {
  single_tap: { text: "ack", action: "prompt" },
  double_tap: { text: "progress?", action: "prompt" },
  long_press: { text: "interrupt", action: "interrupt" },
  triple_tap: { text: "be terse", action: "prompt" },
};

export type RingReplyDeps = {
  activeSlot: Slot | (() => Slot);
  postPrompt: (request: PromptRequest) => void | Promise<void>;
  interrupt: (slot: Slot) => void | Promise<void>;
  requestId?: () => string;
};

export async function handleRingReply(gesture: RingReplyGesture, deps: RingReplyDeps): Promise<void> {
  const preset = RING_REPLY_PRESETS[gesture];
  if (!preset) return;

  const slot = typeof deps.activeSlot === "function" ? deps.activeSlot() : deps.activeSlot;
  if (preset.action === "interrupt") {
    await deps.interrupt(slot);
    return;
  }

  await deps.postPrompt({
    slot,
    text: preset.text,
    source: "ring_quick_reply",
    requestId: deps.requestId?.() || crypto.randomUUID(),
  });
}
