import type { PaneEvent, Slot, SlotSelectMessage, Turn, UserTurnSource } from "./types";
import { SLOTS, isSlot } from "@pane-on-g2/shared/protocol";

export type AppStatus = "idle" | "busy" | "streaming" | "stuck" | "error" | "reconnecting";

export const MAX_TURNS_PER_SLOT = 200;

export type SlotRuntimeState = {
  slot: Slot;
  status: AppStatus;
  assistantText: string;
  paneSnapshot: string;
  paneSnapshotSeq: number;
  transcript: Turn[];
  g2HistoryOffset: number;
  error?: string;
  lastEventAt?: number;
};

export type SlotSnapshot = SlotRuntimeState;

export type MultiSlotState = {
  activeSlot: Slot;
  slots: Record<Slot, SlotSnapshot>;
};

export type SlotStateInput =
  | PaneEvent
  | SlotSelectMessage
  | { type: "disconnect"; ts: number }
  | { type: "reconnect"; ts: number };

type UserPromptSource = Extract<PaneEvent, { type: "user_prompt" }>["source"];

export function createInitialSlotState(activeSlot: Slot = "cc"): MultiSlotState {
  const slots = Object.fromEntries(
    SLOTS.map((slot) => [
      slot,
      {
        slot,
        status: "idle",
        assistantText: "",
        paneSnapshot: "",
        paneSnapshotSeq: 0,
        transcript: [],
        g2HistoryOffset: 0,
      } satisfies SlotSnapshot,
    ]),
  ) as Record<Slot, SlotSnapshot>;

  return { activeSlot, slots };
}

export function activeSlotSnapshot(state: MultiSlotState): SlotSnapshot {
  return state.slots[state.activeSlot];
}

export function transitionSlotState(state: MultiSlotState, input: SlotStateInput): MultiSlotState {
  if (input.type === "slot_select") {
    if (!isSlot(input.slot)) return state;
    return { ...state, activeSlot: input.slot };
  }

  if (input.type === "disconnect") {
    return updateSlot(state, state.activeSlot, (slot) => ({ ...slot, status: "reconnecting", lastEventAt: input.ts }));
  }

  if (input.type === "reconnect") {
    return updateSlot(state, state.activeSlot, (slot) => ({
      ...slot,
      status: slot.assistantText ? "streaming" : "idle",
      error: undefined,
      lastEventAt: input.ts,
    }));
  }

  if (input.type === "heartbeat") {
    return updateSlot(state, state.activeSlot, (slot) => ({ ...slot, lastEventAt: input.ts }));
  }

  const slot = "slot" in input && isSlot(input.slot) ? input.slot : state.activeSlot;

  switch (input.type) {
    case "status":
      if (input.state === "busy") {
        return updateSlot(state, slot, (current) => ({ ...current, status: "busy", error: undefined, lastEventAt: input.ts }));
      }
      if (input.state === "idle") {
        return updateSlot(state, slot, (current) => ({ ...current, status: "idle", error: undefined, lastEventAt: input.ts }));
      }
      if (input.state === "stuck") {
        return updateSlot(state, slot, (current) => ({
          ...current,
          status: "stuck",
          error: input.message,
          lastEventAt: input.ts,
        }));
      }
      return updateSlot(state, slot, (current) => ({
        ...current,
        status: "error",
        error: input.message || "slot error",
        lastEventAt: input.ts,
      }));
    case "user_prompt":
      return updateSlot(state, slot, (current) => {
        const completedTranscript = completeLatestStreamingAssistant(current.transcript);
        const userTurn: Turn = {
          id: createTurnId(slot, "user", input.ts, completedTranscript.length),
          role: "user",
          text: input.text,
          ...userTurnSource(input.source),
          ts: input.ts,
        };
        const assistantTurn: Turn = {
          id: createTurnId(slot, "assistant", input.ts, completedTranscript.length + 1),
          role: "assistant",
          text: "",
          status: "streaming",
          ts: input.ts,
        };
        return {
          ...current,
          status: "busy",
          assistantText: "",
          transcript: capTranscript([...completedTranscript, userTurn, assistantTurn]),
          error: undefined,
          lastEventAt: input.ts,
        };
      });
    case "text_delta":
      return updateSlot(state, slot, (current) => ({
        ...current,
        status: "streaming",
        assistantText: current.assistantText + input.text,
        transcript: appendAssistantDelta(current.transcript, input.text, input.turnId, slot, input.ts),
        error: undefined,
        lastEventAt: input.ts,
      }));
    case "pane_snapshot":
      return updateSlot(state, slot, (current) => {
        if (input.seq <= current.paneSnapshotSeq) return current;
        return {
          ...current,
          paneSnapshot: input.content,
          paneSnapshotSeq: input.seq,
          lastEventAt: input.ts,
        };
      });
    case "tool_start":
      return updateSlot(state, slot, (current) => ({
        ...current,
        status: current.status === "streaming" ? "streaming" : "busy",
        lastEventAt: input.ts,
      }));
    case "tool_end":
      return updateSlot(state, slot, (current) => ({ ...current, lastEventAt: input.ts }));
    case "result":
      return updateSlot(state, slot, (current) => ({
        ...current,
        status: "idle",
        transcript: completeLatestAssistant(current.transcript),
        lastEventAt: input.ts,
      }));
    case "error":
      return updateSlot(state, slot, (current) => ({
        ...current,
        status: input.retryable ? "reconnecting" : "error",
        error: input.message,
        transcript: markLatestStreamingAssistantError(current.transcript),
        lastEventAt: input.ts,
      }));
  }
}

