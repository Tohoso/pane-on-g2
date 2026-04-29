export type {
  AudioChunkMessage,
  PaneEvent,
  Slot,
  InterruptRequest,
  InterruptResponse,
  PromptRequest,
  PromptResponse,
  PromptSource,
  RingReplyAction,
  RingReplyGesture,
  SlotSelectMessage,
  StatusIndicator,
  ToolSummary,
  TokenUsage,
  UserTurnSource,
} from "@pane-on-g2/shared/protocol";

export { SLOTS, isSlot } from "@pane-on-g2/shared/protocol";

import type { UserTurnSource as ProtocolUserTurnSource } from "@pane-on-g2/shared/protocol";

export type Turn =
  | { id: string; role: "user"; text: string; source?: ProtocolUserTurnSource; ts: number }
  | { id: string; role: "assistant"; text: string; status: "streaming" | "complete" | "error"; ts: number };
