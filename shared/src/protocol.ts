export type Slot = string;

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ToolSummary = {
  name: string;
  oneliner: string;
};

export type StatusIndicator = {
  state: "idle" | "busy" | "stuck";
  elapsedMs: number;
  tokenCount?: number;
};

export type UserTurnSource = "g2_text" | "g2_voice" | "discord" | "tmux" | "cron";

export type PaneEvent =
  | { type: "heartbeat"; ts: number }
  | { type: "status"; slot: Slot; state: "idle" | "busy" | "stuck" | "error"; message?: string; ts: number }
  | { type: "user_prompt"; slot: Slot; text: string; source: UserTurnSource | "ring_quick_reply"; ts: number }
  | { type: "text_delta"; slot: Slot; text: string; seq: number; turnId: string; ts: number }
  | { type: "pane_snapshot"; slot: Slot; content: string; ts: number; seq: number }
  | { type: "tool_start"; slot: Slot; name: string; summary?: string; toolId?: string; ts: number }
  | { type: "tool_end"; slot: Slot; name: string; ok: boolean; summary?: string; toolId?: string; ts: number }
  | { type: "result"; slot: Slot; turnId: string; ok: boolean; usage?: TokenUsage; ts: number }
  | { type: "error"; slot?: Slot; code: string; message: string; retryable: boolean; ts: number };

export type PromptSource = "g2_text" | "g2_voice" | "ring_quick_reply";

export type SlotSelectMessage = {
  type: "slot_select";
  slot: Slot;
  ts: number;
};

export type RingReplyGesture = "single_tap" | "double_tap" | "long_press" | "triple_tap";

export type RingReplyAction = {
  gesture: RingReplyGesture;
  slot: Slot;
  text: string;
  action: "prompt" | "interrupt";
  source: "ring_quick_reply";
  requestId?: string;
};

export type AudioChunkMessage = {
  type: "audio_chunk";
  slot: Slot;
  audioPcm: Uint8Array;
  seq: number;
  utteranceId: string;
  ts: number;
};

export type InterruptRequest = {
  slot: Slot;
};

export type PromptRequest = {
  slot: Slot;
  text: string;
  source: PromptSource;
  requestId: string;
};

export type PromptResponse =
  | {
      ok: true;
      slot: Slot;
      requestId: string;
      acceptedAt: number;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

export type AudioResponse =
  | {
      ok: true;
      slot: Slot;
      requestId: string;
      transcribed: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

export type InterruptResponse =
  | {
      ok: true;
      slot: Slot;
      interruptedAt: number;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

export const SLOTS = ["cc", "alpha", "beta", "gamma"] as const satisfies readonly Slot[];
export const PHASE1_SLOTS = ["cc"] as const satisfies readonly Slot[];

export function isSlot(value: unknown, slots: readonly Slot[] = SLOTS): value is Slot {
  return typeof value === "string" && slots.includes(value);
}

export function isPhase1Slot(value: unknown): value is (typeof PHASE1_SLOTS)[number] {
  return typeof value === "string" && (PHASE1_SLOTS as readonly string[]).includes(value);
}