function updateSlot(
  state: MultiSlotState,
  slot: Slot,
  updater: (slot: SlotSnapshot) => SlotSnapshot,
): MultiSlotState {
  return {
    ...state,
    slots: {
      ...state.slots,
      [slot]: updater(state.slots[slot]),
    },
  };
}

function userTurnSource(source: UserPromptSource): { source?: UserTurnSource } {
  return source === "ring_quick_reply" ? {} : { source };
}

function createTurnId(slot: Slot, role: Turn["role"], ts: number, suffix: string | number): string {
  return `${slot}-${role}-${ts}-${suffix}`;
}

function capTranscript(transcript: Turn[]): Turn[] {
  return transcript.length > MAX_TURNS_PER_SLOT ? transcript.slice(-MAX_TURNS_PER_SLOT) : transcript;
}

function completeLatestStreamingAssistant(transcript: Turn[]): Turn[] {
  const last = transcript.at(-1);
  if (!last || last.role !== "assistant" || last.status !== "streaming") return transcript;
  return [
    ...transcript.slice(0, -1),
    {
      ...last,
      status: "complete",
    },
  ];
}

function completeLatestAssistant(transcript: Turn[]): Turn[] {
  const index = latestAssistantIndex(transcript);
  if (index < 0) return transcript;
  const latest = transcript[index];
  if (latest.role !== "assistant" || latest.status === "complete") return transcript;
  return replaceTurn(transcript, index, { ...latest, status: "complete" });
}

function markLatestStreamingAssistantError(transcript: Turn[]): Turn[] {
  const latest = transcript.at(-1);
  if (!latest || latest.role !== "assistant" || latest.status !== "streaming") return transcript;
  return [...transcript.slice(0, -1), { ...latest, status: "error" }];
}

function appendAssistantDelta(transcript: Turn[], text: string, turnId: string, slot: Slot, ts: number): Turn[] {
  const latest = transcript.at(-1);
  if (!latest || latest.role !== "assistant" || latest.status !== "streaming") {
    return capTranscript([
      ...transcript,
      {
        id: turnId || createTurnId(slot, "assistant", ts, transcript.length),
        role: "assistant",
        text,
        status: "streaming",
        ts,
      },
    ]);
  }
  return replaceTurn(transcript, transcript.length - 1, { ...latest, text: latest.text + text });
}

function latestAssistantIndex(transcript: Turn[]): number {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index].role === "assistant") return index;
  }
  return -1;
}

function replaceTurn(transcript: Turn[], index: number, turn: Turn): Turn[] {
  return [...transcript.slice(0, index), turn, ...transcript.slice(index + 1)];
}
