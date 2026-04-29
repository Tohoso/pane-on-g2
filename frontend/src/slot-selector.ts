import type { Slot } from "./types";
import { SLOTS } from "@pane-on-g2/shared/protocol";
import type { AppStatus } from "./slot-state";

export const SLOT_SELECTOR_OPTIONS = [...SLOTS] as const;

export type SlotStatusMap = Record<Slot, AppStatus>;

export function nextSlot(slot: Slot, direction: 1 | -1 = 1): Slot {
  const index = SLOT_SELECTOR_OPTIONS.indexOf(slot as (typeof SLOT_SELECTOR_OPTIONS)[number]);
  const next = (index + direction + SLOT_SELECTOR_OPTIONS.length) % SLOT_SELECTOR_OPTIONS.length;
  return SLOT_SELECTOR_OPTIONS[next];
}

export function formatSlotSelector(activeSlot: Slot, statuses: SlotStatusMap): string {
  return SLOT_SELECTOR_OPTIONS
    .map((slot) => {
      const label = `${slot} ${formatSlotStatus(statuses[slot])}`;
      return slot === activeSlot ? `[${label}]` : label;
    })
    .join(" | ");
}

export function formatSlotStatus(status: AppStatus): string {
  if (status === "busy" || status === "streaming") return "*BUSY*";
  if (status === "stuck") return "STUCK";
  if (status === "error") return "ERR";
  if (status === "reconnecting") return "RECONN";
  return "idle";
}
